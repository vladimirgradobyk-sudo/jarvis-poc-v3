// THE COUNCIL ENGINE (AD-COUNCIL, WP-06).
//
// One engine. Agents are configuration — profiles, prompts, rubrics, templates. There is no
// per-agent orchestrator and no `if (skill.id === ...)` anywhere in this file. Six skills
// across three agent families and four artifact kinds run through this one code path.
//
// Phases are DECLARED, not hard-coded (council-engine-spec §3):
//   document         configure → generate → review → compare → adjudicate → publish
//   structured_items configure → generate → review →           adjudicate → publish
//   code_plan        configure → generate → review →           adjudicate → execute → publish
//   report           configure → generate →                                   publish
//
// The engine does not care which. It reads `council.phases` and drives them.

import { createHash } from 'node:crypto';
import { appendEvent, updateRun, getRun } from '../persistence/repos/runs.repo.js';
import * as councilRepo from '../persistence/repos/council.repo.js';
import { assertTransition, quorumDecision, PHASE_STATE, statusLabel } from './state-machine.js';
import { computeAggregates, computeConsensus, verifyReviewCompleteness, qualityScore, scanPlaceholders } from './analysis.js';
import { guardPhase, meter } from './cost.js';
import { audit } from '../persistence/repos/audit.repo.js';

/** Writers run CONCURRENTLY, bounded. One writer's failure must not abort the others. */
const MAX_CONCURRENT_WRITERS = 5;

export class CouncilEngine {
  constructor({ config, registry, emit, sandbox }) {
    this.config = config;
    this.registry = registry;
    this.emit = emit;           // (event) => void — fans out to the SSE stream
    this.sandbox = sandbox;
    this.active = new Map();    // runId → { cancelled }
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────

  skill(id) {
    const s = this.config.skills.find((x) => x.id === id);
    if (!s) throw new Error(`Unknown skill "${id}".`);
    return s;
  }
  template(id) { return this.config.templates.find((t) => t.id === id); }
  rubric(id) { return this.config.rubrics.find((r) => r.id === id); }
  captain(id) { return this.config.captains.find((c) => c.id === id); }
  writerProfile(id) {
    for (const roster of Object.values(this.config.writerRosters)) {
      const p = roster.find((x) => x.id === id);
      if (p) return p;
    }
    throw new Error(`Unknown writer profile "${id}".`);
  }
  prompt(ref) { return this.config.prompts[ref]?.content ?? ''; }

  /**
   * The phases a run drives come from the RUN, not the skill: a single-writer council stores a
   * reduced phase list (no peer review, no compare) at creation time, and the engine honours it.
   */
  phasesOf(run) { return run.phases ?? []; }

  /** Whether this run must pass the G4 scorecard — a per-run choice over the skill default. */
  scorecardRequired(run, skill) {
    return run.scorecardEnabled != null ? !!run.scorecardEnabled : !!skill.requiresScorecard;
  }

  /**
   * The fixture transport's seed.
   *
   * Derived from the SKILL AND THE INPUTS — deliberately not from the run ID. A run ID is
   * time-based, so seeding on it would make the "deterministic" transport produce a different
   * council every time the same request was made: the demo would not be repeatable and the
   * tests would be flaky. Keying on the request means identical inputs always yield an
   * identical council, which is what deterministic has to mean to be worth anything.
   */
  seedFor(run) {
    return createHash('sha256')
      .update(`${run.skillId}|${JSON.stringify(run.inputs ?? {})}`)
      .digest('hex')
      .slice(0, 16);
  }

  /** Persist + emit in one place, so the event log can never diverge from the run row. */
  record(runId, type, payload) {
    const ev = appendEvent(runId, type, payload);
    this.emit(ev);
    return ev;
  }

  transition(run, toState, extra = {}) {
    assertTransition(run.state, toState);
    this.record(run.id, 'run.phase', { from: run.state, to: toState, ...extra });
    // FR-COUNCIL-001: state persists after EVERY transition, so a restart loses no work.
    return updateRun(run.id, { state: toState, ...extra });
  }

  isCancelled(runId) {
    return this.active.get(runId)?.cancelled === true;
  }

  cancel(runId, actor) {
    const entry = this.active.get(runId);
    if (entry) entry.cancelled = true;
    this.record(runId, 'run.cancelled', { actor });
    return true;
  }

  // ── the driver ─────────────────────────────────────────────────────────────────────────

  /**
   * Runs the declared phases up to the first human gate, then returns. The engine never
   * transitions out of `awaiting_human` by itself (FR-COUNCIL-008).
   */
  async start(runId) {
    this.active.set(runId, { cancelled: false });
    let run = getRun(runId);
    const skill = this.skill(run.skillId);

    try {
      if (run.state === 'created' || run.state === 'queued') {
        run = this.transition(run, 'generating', { currentPhase: 'generate' });
      }

      // ── generate ──────────────────────────────────────────────────────────────────────
      const guard = guardPhase({ runId, phase: 'generate', budget: this.config.budget, actor: run.createdBy });
      if (!guard.allowed) return this.halt(run, guard);

      const settled = await this.runGenerate(run, skill);
      if (this.isCancelled(runId)) return this.finishCancelled(run);

      const q = quorumDecision(settled.length, this.phasesOf(run));
      if (!q.proceed) {
        // Degradation is NEVER silent (FR-COUNCIL-009).
        this.record(runId, 'run.degraded', { reason: q.reason, skipped: q.skipped ?? [] });
        run = updateRun(runId, { degraded: true, degradedReason: q.reason });
        if (q.nextState === 'failed') {
          this.record(runId, 'run.failed', { reason: q.reason, degraded: true });
          return updateRun(runId, { state: 'failed', completedAt: new Date().toISOString() });
        }
        return this.transition(getRun(runId), 'awaiting_human', { currentPhase: 'adjudicate' });
      }

      // ── review (N² ) ──────────────────────────────────────────────────────────────────
      if (this.phasesOf(run).includes('review')) {
        const g2 = guardPhase({ runId, phase: 'review', budget: this.config.budget, actor: run.createdBy });
        if (!g2.allowed) return this.halt(getRun(runId), g2);

        run = this.transition(getRun(runId), 'reviewing', { currentPhase: 'review' });
        await this.runReview(run, skill, settled);
        if (this.isCancelled(runId)) return this.finishCancelled(getRun(runId));
      }

      // ── adjudicate ────────────────────────────────────────────────────────────────────
      if (this.phasesOf(run).includes('adjudicate')) {
        const g3 = guardPhase({ runId, phase: 'adjudicate', budget: this.config.budget, actor: run.createdBy });
        if (!g3.allowed) return this.halt(getRun(runId), g3);

        run = this.transition(getRun(runId), 'adjudicating', { currentPhase: 'adjudicate' });
        await this.runAdjudicate(run, skill);
        if (this.isCancelled(runId)) return this.finishCancelled(getRun(runId));
      }

      // Compute the advisory quality score before handing to the human (DEC-27).
      this.scoreQuality(getRun(runId), skill);

      // ── the human gate ────────────────────────────────────────────────────────────────
      //
      // A council run stops at awaiting_human for the G2/G3 cherry-pick decision. A SOLO
      // `report` run has no verdict, no suggestions and therefore no decision to present —
      // parking it on a gate with nothing to decide would be a dead end, so it goes straight
      // to scoring-or-approval. G5 still applies before any write.
      const hasDecision = this.phasesOf(getRun(runId)).includes('adjudicate');
      if (hasDecision) {
        return this.transition(getRun(runId), 'awaiting_human', { currentPhase: 'adjudicate' });
      }
      const next = this.scorecardRequired(getRun(runId), skill) ? 'scoring' : 'approved';
      return this.transition(getRun(runId), next, { currentPhase: 'publish' });
    } catch (err) {
      this.record(runId, 'run.failed', { reason: err.message, degraded: true });
      audit({ category: 'policy', action: 'run.failed', outcome: 'failed', runId,
              reasonCode: 'internal_error', correlationId: runId, actor: run.createdBy });
      return updateRun(runId, { state: 'failed', degraded: true, degradedReason: err.message,
                                completedAt: new Date().toISOString() });
    } finally {
      this.active.delete(runId);
    }
  }

  halt(run, guard) {
    // Budget halt: preserve settled candidates, mark degraded, do not pretend it succeeded.
    this.record(run.id, 'run.degraded', { reason: guard.reason, reasonCode: guard.reasonCode });
    this.record(run.id, 'run.failed', { reason: guard.reason, degraded: true });
    audit({ category: 'policy', action: 'budget.halt', outcome: 'blocked', runId: run.id,
            reasonCode: guard.reasonCode, requirementId: 'FR-COST-002',
            correlationId: run.id, actor: run.createdBy });
    return updateRun(run.id, { state: 'failed', degraded: true, degradedReason: guard.reason,
                               completedAt: new Date().toISOString() });
  }

  finishCancelled(run) {
    // FR-COUNCIL-005: partial candidates remain inspectable and are MARKED incomplete.
    for (const c of councilRepo.listCandidates(run.id)) {
      if (!c.body || c.body.length < 50) councilRepo.markCandidateIncomplete(c.id);
    }
    return updateRun(run.id, { state: 'cancelled', completedAt: new Date().toISOString() });
  }

  // ── phase: generate ────────────────────────────────────────────────────────────────────

  async runGenerate(run, skill) {
    const template = this.template(skill.template);
    const transport = this.registry.transport;
    const policyText = this.prompt('policy/product-policy.v1.md');
    const skillPrompt = this.prompt(skill.promptRef);
    const context = await this.buildContext(run, skill);

    const tasks = run.writerSelection.map((w) => async () => {
      const profile = this.writerProfile(w.profileId);
      const resolved = this.registry.resolve(w.logicalModel);
      const started = Date.now();

      this.record(run.id, 'writer.started', {
        writerId: w.profileId, displayName: profile.displayName,
        logicalModel: w.logicalModel, resolvedModel: resolved.resolvedModel,
        modelDisplayName: resolved.displayName, family: resolved.family,
      });

      try {
        // FR-GEN-001/002: stream a NAMED step log per writer with completion ticks, as the
        // pilot did. Steps come from the transport so the fixture and a real provider report
        // the same shape.
        const steps = transport.plannedSteps({ artifactKind: skill.council.artifactKind, inputs: run.inputs });
        for (const [i, step] of steps.entries()) {
          if (this.isCancelled(run.id)) return null;
          this.record(run.id, 'writer.step', {
            writerId: w.profileId, step, status: 'running',
            elapsedMs: Date.now() - started, doneCount: i,
          });
          await sleep(stepDelay(i, steps.length));
          this.record(run.id, 'writer.step', {
            writerId: w.profileId, step, status: 'done',
            elapsedMs: Date.now() - started, doneCount: i + 1,
          });
        }
        if (this.isCancelled(run.id)) return null;

        const out = await transport.generate({
          template, writerProfile: profile, resolved, inputs: run.inputs, context,
          artifactKind: skill.council.artifactKind,
          seedSalt: this.seedFor(run),
          policyText,
          promptText: { writer: this.prompt(profile.promptRef), skill: skillPrompt },
        });

        // Placeholders are scanned HERE, deterministically, not trusted from the transport —
        // a real provider's self-report of its own gaps is not evidence (FR-GEN-005).
        const placeholders = scanPlaceholders(out.sections);

        const candidate = councilRepo.insertCandidate({
          runId: run.id,
          writerProfileId: w.profileId,
          writerDisplayName: profile.displayName,
          resolvedModel: resolved.resolvedModel,
          modelDisplayName: resolved.displayName,
          modelFamily: resolved.family,
          origin: 'writer',
          body: out.body,
          sections: out.sections,
          wordCount: out.wordCount,
          inputTokens: out.usage.inputTokens,
          outputTokens: out.usage.outputTokens,
          premiumRequests: out.usage.premiumRequests,
          durationMs: Date.now() - started,
          placeholders,
          citations: out.citations,
        });

        meter({ runId: run.id, phase: 'generate', role: 'writer', profileId: w.profileId,
                resolved, usage: out.usage, actor: run.createdBy });

        // FR-GEN-003: word count, resolved model, token counts and duration per candidate.
        this.record(run.id, 'writer.settled', {
          writerId: w.profileId, candidateId: candidate.id,
          words: candidate.wordCount, sections: candidate.sections.length,
          placeholders: placeholders.length, citations: out.citations.length,
          tokens: { inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens },
          premiumRequests: out.usage.premiumRequests,
          elapsedMs: Date.now() - started,
        });
        return candidate;
      } catch (err) {
        // FR-COUNCIL-002: one writer's failure shall not abort the others.
        this.record(run.id, 'writer.failed', {
          writerId: w.profileId, displayName: profile.displayName,
          reason: err.message, retryable: true,
        });
        return null;
      }
    });

    const results = await runBounded(tasks, MAX_CONCURRENT_WRITERS);
    const settled = results.filter(Boolean);

    if (settled.length < run.writerSelection.length) {
      const failed = run.writerSelection.length - settled.length;
      this.record(run.id, 'run.degraded', {
        reason: `${failed} of ${run.writerSelection.length} writers failed.`,
      });
      updateRun(run.id, { degraded: true,
        degradedReason: `${failed} of ${run.writerSelection.length} writers failed.` });
    }
    return settled;
  }

  // ── phase: review (N²) ─────────────────────────────────────────────────────────────────

  async runReview(run, skill, candidates) {
    const rubric = this.rubric(skill.council.rubric);
    const transport = this.registry.transport;
    const policyText = this.prompt('policy/product-policy.v1.md');

    const expected = candidates.length * run.writerSelection.length;
    this.record(run.id, 'review.started', { expected });

    let done = 0;
    for (const evaluator of run.writerSelection) {
      const evProfile = this.writerProfile(evaluator.profileId);
      const evResolved = this.registry.resolve(evaluator.logicalModel);

      for (const candidate of candidates) {
        if (this.isCancelled(run.id)) return;
        // FR-REV-003: self-reviews are FLAGGED in data, not inferred later by comparing IDs.
        const isSelf = candidate.writerProfileId === evaluator.profileId;
        try {
          const out = await transport.review({
            rubric, evaluatorProfile: evProfile, evaluatorResolved: evResolved,
            candidate, isSelf, seedSalt: this.seedFor(run), policyText,
            promptText: { writer: this.prompt(evProfile.promptRef) },
          });
          councilRepo.insertReview({
            runId: run.id,
            evaluatorProfileId: evaluator.profileId,
            evaluatorDisplayName: evProfile.displayName,
            candidateId: candidate.id,
            isSelf,
            overallScore: out.overallScore,
            criterionScores: out.criterionScores,
            strengths: out.strengths,
            concerns: out.concerns,
            feedback: out.feedback,
          });
          meter({ runId: run.id, phase: 'review', role: 'reviewer', profileId: evaluator.profileId,
                  resolved: evResolved, usage: out.usage, actor: run.createdBy });
          done += 1;
          this.record(run.id, 'review.recorded', {
            evaluatorId: evaluator.profileId, evaluatorDisplayName: evProfile.displayName,
            candidateId: candidate.id, isSelf, score: out.overallScore,
            done, expected,
          });
          await sleep(40);
        } catch (err) {
          this.record(run.id, 'review.failed', {
            evaluatorId: evaluator.profileId, candidateId: candidate.id, reason: err.message,
          });
        }
      }
    }

    // FR-REV-001: a missing review FAILS THE PHASE. The aggregate must not be quietly computed
    // from whatever happened to arrive.
    const reviews = councilRepo.listReviews(run.id);
    const completeness = verifyReviewCompleteness(candidates, reviews, run.writerSelection);
    if (!completeness.complete) {
      this.record(run.id, 'run.degraded', {
        reason: `Review incomplete: ${completeness.actual} of ${completeness.expected} reviews recorded.`,
        missing: completeness.missing,
      });
      updateRun(run.id, {
        degraded: true,
        degradedReason: `Review incomplete: ${completeness.actual} of ${completeness.expected} reviews.`,
      });
    }

    const aggregates = computeAggregates(candidates, reviews);
    const consensus = computeConsensus(reviews);
    this.record(run.id, 'review.complete', {
      expected: completeness.expected, actual: completeness.actual,
      // FR-REV-006: contested candidates are marked so the reviewer knows where to look.
      contested: aggregates.filter((a) => a.contested).map((a) => ({
        candidateId: a.candidateId, writerDisplayName: a.writerDisplayName,
        spread: a.scoreSpread, range: a.scoreRange,
      })),
      consensusStrengths: consensus.commonStrengths.length,
      consensusConcerns: consensus.commonConcerns.length,
    });
  }

  // ── phase: adjudicate ──────────────────────────────────────────────────────────────────

  async runAdjudicate(run, skill) {
    const captainProfile = this.captain(skill.council.captain);
    // The Captain model is chosen at Configure in the demo (run.captainModel), falling back to the
    // profile's policy-fixed default.
    const captainResolved = this.registry.resolve(run.captainModel || captainProfile.defaultModel);
    const candidates = councilRepo.listCandidates(run.id).filter((c) => c.origin === 'writer');
    const reviews = councilRepo.listReviews(run.id);
    const aggregates = computeAggregates(candidates, reviews);
    const mode = run.captainMode ?? captainProfile.defaultMode;

    try {
      const out = await this.registry.transport.adjudicate({
        candidates, aggregates, captainProfile, captainResolved, captainMode: mode,
        maxSuggestions: skill.council.synthesis.maxSuggestions,
        rubric: this.rubric(skill.council.rubric),
        seedSalt: this.seedFor(run),
        policyText: this.prompt('policy/product-policy.v1.md'),
        promptText: { captain: this.prompt(captainProfile.promptRef) },
      });

      councilRepo.insertVerdict({
        runId: run.id,
        winnerCandidateId: out.winnerCandidateId,
        captainProfileId: captainProfile.id,
        captainMode: mode,
        resolvedModel: captainResolved.resolvedModel,
        modelDisplayName: captainResolved.displayName,
        rationale: out.rationale,
        fullAnalysis: out.fullAnalysis,
        // The Captain's own rubric score of the draft (single-writer runs only; null otherwise).
        evaluation: out.evaluation ?? null,
        suggestions: out.suggestions,
      });

      meter({ runId: run.id, phase: 'adjudicate', role: 'captain', profileId: captainProfile.id,
              resolved: captainResolved, usage: out.usage, actor: run.createdBy });

      const verdict = councilRepo.getVerdict(run.id);
      this.record(run.id, 'verdict.ready', {
        winnerId: out.winnerCandidateId,
        suggestionIds: verdict.suggestions.map((s) => s.id),
        suggestionCount: verdict.suggestions.length,
        mode,
        captainModelDisplayName: captainResolved.displayName,
      });
    } catch (err) {
      // Captain failure PRESERVES candidates and reviews, and offers three labelled options
      // (council-engine-spec §10). It does not silently pick the top peer average.
      this.record(run.id, 'verdict.failed', { reason: err.message });
      updateRun(run.id, { degraded: true, degradedReason: `The Captain did not return a verdict: ${err.message}` });
    }
  }

  /** DEC-27: advisory AI quality score per candidate and for the final artifact. */
  scoreQuality(run, skill) {
    const template = this.template(skill.template);
    const candidates = councilRepo.listCandidates(run.id);
    const reviews = councilRepo.listReviews(run.id);
    const aggregates = computeAggregates(candidates, reviews);
    const threshold = skill.council.qualityThreshold ?? this.config.qualityThresholdDefaults.default;

    const scores = candidates.map((c) => ({
      candidateId: c.id,
      ...qualityScore({
        candidate: c, template,
        aggregate: aggregates.find((a) => a.candidateId === c.id),
        autoFailRules: this.config.qualityThresholdDefaults.autoFailRules,
      }),
    }));

    const verdict = councilRepo.getVerdict(run.id);
    const primaryId = verdict?.winnerCandidateId ?? candidates[0]?.id;
    const primary = scores.find((s) => s.candidateId === primaryId);
    if (primary) {
      updateRun(run.id, { qualityScore: primary.score });
      this.record(run.id, 'quality.scored', {
        candidateId: primaryId, score: primary.score, threshold,
        belowThreshold: primary.score < threshold,
        autoFailures: primary.autoFailures.map((f) => ({ id: f.id, label: f.label, detail: f.detail, severity: f.severity })),
        allScores: scores.map((s) => ({ candidateId: s.candidateId, score: s.score })),
      });
    }
    return scores;
  }

  // ── after the human decision ───────────────────────────────────────────────────────────

  /**
   * Applies the single G2/G3 decision (FR-HUM-001). The caller has already validated and
   * recorded the HumanDecision with its actor — FR-COUNCIL-008 means this method is never
   * reachable without one.
   */
  async applyDecision(runId, decision) {
    let run = getRun(runId);
    const skill = this.skill(run.skillId);
    const candidates = councilRepo.listCandidates(runId);
    const verdict = councilRepo.getVerdict(runId);
    const base = candidates.find((c) => c.id === decision.baseCandidateId);

    let finalCandidate = base;

    // Synthesis runs only if suggestions were selected AND the skill enables it. A code plan
    // never synthesises: the human picks ONE plan and that exact plan executes.
    if (decision.appliedSuggestionIds.length > 0 && skill.council.synthesis.enabled) {
      run = this.transition(run, 'synthesizing', { currentPhase: 'adjudicate' });
      const captainProfile = this.captain(skill.council.captain);
      const captainResolved = this.registry.resolve(run.captainModel || captainProfile.defaultModel);
      const selected = verdict.suggestions.filter((s) => decision.appliedSuggestionIds.includes(s.id));

      const out = await this.registry.transport.synthesise({
        base, suggestions: selected, candidates, captainResolved,
        template: this.template(skill.template),
        policyText: this.prompt('policy/product-policy.v1.md'),
      });

      const placeholders = scanPlaceholders(out.sections);
      finalCandidate = councilRepo.insertCandidate({
        runId,
        writerProfileId: base.writerProfileId,
        writerDisplayName: `${base.writerDisplayName} + ${selected.length} improvement${selected.length === 1 ? '' : 's'}`,
        resolvedModel: captainResolved.resolvedModel,
        modelDisplayName: captainResolved.displayName,
        modelFamily: captainResolved.family,
        origin: 'synthesis',
        derivedFrom: base.id,
        body: out.body,
        sections: out.sections,
        wordCount: out.wordCount,
        inputTokens: out.usage.inputTokens,
        outputTokens: out.usage.outputTokens,
        premiumRequests: out.usage.premiumRequests,
        placeholders,
        citations: base.citations,
      });

      meter({ runId, phase: 'synthesize', role: 'synthesis', profileId: captainProfile.id,
              resolved: captainResolved, usage: out.usage, actor: run.createdBy });

      // FR-SYN-003: never SILENTLY drop a selected suggestion. Say which and why.
      const notApplied = out.applied.filter((a) => !a.applied);
      this.record(runId, 'synthesis.complete', {
        candidateId: finalCandidate.id, derivedFrom: base.id,
        appliedCount: out.applied.filter((a) => a.applied).length,
        notApplied: notApplied.map((a) => ({ suggestionId: a.suggestionId, reason: a.reason })),
      });
    }

    // ── execute (code plans only, exactly once) ─────────────────────────────────────────
    if (this.phasesOf(run).includes('execute')) {
      // FR-COUNCIL-007: `executing` runs EXACTLY ONCE per run, against exactly one approved
      // plan. A re-run requires a new run ID.
      if (councilRepo.hasExecution(runId)) {
        throw Object.assign(new Error('This run has already executed. A re-run requires a new run.'), { code: 'invalid_state' });
      }
      const g = guardPhase({ runId, phase: 'execute', budget: this.config.budget, actor: run.createdBy });
      if (!g.allowed) return this.halt(getRun(runId), g);

      run = this.transition(getRun(runId), 'executing', { currentPhase: 'execute' });
      await this.runExecute(run, skill, finalCandidate);
      if (this.isCancelled(runId)) return this.finishCancelled(getRun(runId));
    }

    // ── gate G4 or straight to approval ─────────────────────────────────────────────────
    const next = this.scorecardRequired(getRun(runId), skill) ? 'scoring' : 'approved';
    return this.transition(getRun(runId), next, { currentPhase: 'publish' });
  }

  async runExecute(run, skill, planCandidate) {
    const result = await this.sandbox.execute({
      run, skill, planCandidate,
      onFile: (f) => this.record(run.id, 'exec.file', f),
      onStep: (s) => this.record(run.id, 'exec.step', s),
    });

    councilRepo.insertExecution({
      runId: run.id,
      planCandidateId: planCandidate.id,
      ...result,
    });

    // NFR-SEC-007 / FR-EXE-004: generated code is scanned for secrets BEFORE a PR is proposed;
    // a positive finding BLOCKS. This is not advisory.
    if (result.secretFindings.length > 0) {
      this.record(run.id, 'exec.blocked', {
        reason: 'secret_scan_findings',
        findings: result.secretFindings,
      });
      audit({ category: 'policy', action: 'secret.scan', outcome: 'blocked', runId: run.id,
              reasonCode: 'secret_scan_findings', requirementId: 'NFR-SEC-007',
              correlationId: run.id, actor: run.createdBy });
    }

    this.record(run.id, 'exec.complete', {
      filesChanged: result.fileChanges.length,
      linesAdded: result.fileChanges.reduce((a, f) => a + f.linesAdded, 0),
      linesRemoved: result.fileChanges.reduce((a, f) => a + f.linesRemoved, 0),
      // FR-EXE-003: report test counters ACCURATELY OR NOT AT ALL. The pilot showed
      // "Tests: 0/0, Coverage: 0%" beside a PR that demonstrably contained tests.
      testsMeasured: result.testsMeasured,
      tests: result.testsMeasured ? `${result.testsPassed}/${result.testsTotal}` : 'not measured',
      coverage: result.testsMeasured ? `${result.coveragePct}%` : 'not measured',
      secretFindings: result.secretFindings.length,
      blocked: result.secretFindings.length > 0,
    });
  }

  /**
   * FR-HUM-005: re-adjudicate under a different Captain mode WITHOUT re-running the writers.
   * This is why `adjudicate` is a separate phase rather than part of generate.
   */
  async readjudicate(runId, captainMode, actor) {
    const run = getRun(runId);
    const skill = this.skill(run.skillId);
    councilRepo.deleteVerdict(runId);
    updateRun(runId, { captainMode });
    this.record(runId, 'readjudicate.requested', { actor, captainMode });
    const r2 = this.transition(getRun(runId), 'adjudicating', { currentPhase: 'adjudicate' });
    await this.runAdjudicate(r2, skill);
    this.scoreQuality(getRun(runId), skill);
    return this.transition(getRun(runId), 'awaiting_human', { currentPhase: 'adjudicate' });
  }

  /** Retrieved context. The PoC has no knowledge base, so this reports honestly (A-09). */
  async buildContext(run, skill) {
    const parts = [];
    let chars = 0;
    for (const [k, v] of Object.entries(run.inputs ?? {})) {
      if (typeof v === 'string' && v.length > 0) { parts.push({ field: k, chars: v.length }); chars += v.length; }
    }
    // Prior artifacts referenced by artifact_ref inputs are read from this run's predecessors.
    const refFields = (skill.inputs ?? []).filter((f) => f.type === 'artifact_ref').map((f) => f.id);
    const sources = [];
    let files = [];
    for (const f of refFields) {
      const ref = run.inputs[f];
      if (!ref) continue;
      const prior = councilRepo.getCandidate(ref);
      if (!prior) continue;
      sources.push({ kind: 'artifact', candidateId: prior.id, label: prior.writerDisplayName, chars: prior.body.length });
      chars += prior.body.length;

      // A referenced code plan carries an execution with a real diff. A review skill must see
      // the changed files, or its findings cannot be anchored to a location — and an
      // unanchored finding is not actionable.
      const priorExecution = councilRepo.getExecution(prior.runId);
      if (priorExecution?.files?.length) {
        files = priorExecution.files.map((x) => ({ path: x.path, op: x.op,
                                                   linesAdded: x.linesAdded, linesRemoved: x.linesRemoved }));
        chars += priorExecution.files.reduce((a, x) => a + (x.afterBody?.length ?? 0), 0);
      }
    }
    return {
      parts, sources, chars, files,
      // Honest about what is NOT available, rather than implying domain grounding we lack.
      knowledgeBases: [],
      degradedSources: [{
        source: 'Domain knowledge bases',
        reason: 'Not licensed for the PoC (spec assumption A-09). Output is generic-model quality.',
      }],
    };
  }
}

// ── small utilities ────────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Step pacing so the Generate screen is visibly live rather than instantaneous. */
function stepDelay(i, total) {
  if (process.env.JARVIS_FAST_STEPS === '1') return 0;
  return i === total - 1 ? 260 : 120 + Math.round(Math.random() * 110);
}

/** Bounded concurrency. One task's rejection never prevents the others from settling. */
async function runBounded(tasks, limit) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const i = cursor++;
      try { results[i] = await tasks[i](); } catch { results[i] = null; }
    }
  });
  await Promise.all(workers);
  return results;
}
