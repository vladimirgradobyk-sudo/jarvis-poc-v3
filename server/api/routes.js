// Route handlers. Validation happens BEFORE any side effect (FR-API-001) and no policy
// decision is ever accepted from the client (FR-API-002).

import { fail, created, accepted, multiStatus } from '../app.js';
import { buildCatalogue, summariseSkill, writeBadgeFor } from '../config/loader.js';
import * as runsRepo from '../persistence/repos/runs.repo.js';
import * as councilRepo from '../persistence/repos/council.repo.js';
import * as scoringRepo from '../persistence/repos/scoring.repo.js';
import * as publishRepo from '../persistence/repos/publish.repo.js';
import * as costRepo from '../persistence/repos/cost.repo.js';
import { audit, listAudit } from '../persistence/repos/audit.repo.js';
import { checkDistinctFamilies, ModelError } from '../providers/registry.js';
import { estimateRun, contextWarnings, variance, sizeBandFor } from '../council/cost.js';
import { computeAggregates, computeConsensus, qualityScore, scanPlaceholders as scanPlaceholdersOf } from '../council/analysis.js';
import { statusLabel, statusKind, canCancel } from '../council/state-machine.js';
import { adapterFor, systemLabel, sorIndex, sorConfluencePage, sorJiraIssue, sorPullRequest, sorTouchPage } from '../integrations/index.js';
import { redactDeep, detectInjection } from '../security/redact.js';

export function registerRoutes(app, deps) {
  const { config, registry, engine, sandbox, env } = deps;
  const catalogue = buildCatalogue(config);
  const actor = env.actor;

  const skillById = (id) => {
    const s = config.skills.find((x) => x.id === id);
    if (!s) fail('not_found', `Unknown skill "${id}".`);
    return s;
  };
  const templateOf = (skill) => config.templates.find((t) => t.id === skill.template);
  const writerProfile = (id) => {
    for (const r of Object.values(config.writerRosters)) {
      const p = r.find((x) => x.id === id);
      if (p) return p;
    }
    fail('validation_failed', `Unknown writer profile "${id}".`);
  };

  // ── Bootstrap / catalogue ──────────────────────────────────────────────────────────────

  app.get('/api/v1/bootstrap', () => ({
    catalogue,
    csrfToken: app.csrfToken,
    actor,
    transport: registry.transportName,
    transportDescription: registry.transport.describe(),
    budget: config.budget,
    models: registry.table(),
    modelPicker: registry.pickerOptions(),
    captainPicker: registry.captainPickerOptions(),
    captainModes: config.captainModes,
    sandboxAvailable: sandbox.available(),
    recentRuns: runsRepo.listRuns({ limit: 8 }).map(runSummary),
    budgetState: budgetState(),
  }));

  app.get('/api/v1/catalogue', () => catalogue);

  app.get('/api/v1/catalogue/skills/:skillId', ({ params }) => {
    const skill = skillById(params.skillId);
    const roster = skill.council.writers.roster.map((id) => {
      const p = writerProfile(id);
      let resolved = null;
      let unavailable = null;
      try { resolved = registry.resolve(p.defaultModel); }
      catch (e) { unavailable = e.message; }
      return {
        ...p,
        defaultModelDisplayName: resolved?.displayName ?? null,
        defaultModelFamily: resolved?.family ?? null,
        unavailable,
      };
    });
    const captain = skill.council.captain ? config.captains.find((c) => c.id === skill.council.captain) : null;
    let captainResolved = null;
    if (captain) { try { captainResolved = registry.resolve(captain.defaultModel); } catch { /* reported in health */ } }

    return {
      ...summariseSkill(skill, config),
      inputs: skill.inputs,
      contextMethods: skill.contextMethods ?? [],
      mode: skill.mode ?? null,
      council: {
        ...skill.council,
        roster,
        captain: captain ? {
          ...captain,
          // AM-10: the Captain model is shown READ-ONLY and is never accepted from the client.
          modelDisplayName: captainResolved?.displayName ?? null,
          modelFixedByPolicy: true,
        } : null,
        rubricDetail: config.rubrics.find((r) => r.id === skill.council.rubric),
      },
      template: {
        id: templateOf(skill).id,
        version: templateOf(skill).version,
        title: templateOf(skill).title,
        sections: templateOf(skill).sections.map((s) => ({
          id: s.id, heading: s.heading, scorable: s.scorable, manualEffortHint: s.manualEffortHint,
        })),
      },
      writeBadge: writeBadgeFor(skill.publishTargets),
    };
  });

  app.get('/api/v1/catalogue/search', ({ query }) => {
    const q = (query.get('q') ?? '').trim().toLowerCase();
    if (!q) return { results: catalogue.skills };
    const results = catalogue.skills.filter((s) =>
      [s.name, s.description, s.agentRole, s.agentAlias, s.outputType, ...(s.synonyms ?? [])]
        .filter(Boolean).some((f) => String(f).toLowerCase().includes(q))
    );
    return { results, query: q };
  });

  /** Prior artifacts a skill's artifact_ref input can accept. */
  app.get('/api/v1/artifacts', ({ query }) => {
    const kinds = (query.get('kinds') ?? '').split(',').filter(Boolean);
    // An artifact_ref input can narrow by the SKILL that produced the artifact, not just its
    // kind — PRD, HLD and LLD are all `document`, so "the HLD for this epic" needs the skill.
    const skills = (query.get('skills') ?? '').split(',').filter(Boolean);
    const out = [];
    for (const run of runsRepo.listRuns({ limit: 80 })) {
      if (!['published', 'approved', 'scoring'].includes(run.state)) continue;
      if (kinds.length && !kinds.includes(run.artifactKind)) continue;
      if (skills.length && !skills.includes(run.skillId)) continue;
      const cands = councilRepo.listCandidates(run.id);
      const chosen = cands.find((c) => c.origin === 'synthesis') ?? cands[0];
      if (!chosen) continue;
      out.push({
        candidateId: chosen.id, runId: run.id, runTitle: run.title,
        skillId: run.skillId, artifactKind: run.artifactKind, epicRef: run.epicRef,
        words: chosen.wordCount, state: run.state, createdAt: run.createdAt,
      });
    }
    return { artifacts: out };
  });

  // ── Gate G1: estimate ──────────────────────────────────────────────────────────────────

  app.post('/api/v1/runs/estimate', ({ body }) => {
    const { skill, selection, captainResolved, template } = resolveSelection(body);
    // A single-writer council has no peer review or compare phase: the Captain reviews the one
    // draft. The phase list is therefore a function of writer count, resolved here and on create.
    const phases = effectivePhases(skill, selection.length);
    const distinct = skill.council.writers.requireDistinctModels && selection.length > 1
      ? checkDistinctFamilies(selection) : { ok: true };
    const consumed = costRepo.dailyConsumption(actor);
    const { estimate, allowed, block, warnings } = estimateRun({
      phases, writerSelection: selection, captainResolved,
      template, inputs: body.inputs ?? {}, budget: config.budget, consumedToday: consumed,
    });
    return {
      estimate,
      allowed: allowed && distinct.ok,
      block: block ?? (distinct.ok ? null : { code: distinct.code, message: distinct.message, detail: distinct.detail }),
      warnings: [...warnings, ...contextWarnings(selection, estimate), ...deprecationWarnings(selection)],
      selection: selection.map(publicWriter),
      captain: captainResolved ? { modelDisplayName: captainResolved.displayName, fixedByPolicy: true } : null,
    };
  });

  function resolveSelection(body) {
    const skill = skillById(body?.skillId);
    const w = skill.council.writers;
    const requested = Array.isArray(body.writerSelection) && body.writerSelection.length
      ? body.writerSelection
      : w.roster.slice(0, w.default).map((id) => ({ writerProfileId: id, logicalModel: writerProfile(id).defaultModel }));

    if (requested.length < w.min || requested.length > w.max) {
      fail('writer_count_out_of_range',
        `This skill accepts between ${w.min} and ${w.max} writers; ${requested.length} were selected.`,
        { requirementId: 'FR-COUNCIL-004' });
    }

    const selection = requested.map((r) => {
      const profile = writerProfile(r.writerProfileId);
      if (!w.roster.includes(r.writerProfileId)) {
        fail('validation_failed', `Writer "${r.writerProfileId}" is not in this skill's roster.`);
      }
      let resolved;
      try { resolved = registry.resolve(r.logicalModel ?? profile.defaultModel); }
      catch (e) {
        if (e instanceof ModelError) fail(e.code, e.message, { detail: e.detail, requirementId: 'FR-MODEL-004' });
        throw e;
      }
      return {
        profileId: profile.id,
        displayName: profile.displayName,
        focusChip: profile.focusChip,
        logicalModel: resolved.logicalModel,
        resolvedModel: resolved.resolvedModel,
        modelDisplayName: resolved.displayName,
        family: resolved.family,
        multiplier: resolved.multiplier,
        contextWindow: resolved.contextWindow,
        deprecated: resolved.deprecated,
        replacedBy: resolved.replacedBy,
      };
    });

    let captainResolved = null;
    if (skill.council.captain) {
      const captain = config.captains.find((c) => c.id === skill.council.captain);
      // AM-10: the Captain model is NOT accepted from the client, even if supplied.
      captainResolved = registry.resolve(captain.defaultModel);
    }
    return { skill, selection, captainResolved, template: templateOf(skill) };
  }

  function deprecationWarnings(selection) {
    return selection.filter((w) => w.deprecated).map((w) => ({
      code: 'model_deprecated',
      message: `${w.modelDisplayName} is deprecated and will be removed.` +
        (w.replacedBy ? ` Consider ${registry.table().find((e) => e.id === w.replacedBy)?.displayName}.` : ''),
    }));
  }

  /**
   * The phases a run actually drives, derived from the writer count. A single-writer council has
   * nothing to peer-review and nothing to compare, so those phases are dropped and the Captain
   * reviews the one draft directly. A multi-writer council keeps the full declared sequence. The
   * phase list is config (council-engine-spec §3), so this needs no engine change — the engine
   * drives `run.phases`.
   */
  function effectivePhases(skill, selectionLength) {
    const phases = skill.council.phases;
    if (selectionLength <= 1) return phases.filter((p) => p !== 'review' && p !== 'compare');
    return phases;
  }

  /** Whether this run must pass the G4 section scorecard: a per-run choice over the skill default. */
  function scorecardRequired(run, skill) {
    return run.scorecardEnabled != null ? !!run.scorecardEnabled : !!skill.requiresScorecard;
  }

  // ── Create and drive a run ─────────────────────────────────────────────────────────────

  app.post('/api/v1/runs', async ({ body, correlationId }) => {
    const { skill, selection, captainResolved, template } = resolveSelection(body);

    // Required inputs, validated before anything is created.
    const fieldErrors = [];
    for (const f of skill.inputs) {
      const v = body.inputs?.[f.id];
      if (f.required && (v === undefined || v === null || String(v).trim() === '')) {
        fieldErrors.push({ path: `inputs.${f.id}`, code: 'required',
          message: `${f.label} is required — the council has no source material without it.` });
      }
      if (v && f.type === 'jira_key' && !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(String(v).trim()) &&
          !/^https?:\/\/.+\/browse\/[A-Za-z][A-Za-z0-9]*-\d+/.test(String(v).trim())) {
        fieldErrors.push({ path: `inputs.${f.id}`, code: 'malformed',
          message: `That does not look like a Jira issue key. Expected something like MCSE-731.` });
      }
    }
    if (fieldErrors.length) {
      fail('validation_failed', `${fieldErrors.length} field${fieldErrors.length === 1 ? ' is' : 's are'} invalid.`,
        { detail: { fields: fieldErrors } });
    }

    if (skill.requiresSandbox && !sandbox.available()) {
      fail('sandbox_unavailable',
        'The execution sandbox is not available. Code skills are disabled.', { requirementId: 'AD-SANDBOX' });
    }

    if (skill.council.writers.requireDistinctModels && selection.length > 1) {
      const d = checkDistinctFamilies(selection);
      if (!d.ok) fail(d.code, d.message, { detail: d.detail, requirementId: 'FR-COUNCIL-004' });
    }

    // Untrusted input: redact at the boundary, and flag injection attempts rather than
    // silently passing them to a model (non-negotiable 4 and 5).
    const { value: safeInputs, findings } = redactDeep(body.inputs ?? {});
    const injection = Object.values(safeInputs).filter((v) => typeof v === 'string').flatMap(detectInjection);
    if (injection.length) {
      audit({ category: 'refusal', action: 'input.injection', outcome: 'blocked',
              reasonCode: 'injection_flagged', requirementId: 'AIR-PROMPT-002', correlationId, actor });
      fail('injection_flagged',
        `Supplied input contains ${injection.length} instruction-like pattern${injection.length === 1 ? '' : 's'} ` +
        `(e.g. "${injection[0].excerpt}"). Input is data, never instructions — remove it and resubmit.`,
        { requirementId: 'AIR-PROMPT-002', detail: { patterns: injection.map((i) => i.excerpt) } });
    }
    if (findings.length) {
      audit({ category: 'policy', action: 'input.redacted', outcome: 'allowed',
              reasonCode: 'secrets_redacted', requirementId: 'NFR-SEC-001', correlationId, actor });
    }

    const phases = effectivePhases(skill, selection.length);
    const consumed = costRepo.dailyConsumption(actor);
    const { estimate, allowed, block } = estimateRun({
      phases, writerSelection: selection, captainResolved,
      template, inputs: safeInputs, budget: config.budget, consumedToday: consumed,
    });
    // FR-COST-002 / FR-API-002: the budget decision is made HERE, server-side. A client cannot
    // waive it by omitting a flag. For the two-step flow (`start: false`) the models are not yet
    // chosen, so the budget gate runs at Generate instead (POST …/generate) — not here.
    if (!allowed && body.start !== false) {
      audit({ category: 'policy', action: 'run.create', outcome: 'blocked',
              reasonCode: 'budget_exceeded', requirementId: 'FR-COST-002', correlationId, actor });
      fail('budget_exceeded', block.message, { requirementId: block.requirementId, detail: block.detail });
    }

    const stageId = body.stageId && skill.stages.includes(body.stageId) ? body.stageId : skill.stages[0];
    // A solo council has no peer evaluation, so its Captain default is evidence_only — it reviews
    // the draft and the input, not peer scores it was never shown (council-engine-spec §4.2).
    const soloMode = selection.length <= 1 && config.captainModes.some((m) => m.id === 'evidence_only')
      ? 'evidence_only' : null;
    const captainMode = skill.council.captain
      ? (config.captainModes.some((m) => m.id === body.captainMode)
          ? body.captainMode
          : soloMode ?? config.captains.find((c) => c.id === skill.council.captain).defaultMode)
      : null;

    // Optional G4 scorecard: a per-run choice. Omitted → fall back to the skill default.
    const scorecardEnabled = typeof body.scorecardEnabled === 'boolean' ? body.scorecardEnabled : null;

    const run = runsRepo.createRun({
      title: runsRepo.generateRunTitle(skill.name, safeInputs),   // FR-NAV-007, server-side
      skillId: skill.id,
      agentId: skill.agent,
      stageId,
      artifactKind: skill.council.artifactKind,
      epicRef: extractEpic(safeInputs),
      state: 'created',
      currentPhase: 'configure',
      phases,
      captainMode,
      scorecardEnabled,
      configHash: config.configHash,
      transport: registry.transportName,
      inputs: safeInputs,
      writerSelection: selection.map(publicWriter),
      estimate,
      createdBy: actor,
    });

    runsRepo.appendEvent(run.id, 'run.created', {
      skillId: skill.id, skillName: skill.name, title: run.title,
      artifactKind: run.artifactKind, phases: run.phases,
      writers: selection.map(publicWriter), captainMode,
      estimate: { premiumRequests: estimate.premiumRequests, totalTokens: estimate.estimatedTotalTokens },
    });
    audit({ category: 'propose', action: 'run.create', outcome: 'allowed', runId: run.id, correlationId, actor });

    // Two-step flow: with `start: false` the run is created in `created` state and waits at the
    // Configure gate, where the user picks models and presses Generate (POST …/generate). Omitted
    // (API clients, tests), the run starts immediately — SERVER-OWNED, continuing whether or not a
    // client stays attached (FR-API-026, FR-ARCH-SYS-017).
    if (body.start !== false) {
      engine.start(run.id).catch((err) => console.error(`[run ${run.id}]`, err.message));
    }

    return created({ run: runSummary(run), estimate });
  });

  // ── Gate G1b: Configure → Generate (two-step flow) ──────────────────────────────────────
  // A run created with `start: false` waits here. The user has picked the writer model and the
  // Captain model on the Configure tab; this applies them, runs the budget gate, and starts.
  app.post('/api/v1/runs/:runId/generate', async ({ params, body, correlationId }) => {
    const run = runsRepo.getRun(params.runId);
    if (!run) fail('not_found', 'No such run.');
    if (run.state !== 'created') {
      fail('invalid_state', `This run has already started (state: ${run.state}). A run generates once.`,
           { requirementId: 'FR-COUNCIL-007' });
    }
    const skill = skillById(run.skillId);

    const { selection } = resolveSelection({
      skillId: run.skillId,
      writerSelection: Array.isArray(body.writerSelection) && body.writerSelection.length
        ? body.writerSelection
        : run.writerSelection.map((w) => ({ writerProfileId: w.profileId, logicalModel: w.logicalModel })),
    });

    if (skill.council.writers.requireDistinctModels && selection.length > 1) {
      const d = checkDistinctFamilies(selection);
      if (!d.ok) fail(d.code, d.message, { detail: d.detail, requirementId: 'FR-COUNCIL-004' });
    }

    // Captain model — selectable in the demo (deviation from DEC-15 / AM-10). null → policy default.
    let captainModel = null;
    let captainResolved = null;
    if (skill.council.captain) {
      const def = config.captains.find((c) => c.id === skill.council.captain).defaultModel;
      const chosen = body.captainModel || def;
      try { captainResolved = registry.resolve(chosen); }
      catch (e) { if (e instanceof ModelError) fail(e.code, e.message, { detail: e.detail }); throw e; }
      captainModel = body.captainModel && body.captainModel !== def ? body.captainModel : null;
    }

    const phases = effectivePhases(skill, selection.length);
    const consumed = costRepo.dailyConsumption(actor);
    const { estimate, allowed, block } = estimateRun({
      phases, writerSelection: selection, captainResolved,
      template: templateOf(skill), inputs: run.inputs, budget: config.budget, consumedToday: consumed,
    });
    if (!allowed) {
      audit({ category: 'policy', action: 'run.generate', outcome: 'blocked',
              reasonCode: 'budget_exceeded', requirementId: 'FR-COST-002', correlationId, actor });
      fail('budget_exceeded', block.message, { requirementId: block.requirementId, detail: block.detail });
    }

    runsRepo.updateRun(run.id, {
      writerSelection: selection.map(publicWriter), captainModel, phases, estimate,
    });
    runsRepo.appendEvent(run.id, 'run.generate', {
      writers: selection.map(publicWriter), captainModel,
      estimate: { premiumRequests: estimate.premiumRequests, totalTokens: estimate.estimatedTotalTokens },
    });
    audit({ category: 'propose', action: 'run.generate', outcome: 'allowed', runId: run.id, correlationId, actor });

    engine.start(run.id).catch((err) => console.error(`[run ${run.id}]`, err.message));
    return accepted({ run: runSummary(runsRepo.getRun(run.id)), estimate });
  });

  app.get('/api/v1/runs', ({ query }) => ({
    runs: runsRepo.listRuns({
      limit: Number.parseInt(query.get('limit') ?? '50', 10),
      state: query.get('state'), epicRef: query.get('epicRef'), skillId: query.get('skillId'),
    }).map(runSummary),
  }));

  /** The full run projection the client renders (api-contract §6). */
  app.get('/api/v1/runs/:runId', ({ params }) => {
    const run = runsRepo.getRun(params.runId);
    if (!run) fail('not_found', `Run "${params.runId}" does not exist.`);
    const skill = skillById(run.skillId);
    const template = templateOf(skill);
    const candidates = councilRepo.listCandidates(run.id);
    const writerCandidates = candidates.filter((c) => c.origin === 'writer');
    const reviews = councilRepo.listReviews(run.id);
    const aggregates = computeAggregates(writerCandidates, reviews);
    const verdict = councilRepo.getVerdict(run.id);
    const execution = councilRepo.getExecution(run.id);
    const scorecard = scoringRepo.getScorecardForRun(run.id);
    const proposal = publishRepo.getProposalForRun(run.id);
    const cost = costRepo.runCost(run.id);
    const threshold = skill.council.qualityThreshold ?? config.qualityThresholdDefaults.default;

    const quality = candidates.map((c) => ({
      candidateId: c.id,
      ...qualityScore({ candidate: c, template,
                        aggregate: aggregates.find((a) => a.candidateId === c.id),
                        autoFailRules: config.qualityThresholdDefaults.autoFailRules }),
    }));

    return {
      run: { ...runSummary(run), inputs: run.inputs },
      skill: summariseSkill(skill, config),
      uiLabels: skill.uiLabels ?? {},
      template: { id: template.id, version: template.version, title: template.title,
                  sections: template.sections.map((s) => ({ id: s.id, heading: s.heading, scorable: s.scorable })) },
      candidates: candidates.map(publicCandidate),
      aggregates,
      reviews,
      consensus: computeConsensus(reviews),
      reviewProgress: { expected: writerCandidates.length * run.writerSelection.length, actual: reviews.length },
      verdict,
      execution,
      scorecard,
      proposal,
      quality,
      qualityThreshold: threshold,
      cost: {
        ...cost,
        estimate: run.estimate,
        variancePercent: variance(run.estimate, cost.total.premiumRequests),
        sizeBand: sizeBandFor(cost.total.premiumRequests, config.budget.sizeBands),
        price: config.budget.premiumRequestPrice,
      },
      decisions: councilRepo.listHumanDecisions(run.id),
      events: runsRepo.listEvents(run.id),
      provenance: publishRepo.getProvenanceForRun(run.id),
      budgetState: budgetState(),
    };
  });

  app.get('/api/v1/runs/:runId/events', ({ params, query }) => ({
    events: runsRepo.listEvents(params.runId, Number.parseInt(query.get('sinceSeq') ?? '0', 10)),
  }));

  app.post('/api/v1/runs/:runId/cancel', ({ params, body, correlationId }) => {
    const run = runsRepo.getRun(params.runId);
    if (!run) fail('not_found', 'Run does not exist.');
    if (!canCancel(run.state)) fail('invalid_state', `A ${run.state} run cannot be cancelled.`);
    engine.cancel(run.id, actor);
    audit({ category: 'policy', action: 'run.cancel', outcome: 'allowed', runId: run.id, correlationId, actor });
    return accepted({ run: runSummary(runsRepo.getRun(run.id)) });
  });

  // ── Gates G2 / G3: the single human decision ───────────────────────────────────────────

  app.post('/api/v1/runs/:runId/decision', async ({ params, body, correlationId }) => {
    const run = runsRepo.getRun(params.runId);
    if (!run) fail('not_found', 'Run does not exist.');
    if (run.state !== 'awaiting_human') {
      fail('invalid_state', `This run is ${run.state}, not awaiting a decision.`, { requirementId: 'FR-COUNCIL-008' });
    }

    const skill = skillById(run.skillId);
    const candidates = councilRepo.listCandidates(run.id);
    const verdict = councilRepo.getVerdict(run.id);
    const action = body?.action ?? 'accept';

    if (action === 'readjudicate') {
      const mode = body.captainMode;
      if (!config.captainModes.some((m) => m.id === mode)) {
        fail('validation_failed', `"${mode}" is not a valid captain mode.`);
      }
      councilRepo.insertHumanDecision({ runId: run.id, gate: 'G3', action, appliedSuggestionIds: [],
                                        note: body.note, actor });
      engine.readjudicate(run.id, mode, actor).catch((e) => console.error(e.message));
      return accepted({ run: runSummary(runsRepo.getRun(run.id)), readjudicating: true });
    }

    if (action === 'reject' || action === 'cancel') {
      councilRepo.insertHumanDecision({ runId: run.id, gate: 'G3', action, appliedSuggestionIds: [],
                                        note: body.note, actor });
      runsRepo.appendEvent(run.id, 'human.decision', { actor, action, baseId: null, appliedSuggestions: [] });
      const updated = runsRepo.updateRun(run.id, { state: 'cancelled', completedAt: new Date().toISOString() });
      return accepted({ run: runSummary(updated) });
    }

    // accept
    const baseId = body.baseCandidateId ?? verdict?.winnerCandidateId ?? candidates[0]?.id;
    const base = candidates.find((c) => c.id === baseId);
    if (!base) fail('validation_failed', 'baseCandidateId is not a candidate of this run.');

    const requested = Array.isArray(body.appliedSuggestionIds) ? body.appliedSuggestionIds : [];
    const valid = new Set((verdict?.suggestions ?? []).map((s) => s.id));
    for (const id of requested) {
      if (!valid.has(id)) fail('validation_failed', `Suggestion "${id}" is not part of this run's verdict.`);
    }

    // FR-COUNCIL-008: the decision — with its actor and timestamp — is recorded BEFORE the
    // engine is allowed to leave awaiting_human.
    const decisionId = councilRepo.insertHumanDecision({
      runId: run.id, gate: skill.council.artifactKind === 'code_plan' ? 'G2' : 'G3',
      action: 'accept', baseCandidateId: baseId, appliedSuggestionIds: requested, note: body.note, actor,
    });
    runsRepo.appendEvent(run.id, 'human.decision', {
      actor, action: 'accept', baseId, appliedSuggestions: requested,
      gate: skill.council.artifactKind === 'code_plan' ? 'G2' : 'G3',
    });
    audit({ category: 'approve', action: `gate.${skill.council.artifactKind === 'code_plan' ? 'G2' : 'G3'}`,
            outcome: 'allowed', runId: run.id, correlationId, actor });

    await engine.applyDecision(run.id, { baseCandidateId: baseId, appliedSuggestionIds: requested });

    const after = runsRepo.getRun(run.id);
    // Create the G4 scorecard as soon as the run enters scoring, so the rows exist to be filled.
    if (after.state === 'scoring' && !scoringRepo.getScorecardForRun(run.id)) {
      const finalCand = pickFinalCandidate(run.id);
      scoringRepo.createScorecard({ runId: run.id, candidateId: finalCand.id, template: templateOf(skill) });
    }
    writeProvenance(run.id);
    return accepted({ decisionId, run: runSummary(runsRepo.getRun(run.id)) });
  });

  /**
   * FR-REVIEW-004: a human revision is recorded as a NEW candidate with `derivedFrom`, and the
   * edit is recorded in provenance. The original is never mutated.
   *
   * This is also the only way out of a placeholder block: FR-GEN-005 refuses to publish a
   * candidate carrying `TBD [UNKNOWN]`, and the resolution is for a person to supply the
   * missing value — not for the gate to be waived.
   */
  app.post('/api/v1/candidates/:candidateId/edit', ({ params, body, correlationId }) => {
    const original = councilRepo.getCandidate(params.candidateId);
    if (!original) fail('not_found', 'Candidate does not exist.');
    const run = runsRepo.getRun(original.runId);
    if (run.state === 'published') {
      fail('invalid_state', 'This run is published. Its artifact is immutable (FR-PROV-003).');
    }
    if (typeof body?.body !== 'string' || body.body.trim().length < 20) {
      fail('validation_failed', 'An edited body is required.', { detail: { fields: [{ path: 'body', code: 'required' }] } });
    }

    // The edit is untrusted text like any other input.
    const { value: safe } = redactDeep({ body: body.body });
    const skill = skillById(run.skillId);
    const template = templateOf(skill);

    // Re-segment against the template so section-level structure (and the scorecard rows that
    // depend on it) survive the edit.
    const sections = template.sections.map((def) => {
      // Headings are rendered numbered ("## 2. Stories"), so match an optional "N." prefix as
      // well as the bare heading — otherwise an edited document re-segments into empty sections.
      const re = new RegExp(`^##\\s*(?:\\d+\\.\\s*)?${def.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im');
      const m = re.exec(safe.body);
      if (!m) return { id: def.id, heading: def.heading, body: '' };
      const start = m.index + m[0].length;
      const next = /^##\s+/im.exec(safe.body.slice(start));
      return { id: def.id, heading: def.heading,
               body: safe.body.slice(start, next ? start + next.index : undefined).trim() };
    });

    const edited = councilRepo.insertCandidate({
      runId: run.id,
      writerProfileId: original.writerProfileId,
      writerDisplayName: `${original.writerDisplayName} (edited by ${actor})`,
      resolvedModel: original.resolvedModel,
      modelDisplayName: original.modelDisplayName,
      modelFamily: original.modelFamily,
      origin: 'human_edit',
      derivedFrom: original.id,
      body: safe.body,
      sections,
      wordCount: (safe.body.match(/\b[\w'-]+\b/g) ?? []).length,
      // Re-scanned, not inherited: the point of the edit is usually to remove a placeholder,
      // and trusting the old count would defeat the gate in the other direction too.
      placeholders: scanPlaceholdersOf(sections),
      citations: original.citations,
      inputTokens: 0, outputTokens: 0, premiumRequests: 0,
    });

    runsRepo.appendEvent(run.id, 'candidate.edited', {
      actor, candidateId: edited.id, derivedFrom: original.id,
      summary: body.summary ?? 'Human revision.',
      placeholdersBefore: original.placeholders.length,
      placeholdersAfter: edited.placeholders.length,
    });
    audit({ category: 'propose', action: 'candidate.edit', outcome: 'allowed', runId: run.id, correlationId, actor });

    const prov = publishRepo.getProvenanceForRun(run.id);
    publishRepo.patchProvenance(run.id, {
      humanEdits: [...(prov?.humanEdits ?? []),
                   { actor, at: new Date().toISOString(), summary: body.summary ?? 'Human revision.',
                     candidateId: edited.id, derivedFrom: original.id }],
    });

    return created({ candidate: publicCandidate(edited) });
  });

  // ── Gate G4: the section scorecard ─────────────────────────────────────────────────────

  app.get('/api/v1/runs/:runId/scorecard', ({ params }) => {
    const card = scoringRepo.getScorecardForRun(params.runId);
    if (!card) fail('not_found', 'No scorecard exists for this run.');
    const skill = skillById(runsRepo.getRun(params.runId).skillId);
    const template = templateOf(skill);
    return {
      scorecard: {
        ...card,
        rows: card.rows.map((r) => ({
          ...r,
          // The hint is a starting point shown as help text; it is NEVER pre-filled into the
          // input (FR-SCORE-006: no auto-fill, no inference, no apply-to-all).
          manualEffortHint: template.sections.find((s) => s.id === r.sectionId)?.manualEffortHint ?? null,
        })),
      },
    };
  });

  app.put('/api/v1/scorecards/:scorecardId/sections/:sectionId', ({ params, body, correlationId }) => {
    // FR-API-030: aggregates are computed server-side. A client supplying one is rejected
    // outright — otherwise the accuracy instrument could be asserted rather than measured.
    for (const forbidden of ['effortSavedPercent', 'aggregateAccuracy', 'aggregateEffortSavedPercent']) {
      if (body && forbidden in body) {
        fail('validation_failed',
          `"${forbidden}" is computed by the server and must not be supplied.`,
          { requirementId: 'FR-API-030' });
      }
    }
    const verdicts = ['accurate', 'minor_rework', 'major_rework', 'unusable'];
    const errs = [];
    if (!verdicts.includes(body?.verdict)) {
      errs.push({ path: 'verdict', code: 'invalid', message: `Expected one of: ${verdicts.join(', ')}.` });
    }
    for (const f of ['manualEffortHours', 'reworkHours']) {
      const n = Number(body?.[f]);
      if (!Number.isFinite(n) || n < 0) errs.push({ path: f, code: 'invalid', message: 'Expected a number of hours ≥ 0.' });
    }
    const acc = Number(body?.accuracyPercent);
    if (!Number.isInteger(acc) || acc < 0 || acc > 100) {
      errs.push({ path: 'accuracyPercent', code: 'invalid', message: 'Expected an integer between 0 and 100.' });
    }
    if (Number(body?.reworkHours) > Number(body?.manualEffortHours)) {
      errs.push({ path: 'reworkHours', code: 'invalid',
        message: 'Rework cannot exceed the manual estimate — that would be a negative saving. Check both figures.' });
    }
    if (errs.length) fail('validation_failed', `${errs.length} field(s) are invalid.`, { detail: { fields: errs } });

    const r = scoringRepo.scoreSection(params.scorecardId, params.sectionId, body, actor);
    if (r.error === 'section_not_in_scorecard') {
      fail('validation_failed', `Section "${params.sectionId}" is not part of this scorecard's template version.`,
        { requirementId: 'FR-API-031' });
    }
    if (r.error === 'scorecard_complete') {
      fail('invalid_state', 'This scorecard is complete and immutable. A correction creates a new scorecard.',
        { requirementId: 'FR-API-032' });
    }
    const card = scoringRepo.getScorecard(params.scorecardId);
    runsRepo.appendEvent(card.runId, 'score.section', {
      actor, section: params.sectionId, accuracy: Number(body.accuracyPercent),
      scoredRows: card.scoredRows, totalRows: card.totalRows,
    });
    return { scorecard: card };
  });

  app.post('/api/v1/scorecards/:scorecardId/complete', ({ params, correlationId }) => {
    const r = scoringRepo.completeScorecard(params.scorecardId, actor);
    if (r.error === 'not_found') fail('not_found', 'Scorecard does not exist.');
    if (r.error === 'scorecard_incomplete') {
      // FR-SCORE-001: enforced HERE, server-side, not by a disabled button.
      fail('scorecard_incomplete',
        `${r.detail.scoredRows} of ${r.detail.totalRows} sections scored — ${r.detail.totalRows - r.detail.scoredRows} remaining. ` +
        'Every section must be scored before publication.',
        { requirementId: 'FR-SCORE-001', detail: r.detail });
    }
    const card = r.scorecard;
    runsRepo.appendEvent(card.runId, 'score.complete', {
      actor, aggregateAccuracy: card.aggregateAccuracy,
      aggregateEffortSavedPercent: card.aggregateEffortSavedPercent,
      totalRows: card.totalRows,
    });
    audit({ category: 'approve', action: 'gate.G4', outcome: 'allowed', runId: card.runId, correlationId, actor });
    const run = runsRepo.updateRun(card.runId, { state: 'approved', currentPhase: 'publish' });
    writeProvenance(card.runId);
    return { scorecard: card, run: runSummary(run) };
  });

  // ── Gate G5: proposal, approval, publication ───────────────────────────────────────────

  app.post('/api/v1/runs/:runId/proposals', ({ params, body, correlationId }) => {
    const run = runsRepo.getRun(params.runId);
    if (!run) fail('not_found', 'Run does not exist.');
    const skill = skillById(run.skillId);
    const candidate = pickFinalCandidate(run.id);
    if (!candidate) fail('invalid_state', 'This run has no candidate to publish.');

    // FR-GEN-005: unresolved placeholders BLOCK publication. The pilot shipped exactly these
    // strings into published Confluence pages.
    if (candidate.placeholders.length > 0) {
      audit({ category: 'propose', action: 'proposal.create', outcome: 'blocked', runId: run.id,
              reasonCode: 'placeholders_present', requirementId: 'FR-GEN-005', correlationId, actor });
      fail('placeholders_present',
        `${candidate.placeholders.length} unresolved placeholder${candidate.placeholders.length === 1 ? '' : 's'} must be resolved before publishing.`,
        { requirementId: 'FR-GEN-005',
          detail: { placeholders: candidate.placeholders.map((p) => ({ sectionId: p.sectionId, sectionHeading: p.sectionHeading, text: p.text })) } });
    }

    // Secret scan findings block a code proposal (NFR-SEC-007).
    const execution = councilRepo.getExecution(run.id);
    if (execution?.secretFindings?.length) {
      audit({ category: 'propose', action: 'proposal.create', outcome: 'blocked', runId: run.id,
              reasonCode: 'secret_scan_findings', requirementId: 'NFR-SEC-007', correlationId, actor });
      fail('secret_scan_findings', execution.secretFindings[0].message,
        { requirementId: 'NFR-SEC-007', detail: { findings: execution.secretFindings } });
    }

    const targets = buildTargets({ run, skill, candidate, execution, body });
    const findings = [];
    for (const t of targets) findings.push(...adapterFor(t.kind).validate(t));
    const blocking = findings.filter((f) => f.blocking);

    const version = publishRepo.nextProposalVersion(run.id);
    const fingerprint = publishRepo.computeFingerprint({
      operation: targets[0].operation ?? 'create', targets, candidateBody: candidate.body,
    });
    const proposal = publishRepo.insertProposal({
      runId: run.id, candidateId: candidate.id, version,
      operation: targets[0].operation ?? 'create',
      targets,
      validationStatus: blocking.length ? 'blocked' : findings.length ? 'warn' : 'ok',
      validationFindings: findings,
      // Stored PER TARGET. A joined string cannot express "target 3 moved but target 1 is
      // simply done" — see staleTargetIndexes below.
      staleCheckAnchor: JSON.stringify(targets.map((t) => adapterFor(t.kind).anchor(t))),
      operationFingerprint: fingerprint,
    });

    runsRepo.appendEvent(run.id, 'proposal.created', {
      proposalId: proposal.id, version, targets: targets.map((t) => adapterFor(t.kind).describe(t)),
      validationStatus: proposal.validationStatus,
    });
    audit({ category: 'propose', action: 'proposal.create', outcome: 'allowed', runId: run.id,
            proposalId: proposal.id, correlationId, actor });

    return created({ proposal: decorateProposal(proposal, run, candidate) });
  });

  app.get('/api/v1/proposals/:proposalId', ({ params }) => {
    const p = publishRepo.getProposal(params.proposalId);
    if (!p) fail('not_found', 'Proposal does not exist.');
    const run = runsRepo.getRun(p.runId);
    return { proposal: decorateProposal(p, run, councilRepo.getCandidate(p.candidateId)),
             approval: publishRepo.liveApproval(p.id),
             results: publishRepo.latestResults(p.id) };
  });

  app.post('/api/v1/proposals/:proposalId/revalidate', ({ params }) => {
    const p = publishRepo.getProposal(params.proposalId);
    if (!p) fail('not_found', 'Proposal does not exist.');
    const staleIndexes = staleTargetIndexes(p);
    const stale = staleIndexes.length > 0;
    if (stale && p.status !== 'applied') publishRepo.setProposalStatus(p.id, 'stale');
    return {
      proposal: publishRepo.getProposal(p.id), stale, staleTargetIndexes: staleIndexes,
      // Targets already applied are excluded from the comparison, so a partially published
      // proposal does not report itself stale on account of its own successes.
      appliedTargetIndexes: publishRepo.latestResults(p.id).filter((r) => r.ok).map((r) => r.targetIndex),
    };
  });

  app.post('/api/v1/proposals/:proposalId/approve', ({ params, body, correlationId }) => {
    const p = publishRepo.getProposal(params.proposalId);
    if (!p) fail('not_found', 'Proposal does not exist.');
    const run = runsRepo.getRun(p.runId);
    const skill = skillById(run.skillId);

    if (p.status === 'applied') fail('invalid_state', 'This proposal has already been applied.');
    if (p.status === 'superseded') fail('proposal_superseded', 'A newer version of this proposal exists.');

    // FR-API-040: BOTH the version and the fingerprint must match. This is what makes
    // "approve exactly what you reviewed" mechanical rather than aspirational.
    if (body?.proposalVersion !== p.version) {
      fail('validation_failed',
        `You approved version ${body?.proposalVersion} but the current version is ${p.version}. Review the current proposal.`,
        { requirementId: 'FR-API-040' });
    }
    if (body?.operationFingerprint !== p.operationFingerprint) {
      fail('validation_failed',
        'The proposal changed since it was displayed. Re-read it before approving — you would be approving something other than what you reviewed.',
        { requirementId: 'FR-API-040' });
    }

    // RCR-STALE-001: re-verify the anchor at approval, per target.
    const staleAtApproval = staleTargetIndexes(p);
    if (staleAtApproval.length > 0) {
      publishRepo.setProposalStatus(p.id, 'stale');
      audit({ category: 'approve', action: 'gate.G5', outcome: 'blocked', runId: run.id, proposalId: p.id,
              reasonCode: 'approval_stale', requirementId: 'RCR-STALE-001', correlationId, actor });
      const names = staleAtApproval.map((i) => adapterFor(p.targets[i].kind).describe(p.targets[i]).title);
      fail('approval_stale',
        `The target changed since this draft was generated${names.length ? `: ${names.slice(0, 3).join(', ')}` : ''}. ` +
        'Review the current version before approving.',
        { requirementId: 'RCR-STALE-001', detail: { staleTargetIndexes: staleAtApproval } });
    }

    // Pre-flight checks, each pass/fail with a reason (screen-specs §6.2).
    const preflight = preflightChecks({ proposal: p, run, skill });
    const failed = preflight.filter((c) => !c.pass);
    if (failed.length) {
      audit({ category: 'approve', action: 'gate.G5', outcome: 'blocked', runId: run.id, proposalId: p.id,
              reasonCode: failed[0].code, correlationId, actor });
      fail(failed[0].code === 'scorecard_incomplete' ? 'scorecard_incomplete' : 'validation_failed',
        failed[0].message, { detail: { preflight } });
    }

    if (publishRepo.liveApproval(p.id)) {
      fail('invalid_state', 'An unconsumed approval already exists for this proposal version.',
        { requirementId: 'FR-API-042' });
    }

    const approval = publishRepo.insertApproval({
      proposalId: p.id, proposalVersion: p.version, operationFingerprint: p.operationFingerprint,
      decision: 'approve', note: body.note, actor,
    });
    publishRepo.setProposalStatus(p.id, 'approved');
    runsRepo.appendEvent(run.id, 'approval.recorded', {
      actor, proposalId: p.id, approvalId: approval.id, version: p.version, note: body.note ?? null,
    });
    audit({ category: 'approve', action: 'gate.G5', outcome: 'allowed', runId: run.id,
            proposalId: p.id, correlationId, actor });
    // FR-PROV-003: provenance becomes immutable on approval.
    publishRepo.sealProvenance(run.id, { approvedBy: actor, approvedAt: approval.createdAt });

    return created({ approval, preflight });
  });

  app.post('/api/v1/proposals/:proposalId/reject', ({ params, body, correlationId }) => {
    const p = publishRepo.getProposal(params.proposalId);
    if (!p) fail('not_found', 'Proposal does not exist.');
    publishRepo.insertApproval({
      proposalId: p.id, proposalVersion: p.version, operationFingerprint: p.operationFingerprint,
      decision: 'reject', note: body?.note, actor,
    });
    publishRepo.setProposalStatus(p.id, 'rejected');
    audit({ category: 'approve', action: 'gate.G5.reject', outcome: 'allowed', runId: p.runId,
            proposalId: p.id, correlationId, actor });
    return { proposal: publishRepo.getProposal(p.id) };
  });

  app.post('/api/v1/proposals/:proposalId/publish', ({ params, body, correlationId }) => {
    const p = publishRepo.getProposal(params.proposalId);
    if (!p) fail('not_found', 'Proposal does not exist.');
    const run = runsRepo.getRun(p.runId);
    const candidate = councilRepo.getCandidate(p.candidateId);

    // FR-API-006: no endpoint writes externally without a valid, current, UNCONSUMED approval.
    const approval = publishRepo.getApproval(body?.approvalId ?? '');
    if (!approval || approval.proposalId !== p.id || approval.decision !== 'approve') {
      audit({ category: 'apply', action: 'publish', outcome: 'blocked', runId: run.id, proposalId: p.id,
              reasonCode: 'approval_required', requirementId: 'FR-APPROVE-001', correlationId, actor });
      fail('approval_required',
        'No valid approval was presented for this publication. AI proposes; a human approves every write.',
        { requirementId: 'FR-APPROVE-001' });
    }
    if (approval.consumedAt) {
      audit({ category: 'apply', action: 'publish', outcome: 'blocked', runId: run.id, proposalId: p.id,
              reasonCode: 'approval_consumed', requirementId: 'FR-APPROVE-001', correlationId, actor });
      fail('approval_consumed',
        `This approval was already used at ${approval.consumedAt}. An approval is single-use — approve again to republish.`,
        { requirementId: 'FR-APPROVE-001' });
    }
    if (approval.operationFingerprint !== p.operationFingerprint) {
      fail('approval_stale', 'The proposal changed after approval. Re-approve the current version.',
        { requirementId: 'FR-API-040' });
    }

    const onlyTargets = Array.isArray(body.targetIndexes) ? new Set(body.targetIndexes) : null;

    // FR-API-041: re-verify the stale anchor IMMEDIATELY BEFORE APPLY, not only at approval —
    // the dangerous window is between the two. Scoped to the targets actually being attempted.
    const staleNow = staleTargetIndexes(p, onlyTargets);
    if (staleNow.length > 0) {
      publishRepo.setProposalStatus(p.id, 'stale');
      audit({ category: 'apply', action: 'publish', outcome: 'blocked', runId: run.id, proposalId: p.id,
              reasonCode: 'approval_stale', requirementId: 'RCR-STALE-001', correlationId, actor });
      fail('approval_stale',
        'The target changed between approval and publication. The approval is void; review and approve again.',
        { requirementId: 'RCR-STALE-001', detail: { staleTargetIndexes: staleNow } });
    }
    const results = [];
    let anyAttempted = false;

    for (const [i, target] of p.targets.entries()) {
      if (onlyTargets && !onlyTargets.has(i)) continue;
      const idemKey = publishRepo.idempotencyKey(p, i);

      // FR-API-052: a repeat with the same key returns the ORIGINAL stored result and performs
      // NO external call. This is what makes "a retried publish must never create a second Jira
      // issue or Confluence page" true rather than hoped for.
      const prior = publishRepo.findSuccessfulResult(idemKey);
      if (prior) {
        results.push({ ...prior, replayed: true });
        continue;
      }

      anyAttempted = true;
      const adapter = adapterFor(target.kind);
      try {
        const out = adapter.apply(target, { body: candidate.body, actor, approvalId: approval.id });
        const stored = publishRepo.insertResult({
          proposalId: p.id, approvalId: approval.id, targetIndex: i,
          ok: out.ok, externalId: out.externalId, externalUrl: out.externalUrl,
          errorCode: out.errorCode, errorMessage: out.errorMessage, idempotencyKey: idemKey,
        });
        results.push({ ...stored, items: out.items ?? null, detail: out.detail ?? null, partial: !!out.partial });
      } catch (err) {
        results.push(publishRepo.insertResult({
          proposalId: p.id, approvalId: approval.id, targetIndex: i, ok: false,
          errorCode: err.code ?? 'external_system_error', errorMessage: err.message, idempotencyKey: idemKey,
        }));
      }
    }

    // The approval is consumed once an attempt was made, whatever the outcome — a single-use
    // token is spent on use, not on success, or a failed publish would leave a reusable one.
    if (anyAttempted) publishRepo.consumeApproval(approval.id);

    const succeeded = results.filter((r) => r.ok).length;
    const failedCount = results.length - succeeded;
    const allResults = publishRepo.latestResults(p.id);
    const allOk = allResults.length === p.targets.length && allResults.every((r) => r.ok);

    if (allOk) publishRepo.setProposalStatus(p.id, 'applied');

    for (const r of results) {
      runsRepo.appendEvent(run.id, 'publish.result', {
        target: p.targets[r.targetIndex].kind, targetIndex: r.targetIndex,
        externalId: r.externalId, url: r.externalUrl, ok: r.ok,
        errorMessage: r.errorMessage ?? null, replayed: !!r.replayed,
      });
    }
    audit({ category: 'publish', action: 'publish', outcome: failedCount ? 'failed' : 'allowed',
            runId: run.id, proposalId: p.id, correlationId, actor });

    if (allOk) {
      const updated = runsRepo.updateRun(run.id, { state: 'published', completedAt: new Date().toISOString() });
      publishRepo.sealProvenance(run.id, {
        publishedTo: allResults.filter((r) => r.ok).map((r) => ({
          system: systemLabel(p.targets[r.targetIndex].kind), externalId: r.externalId, externalUrl: r.externalUrl,
        })),
      });
      return { results: allResults, summary: { total: p.targets.length, succeeded: allResults.length, failed: 0 },
               proposal: publishRepo.getProposal(p.id), run: runSummary(updated) };
    }

    // FR-PUBLISH-003: report exactly what succeeded, and offer retry of ONLY the failures.
    return multiStatus({
      results: allResults,
      summary: { total: p.targets.length, succeeded: allResults.filter((r) => r.ok).length,
                 failed: allResults.filter((r) => !r.ok).length },
      retryable: allResults.filter((r) => !r.ok).map((r) => r.targetIndex),
      proposal: publishRepo.getProposal(p.id),
      run: runSummary(runsRepo.getRun(run.id)),
    });
  });

  // ── Provenance ─────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/runs/:runId/provenance', ({ params }) => {
    const rec = publishRepo.getProvenanceForRun(params.runId);
    if (!rec) fail('not_found', 'No provenance record exists for this run yet.');
    return { provenance: rec };
  });

  // ── Admin console (read-only, FR-ADMIN-001..008) ───────────────────────────────────────

  app.get('/api/v1/admin/usage', ({ query }) => {
    const from = query.get('from');
    const to = query.get('to');
    const ledger = costRepo.ledgerSummary({ from, to });
    const runs = runsRepo.listRuns({ limit: 500 });
    const inRange = runs.filter((r) => (!from || r.createdAt.slice(0, 10) >= from) && (!to || r.createdAt.slice(0, 10) <= to));
    const published = inRange.filter((r) => r.state === 'published').length;
    const failedOrCancelled = inRange.filter((r) => ['failed', 'cancelled'].includes(r.state)).length;
    const accuracy = scoringRepo.accuracyBySkill();
    const overrides = listAudit({ category: 'policy', limit: 500 })
      .filter((a) => a.reasonCode === 'quality_threshold_override').length;

    return {
      // FR-ADMIN-002: every figure comes from the ONE ledger, so tabs reconcile.
      totals: {
        ...ledger.totals,
        runs: inRange.length,
        published,
        failedOrCancelled,
        averagePremiumRequestsPerRun: inRange.length
          ? Math.round((ledger.totals.premiumRequests / inRange.length) * 100) / 100 : 0,
        meanSectionAccuracy: accuracy.length
          ? Math.round((accuracy.reduce((a, x) => a + (x.meanAccuracy ?? 0), 0) / accuracy.length) * 10) / 10 : null,
        qualityThresholdOverrides: overrides,
      },
      byPhase: ledger.byPhase,
      byModelFamily: ledger.byModelFamily,
      byModel: ledger.byModel,
      bySkill: ledger.bySkill,
      byDay: ledger.byDay,
      accuracyBySkill: accuracy,
      // FR-ADMIN-006: bands classify runs for REPORTING ONLY. They never choose models,
      // writers or phases.
      sizeBands: config.budget.sizeBands,
      sizeBandCounts: countBands(inRange),
      // FR-ADMIN-005: context-strategy comparison, with inline definitions.
      contextStrategy: contextStrategyComparison(inRange),
      empty: inRange.length === 0,
      range: { from, to },
      price: config.budget.premiumRequestPrice,
    };
  });

  app.get('/api/v1/admin/runs', ({ query }) => ({
    // FR-ADMIN-003: the ledger table. An unresolved model shows "unknown model" AS MEASURED.
    rows: runsRepo.listRuns({ limit: Number.parseInt(query.get('limit') ?? '200', 10),
                              skillId: query.get('skillId'), state: query.get('state') })
      .map((r) => {
        const cost = costRepo.runCost(r.id);
        return {
          runId: r.id, title: r.title, skillId: r.skillId, agentId: r.agentId, actor: r.createdBy,
          startedAt: r.createdAt, state: r.state, degraded: r.degraded,
          modelFamilies: [...new Set(r.writerSelection.map((w) => w.family ?? 'unknown model'))],
          premiumRequests: cost.total.premiumRequests,
          tokens: cost.total.totalTokens,
          phaseBreakdown: cost.byPhase,
          sizeBand: sizeBandFor(cost.total.premiumRequests, config.budget.sizeBands),
          estimatePremiumRequests: r.estimate?.premiumRequests ?? null,
          variancePercent: variance(r.estimate, cost.total.premiumRequests),
        };
      }),
  }));

  /** FR-ADMIN-004: the estimate calculator, with multipliers rendered FROM THE REGISTRY. */
  app.post('/api/v1/admin/estimate', ({ body }) => {
    const { skill, selection, captainResolved, template } = resolveSelection(body);
    const consumed = costRepo.dailyConsumption(actor);
    const { estimate, allowed, block } = estimateRun({
      phases: effectivePhases(skill, selection.length), writerSelection: selection, captainResolved,
      template, inputs: body.inputs ?? { approxContextChars: body.contextChars ?? 4000 },
      budget: config.budget, consumedToday: consumed,
    });
    return {
      estimate, allowed, block,
      multiplierReference: registry.table().map((e) => ({
        displayName: e.displayName, family: e.family, multiplier: e.multiplier,
        contextWindow: e.contextWindow, status: e.status,
      })),
    };
  });

  app.get('/api/v1/budget', () => budgetState());

  app.get('/api/v1/audit', ({ query }) => ({
    events: listAudit({ category: query.get('category'), outcome: query.get('outcome'),
                        runId: query.get('runId'), limit: 300 }),
  }));

  // ── Mock systems of record (PoC only) ──────────────────────────────────────────────────

  app.get('/api/v1/sor', () => sorIndex());
  app.get('/api/v1/sor/confluence/:id', ({ params }) => {
    const p = sorConfluencePage(params.id);
    if (!p) fail('not_found', 'Page does not exist.');
    return { page: p };
  });
  app.get('/api/v1/sor/jira/:key', ({ params }) => {
    const i = sorJiraIssue(params.key);
    if (!i) fail('not_found', 'Issue does not exist.');
    return { issue: i };
  });
  app.get('/api/v1/sor/pr/:id', ({ params }) => {
    const pr = sorPullRequest(params.id);
    if (!pr) fail('not_found', 'Pull request does not exist.');
    return { pullRequest: pr };
  });
  /** Demo affordance: mutate a page so the stale-approval path can be shown. */
  app.post('/api/v1/sor/confluence/:id/touch', ({ params }) => ({ page: sorTouchPage(params.id, 'another.user') }));

  // ── Health ─────────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/health', () => {
    const checks = [
      { name: 'database', status: 'ok' },
      { name: `provider.${registry.transportName}`, status: 'ok', detail: registry.transport.describe() },
      { name: 'sandbox', status: sandbox.available() ? 'ok' : 'failed',
        detail: sandbox.available() ? `runtime: ${sandbox.runtime.name}` : 'no runtime available; code skills disabled' },
      { name: 'integration.confluence', status: 'ok', detail: 'mock store (PoC)' },
      { name: 'integration.jira', status: 'ok', detail: 'mock store (PoC)' },
      { name: 'integration.scm', status: 'ok', detail: 'mock store (PoC) — proposal only, no push capability' },
    ];
    // A model family that cannot be reached is reported, not hidden.
    for (const lm of config.models.logicalModels) {
      try { registry.resolve(lm.id); }
      catch (e) { checks.push({ name: `model.${lm.id}`, status: 'failed', detail: e.message }); }
    }
    const anyFailed = checks.some((c) => c.status === 'failed');
    return {
      status: anyFailed ? 'degraded' : 'ok',
      version: '0.1.0-poc',
      configHash: config.configHash,
      actor,
      checks,
    };
  });

  // ── helpers ────────────────────────────────────────────────────────────────────────────

  function budgetState() {
    const consumed = costRepo.dailyConsumption(actor);
    const b = config.budget;
    const pct = Math.round((consumed.premiumRequests / b.perUserDailyPremiumRequests) * 100);
    return {
      day: consumed.day,
      premiumRequests: { consumed: consumed.premiumRequests, limit: b.perUserDailyPremiumRequests,
                         remaining: Math.round((b.perUserDailyPremiumRequests - consumed.premiumRequests) * 100) / 100,
                         percent: pct },
      tokens: { consumed: consumed.tokens, limit: b.perUserDailyTokens,
                remaining: b.perUserDailyTokens - consumed.tokens,
                percent: Math.round((consumed.tokens / b.perUserDailyTokens) * 100) },
      perRun: { premiumRequests: b.perRunPremiumRequests, tokens: b.perRunTokens },
      warnPercent: b.warnPercent,
      warning: pct >= b.warnPercent,
      exhausted: consumed.premiumRequests >= b.perUserDailyPremiumRequests || consumed.tokens >= b.perUserDailyTokens,
      runsToday: consumed.runs,
      price: b.premiumRequestPrice,
    };
  }

  function pickFinalCandidate(runId) {
    const cands = councilRepo.listCandidates(runId);
    // A human edit is the most recent authority on the artifact, so it outranks the synthesis
    // it was derived from.
    const edited = [...cands].reverse().find((c) => c.origin === 'human_edit');
    if (edited) return edited;
    const synth = [...cands].reverse().find((c) => c.origin === 'synthesis');
    if (synth) return synth;
    const verdict = councilRepo.getVerdict(runId);
    const decisions = councilRepo.listHumanDecisions(runId);
    const chosenId = [...decisions].reverse().find((d) => d.baseCandidateId)?.baseCandidateId
      ?? verdict?.winnerCandidateId;
    return cands.find((c) => c.id === chosenId) ?? cands[0] ?? null;
  }

  /**
   * RCR-STALE-001, per target.
   *
   * Staleness means "the thing I reviewed moved underneath me". It is therefore computed per
   * target, and a target that has ALREADY BEEN SUCCESSFULLY APPLIED is excluded: its anchor
   * changing is the expected consequence of applying it, not evidence of interference.
   *
   * Computing this across the whole proposal was a live-lock: after a partial publish created
   * five of six Jira issues, those five anchors legitimately changed, which voided the very
   * approval needed to retry the sixth. The successes blocked the retry.
   *
   * @param only optional set of target indexes under consideration (a retry names its targets)
   */
  function staleTargetIndexes(proposal, only = null) {
    let approved;
    try {
      approved = JSON.parse(proposal.staleCheckAnchor);
      if (!Array.isArray(approved)) throw new Error('legacy');
    } catch {
      // A proposal stored before the per-target format: fall back to a whole-proposal compare.
      const current = proposal.targets.map((t) => adapterFor(t.kind).anchor(t)).join('|');
      return current === proposal.staleCheckAnchor ? [] : [-1];
    }

    const applied = new Set(
      publishRepo.latestResults(proposal.id).filter((r) => r.ok).map((r) => r.targetIndex)
    );

    const stale = [];
    for (const [i, target] of proposal.targets.entries()) {
      if (applied.has(i)) continue;                 // already done
      if (only && !only.has(i)) continue;           // not part of this attempt
      if (adapterFor(target.kind).anchor(target) !== approved[i]) stale.push(i);
    }
    return stale;
  }

  function preflightChecks({ proposal, run, skill }) {
    const candidate = councilRepo.getCandidate(proposal.candidateId);
    const scorecard = scoringRepo.getScorecardForRun(run.id);
    const execution = councilRepo.getExecution(run.id);
    const budget = budgetState();
    const blockingFindings = proposal.validationFindings.filter((f) => f.blocking);

    // Each check carries BOTH messages, because a passing check that displays the failure text
    // is worse than no text at all — it reads as "✓ Budget available — daily budget is
    // exhausted", which is precisely the dishonest state design-system §1.3 forbids.
    const checks = [
      { id: 'placeholders', label: 'Placeholders resolved',
        pass: candidate.placeholders.length === 0, code: 'placeholders_present',
        passMessage: 'No unresolved placeholders.',
        failMessage: `${candidate.placeholders.length} unresolved placeholder(s) remain.` },

      { id: 'scorecard', label: 'Sections scored',
        pass: !scorecardRequired(run, skill) || (scorecard?.complete ?? false), code: 'scorecard_incomplete',
        passMessage: scorecardRequired(run, skill)
          ? `${scorecard?.totalRows ?? 0} of ${scorecard?.totalRows ?? 0} sections scored.`
          : 'Scorecard not required for this run.',
        failMessage: `${scorecard?.scoredRows ?? 0} of ${scorecard?.totalRows ?? 0} sections scored.` },

      { id: 'secrets', label: 'Secret scan clean',
        pass: !(execution?.secretFindings?.length), code: 'secret_scan_findings',
        passMessage: execution ? 'No credential-like strings found.' : 'No generated code to scan.',
        failMessage: execution?.secretFindings?.[0]?.message ?? 'Credential-like string found.' },

      { id: 'targets', label: 'Target valid',
        pass: blockingFindings.length === 0, code: 'validation_failed',
        passMessage: `${proposal.targets.length} target(s) resolve.`,
        failMessage: blockingFindings.map((f) => f.message).join(' ') },

      { id: 'stale', label: 'Base version current',
        pass: proposal.status !== 'stale', code: 'approval_stale',
        passMessage: 'The target is unchanged since this draft was generated.',
        failMessage: 'The target changed since the proposal was built.' },

      { id: 'budget', label: 'Budget available',
        pass: !budget.exhausted, code: 'budget_exceeded',
        passMessage: `${budget.premiumRequests.remaining} premium requests remain today.`,
        failMessage: 'Daily budget is exhausted.' },
    ];
    return checks.map((c) => ({
      id: c.id, label: c.label, pass: c.pass, code: c.code,
      message: c.pass ? c.passMessage : c.failMessage,
    }));
  }

  function buildTargets({ run, skill, candidate, execution, body }) {
    const epic = run.epicRef ?? 'UNKNOWN';
    const out = [];
    for (const kind of skill.publishTargets) {
      if (kind === 'confluence_page') {
        out.push({
          kind, operation: body?.existingPageId ? 'update' : 'create',
          space: body?.space ?? 'alberta',
          parentId: body?.parentId ?? null,
          parentTitle: 'Council Generated Pages',
          existingPageId: body?.existingPageId ?? null,
          baseVersion: body?.baseVersion ?? 0,
          title: body?.title ?? `${templateOf(skill).title} — ${epic}`,
        });
      }
      if (kind === 'jira_issue') {
        // ONE TARGET PER ISSUE, deliberately.
        //
        // The target is the unit of idempotency, approval and retry, so it must also be the
        // unit a human thinks about. Bundling seven stories into one target made a publish in
        // which six issues were created report as a single failure, and made "retry only the
        // failed item" impossible to express — exactly the duplicate-creating blanket retry
        // FR-PUBLISH-003 exists to prevent.
        const stories = extractStories(candidate);
        const assignee = body?.assignee !== undefined ? body.assignee : (run.inputs.assignee ?? null);
        for (const [i, summary] of stories.entries()) {
          out.push({
            kind, operation: 'create',
            project: run.inputs.jiraProject ?? 'G1206',
            issueType: 'Story', parentKey: epic,
            items: [{
              summary,
              description: `Decomposed from ${run.title}.\n\nTraceability ID: ${epic}`,
              assignee,
              // One item is made to fail so partial failure and retry-only-failures are
              // demonstrable. Driven by an explicit flag, never by chance.
              simulateFieldRejection: body?.simulatePartialFailure === true && i === 2,
            }],
          });
        }
      }
      if (kind === 'pull_request') {
        out.push({
          kind, operation: 'pr',
          repository: execution?.repository ?? run.inputs.repositoryUrl ?? 'sample-repo',
          branch: execution?.branchName ?? `codeplan-${epic}-impl`,
          baseBranch: execution?.baseBranch ?? run.inputs.baseBranch ?? 'dev',
          title: `${run.inputs.storyKey ?? epic}: ${skill.name}`,
          filesChanged: execution?.filesChanged ?? 0,
          linesAdded: execution?.linesAdded ?? 0,
          linesRemoved: execution?.linesRemoved ?? 0,
          forkDetected: execution?.forkDetected ?? false,
          diff: (execution?.files ?? []).map((f) => `--- ${f.path}\n+++ ${f.path}`).join('\n'),
          // FR-PUBLISH-005: an explicit confirmation naming repository, branch and target.
          confirmed: body?.confirmed === true,
        });
      }
    }
    return out;
  }

  function decorateProposal(p, run, candidate) {
    return {
      ...p,
      targetSummaries: p.targets.map((t) => adapterFor(t.kind).describe(t)),
      candidate: candidate ? { id: candidate.id, wordCount: candidate.wordCount,
                               sections: candidate.sections.length, origin: candidate.origin } : null,
      preflight: preflightChecks({ proposal: p, run, skill: skillById(run.skillId) }),
    };
  }

  function writeProvenance(runId) {
    const run = runsRepo.getRun(runId);
    const skill = skillById(run.skillId);
    const candidates = councilRepo.listCandidates(runId);
    const final = pickFinalCandidate(runId);
    if (!final) return;
    const reviews = councilRepo.listReviews(runId);
    const verdict = councilRepo.getVerdict(runId);
    const scorecard = scoringRepo.getScorecardForRun(runId);
    const decisions = councilRepo.listHumanDecisions(runId);
    const cost = costRepo.runCost(runId);
    const template = templateOf(skill);

    const promptHashes = [];
    for (const w of run.writerSelection) {
      const prof = writerProfile(w.profileId);
      const p = config.prompts[prof.promptRef];
      if (p) promptHashes.push({ role: `writer:${prof.id}`, ref: p.ref, hash: p.checksum });
    }
    if (skill.council.captain) {
      const cap = config.captains.find((c) => c.id === skill.council.captain);
      const p = config.prompts[cap.promptRef];
      if (p) promptHashes.push({ role: 'captain', ref: p.ref, hash: p.checksum });
    }
    for (const ref of [skill.promptRef, 'policy/product-policy.v1.md']) {
      const p = config.prompts[ref];
      if (p) promptHashes.push({ role: ref.startsWith('policy') ? 'policy' : 'skill', ref: p.ref, hash: p.checksum });
    }

    const record = {
      runId, candidateId: final.id,
      stageId: run.stageId, agentId: run.agentId, skillId: run.skillId,
      templateId: template.id, templateVersion: template.version,
      configHash: run.configHash, transport: run.transport,
      promptHashes,
      writers: run.writerSelection.map((w) => {
        const cand = candidates.find((c) => c.writerProfileId === w.profileId && c.origin === 'writer');
        return { profileId: w.profileId, displayName: w.displayName, logicalModel: w.logicalModel,
                 resolvedModel: w.resolvedModel, modelDisplayName: w.modelDisplayName, family: w.family,
                 candidateId: cand?.id ?? null, words: cand?.wordCount ?? null,
                 inputTokens: cand?.inputTokens ?? null, outputTokens: cand?.outputTokens ?? null,
                 premiumRequests: cand?.premiumRequests ?? null };
      }),
      reviews: reviews.map((r) => ({ evaluatorProfileId: r.evaluatorProfileId, candidateId: r.candidateId,
                                     isSelf: r.isSelf, score: r.overallScore })),
      captainMode: run.captainMode,
      verdict: verdict ? { winnerCandidateId: verdict.winnerCandidateId, captainProfileId: verdict.captainProfileId,
                           resolvedModel: verdict.resolvedModel, modelDisplayName: verdict.modelDisplayName,
                           // The Captain's own rubric score of the draft (single-writer runs).
                           evaluation: verdict.evaluation ?? null } : null,
      appliedSuggestions: (decisions.flatMap((d) => d.appliedSuggestionIds) ?? []).map((id) => {
        const s = verdict?.suggestions.find((x) => x.id === id);
        return s ? { suggestionId: id, sourceCandidateId: s.sourceCandidateId, sourceLabel: s.sourceLabel,
                     targetSectionId: s.targetSectionId } : { suggestionId: id };
      }),
      // FR-SYN-002: section-level composition survives into the published artifact.
      composition: (final.sections ?? []).map((s) => ({
        sectionId: s.id, heading: s.heading,
        sourceCandidateId: s.sourceCandidateId ?? final.id,
        mergedFrom: s.mergedFrom ?? [],
      })),
      contextSources: [],
      knowledgeBases: [],
      degradedSources: [{ source: 'Domain knowledge bases',
                          reason: 'Not licensed for the PoC (A-09). Output is generic-model quality.' }],
      humanDecisions: decisions.map((d) => ({ gate: d.gate, action: d.action, actor: d.actor, at: d.createdAt,
                                              note: d.note })),
      scorecardId: scorecard?.id ?? null,
      aggregateAccuracy: scorecard?.aggregateAccuracy ?? null,
      aggregateEffortSavedPercent: scorecard?.aggregateEffortSavedPercent ?? null,
      scoredBy: scorecard?.actor ?? null,
      cost: { premiumRequests: cost.total.premiumRequests, totalTokens: cost.total.totalTokens,
              estimate: run.estimate?.premiumRequests ?? null,
              variancePercent: variance(run.estimate, cost.total.premiumRequests) },
      publishedTo: [],
      createdAt: new Date().toISOString(),
    };

    if (publishRepo.getProvenanceForRun(runId)) publishRepo.patchProvenance(runId, record);
    else publishRepo.insertProvenance(runId, final.id, record);
  }

  function countBands(runs) {
    const counts = {};
    for (const r of runs) {
      const band = sizeBandFor(costRepo.runCost(r.id).total.premiumRequests, config.budget.sizeBands);
      counts[band] = (counts[band] ?? 0) + 1;
    }
    return counts;
  }

  function contextStrategyComparison(runs) {
    const groups = { retrieval_budgeted: [], full_context: [] };
    for (const r of runs) {
      const key = r.captainMode === 'full_context' ? 'full_context' : 'retrieval_budgeted';
      groups[key].push(r);
    }
    const describe = (list) => {
      if (!list.length) return { runs: 0, meanPremiumRequests: null, meanSectionAccuracy: null };
      const prs = list.map((r) => costRepo.runCost(r.id).total.premiumRequests);
      const accs = list.map((r) => scoringRepo.getScorecardForRun(r.id)?.aggregateAccuracy).filter((x) => x != null);
      return {
        runs: list.length,
        meanPremiumRequests: Math.round((prs.reduce((a, b) => a + b, 0) / prs.length) * 100) / 100,
        meanSectionAccuracy: accs.length ? Math.round((accs.reduce((a, b) => a + b, 0) / accs.length) * 10) / 10 : null,
      };
    };
    return {
      definitions: {
        full_context: 'The Captain was shown the full drafts, the user input and all peer evaluation.',
        retrieval_budgeted: 'The Captain was shown a reduced evidence set (evidence-only or peer-scored mode).',
      },
      full_context: describe(groups.full_context),
      retrieval_budgeted: describe(groups.retrieval_budgeted),
    };
  }

  function runSummary(run) {
    const skill = config.skills.find((s) => s.id === run.skillId);
    const agent = config.agents.find((a) => a.id === run.agentId);
    const stage = config.stages.find((s) => s.id === run.stageId);
    return {
      id: run.id, title: run.title,
      skillId: run.skillId, skillName: skill?.name ?? run.skillId,
      agentId: run.agentId, agentRole: agent?.role ?? run.agentId, agentAlias: agent?.alias ?? null,
      stageId: run.stageId, stageName: stage?.name ?? run.stageId,
      artifactKind: run.artifactKind, epicRef: run.epicRef,
      state: run.state, currentPhase: run.currentPhase, phases: run.phases,
      captainMode: run.captainMode,
      degraded: run.degraded, degradedReason: run.degradedReason,
      // The status string derives from run state in ONE place (FR-HUM-006).
      statusLabel: statusLabel(run, skill?.uiLabels ?? {}),
      statusKind: statusKind(run),
      qualityScore: run.qualityScore,
      writerSelection: run.writerSelection,
      transport: run.transport,
      createdBy: run.createdBy, createdAt: run.createdAt, updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      estimate: run.estimate,
    };
  }

  function publicCandidate(c) {
    return {
      id: c.id, writerProfileId: c.writerProfileId, writerDisplayName: c.writerDisplayName,
      modelDisplayName: c.modelDisplayName, modelFamily: c.modelFamily,
      resolvedModel: c.resolvedModel, origin: c.origin, derivedFrom: c.derivedFrom,
      body: c.body, sections: c.sections, wordCount: c.wordCount, incomplete: c.incomplete,
      placeholders: c.placeholders, citations: c.citations,
      inputTokens: c.inputTokens, outputTokens: c.outputTokens,
      premiumRequests: c.premiumRequests, durationMs: c.durationMs, createdAt: c.createdAt,
    };
  }
}

function publicWriter(w) {
  return {
    profileId: w.profileId, displayName: w.displayName, focusChip: w.focusChip,
    logicalModel: w.logicalModel, resolvedModel: w.resolvedModel,
    modelDisplayName: w.modelDisplayName, family: w.family,
    multiplier: w.multiplier, contextWindow: w.contextWindow, deprecated: w.deprecated,
  };
}

function extractEpic(inputs) {
  for (const v of Object.values(inputs ?? {})) {
    if (typeof v !== 'string') continue;
    const m = v.match(/[A-Z][A-Z0-9]+-\d+/);
    if (m) return m[0];
  }
  return null;
}

/** Pull story lines out of a structured_items candidate for the Jira target. */
function extractStories(candidate) {
  const section = (candidate.sections ?? []).find((s) => s.id === 'stories');
  const lines = String(section?.body ?? '')
    .split('\n')
    .filter((l) => l.trim().startsWith('- '))
    .map((l) => l.replace(/^-\s*/, '').replace(/\s*\[Source:[^\]]*\]\s*/g, '').trim())
    .filter((l) => l.length > 10 && !/^TBD/.test(l));
  return lines.length ? lines : ['Story content could not be parsed from the artifact'];
}
