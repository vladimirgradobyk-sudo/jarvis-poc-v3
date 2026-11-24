// Candidates, reviews, verdicts, suggestions, human decisions, executions.

import { getDb, newId, now } from '../db.js';

const J = JSON.stringify;
const P = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ── Candidates ───────────────────────────────────────────────────────────────────────────

export function insertCandidate(c) {
  const id = c.id ?? newId('cand');
  getDb().prepare(`
    INSERT INTO candidates (id, run_id, writer_profile_id, writer_display_name, resolved_model,
      model_display_name, model_family, origin, derived_from, body, sections, word_count,
      incomplete, input_tokens, output_tokens, premium_requests, duration_ms, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, c.runId, c.writerProfileId, c.writerDisplayName, c.resolvedModel,
    c.modelDisplayName, c.modelFamily, c.origin ?? 'writer', c.derivedFrom ?? null,
    c.body, J(c.sections ?? []), c.wordCount ?? 0, c.incomplete ? 1 : 0,
    c.inputTokens ?? 0, c.outputTokens ?? 0, c.premiumRequests ?? 0, c.durationMs ?? 0, now()
  );

  // FR-GEN-005: placeholders are detected, counted and surfaced as a BLOCKING warning.
  for (const ph of c.placeholders ?? []) {
    getDb().prepare(
      'INSERT INTO candidate_placeholders (candidate_id, section_id, section_heading, text) VALUES (?,?,?,?)'
    ).run(id, ph.sectionId, ph.sectionHeading, ph.text);
  }
  for (const ct of c.citations ?? []) {
    getDb().prepare(
      'INSERT INTO candidate_citations (candidate_id, section_id, source_label) VALUES (?,?,?)'
    ).run(id, ct.sectionId, ct.sourceLabel);
  }
  return getCandidate(id);
}

function hydrateCandidate(row) {
  if (!row) return null;
  const placeholders = getDb()
    .prepare('SELECT section_id, section_heading, text FROM candidate_placeholders WHERE candidate_id = ?')
    .all(row.id)
    .map((r) => ({ sectionId: r.section_id, sectionHeading: r.section_heading, text: r.text }));
  const citations = getDb()
    .prepare('SELECT section_id, source_label FROM candidate_citations WHERE candidate_id = ?')
    .all(row.id)
    .map((r) => ({ sectionId: r.section_id, sourceLabel: r.source_label }));
  return {
    id: row.id,
    runId: row.run_id,
    writerProfileId: row.writer_profile_id,
    writerDisplayName: row.writer_display_name,
    resolvedModel: row.resolved_model,
    modelDisplayName: row.model_display_name,
    modelFamily: row.model_family,
    origin: row.origin,
    derivedFrom: row.derived_from,
    body: row.body,
    sections: P(row.sections, []),
    wordCount: row.word_count,
    incomplete: !!row.incomplete,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    premiumRequests: row.premium_requests,
    durationMs: row.duration_ms,
    placeholders,
    citations,
    createdAt: row.created_at,
  };
}

export function getCandidate(id) {
  return hydrateCandidate(getDb().prepare('SELECT * FROM candidates WHERE id = ?').get(id));
}

export function listCandidates(runId) {
  return getDb()
    .prepare('SELECT * FROM candidates WHERE run_id = ? ORDER BY created_at, id')
    .all(runId)
    .map(hydrateCandidate);
}

export function markCandidateIncomplete(id) {
  getDb().prepare('UPDATE candidates SET incomplete = 1 WHERE id = ?').run(id);
}

// ── Reviews ──────────────────────────────────────────────────────────────────────────────

export function insertReview(r) {
  const id = r.id ?? newId('rev');
  getDb().prepare(`
    INSERT INTO reviews (id, run_id, evaluator_profile_id, evaluator_display_name, candidate_id,
      is_self, overall_score, criterion_scores, strengths, concerns, feedback, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, r.runId, r.evaluatorProfileId, r.evaluatorDisplayName, r.candidateId,
    r.isSelf ? 1 : 0, r.overallScore, J(r.criterionScores), J(r.strengths), J(r.concerns),
    r.feedback, now()
  );
  return id;
}

export function listReviews(runId) {
  return getDb()
    .prepare('SELECT * FROM reviews WHERE run_id = ? ORDER BY candidate_id, evaluator_profile_id')
    .all(runId)
    .map((r) => ({
      id: r.id,
      runId: r.run_id,
      evaluatorProfileId: r.evaluator_profile_id,
      evaluatorDisplayName: r.evaluator_display_name,
      candidateId: r.candidate_id,
      isSelf: !!r.is_self,
      overallScore: r.overall_score,
      criterionScores: P(r.criterion_scores, {}),
      strengths: P(r.strengths, []),
      concerns: P(r.concerns, []),
      feedback: r.feedback,
      createdAt: r.created_at,
    }));
}

// ── Verdict and suggestions ──────────────────────────────────────────────────────────────

export function insertVerdict(v) {
  const id = v.id ?? newId('verd');
  getDb().prepare(`
    INSERT INTO verdicts (id, run_id, winner_candidate_id, captain_profile_id, captain_mode,
      resolved_model, model_display_name, rationale, full_analysis, evaluation, no_verdict, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, v.runId, v.winnerCandidateId, v.captainProfileId, v.captainMode,
    v.resolvedModel, v.modelDisplayName, v.rationale, v.fullAnalysis,
    v.evaluation ? J(v.evaluation) : null, v.noVerdict ? 1 : 0, now()
  );
  // FR-ADJ-002: source_candidate_id is NOT NULL in the schema — an unattributed suggestion
  // cannot be stored, because the reviewer could not check it.
  for (const [i, s] of (v.suggestions ?? []).entries()) {
    getDb().prepare(`
      INSERT INTO suggestions (id, verdict_id, source_candidate_id, source_label, target_section_id, text, ordinal)
      VALUES (?,?,?,?,?,?,?)
    `).run(s.id ?? newId('sug'), id, s.sourceCandidateId, s.sourceLabel, s.targetSectionId ?? null, s.text, i);
  }
  return getVerdict(v.runId);
}

export function getVerdict(runId) {
  const row = getDb().prepare('SELECT * FROM verdicts WHERE run_id = ?').get(runId);
  if (!row) return null;
  const suggestions = getDb()
    .prepare('SELECT * FROM suggestions WHERE verdict_id = ? ORDER BY ordinal')
    .all(row.id)
    .map((s) => ({
      id: s.id,
      sourceCandidateId: s.source_candidate_id,
      sourceLabel: s.source_label,
      targetSectionId: s.target_section_id,
      text: s.text,
      ordinal: s.ordinal,
    }));
  return {
    id: row.id,
    runId: row.run_id,
    winnerCandidateId: row.winner_candidate_id,
    captainProfileId: row.captain_profile_id,
    captainMode: row.captain_mode,
    resolvedModel: row.resolved_model,
    modelDisplayName: row.model_display_name,
    rationale: row.rationale,
    fullAnalysis: row.full_analysis,
    evaluation: P(row.evaluation, null),
    noVerdict: !!row.no_verdict,
    suggestions,
    createdAt: row.created_at,
  };
}

export function deleteVerdict(runId) {
  // Re-adjudication under a different Captain mode replaces the verdict while REUSING the
  // candidates and reviews — the Captain re-runs, the writers do not (FR-HUM-005).
  getDb().prepare('DELETE FROM verdicts WHERE run_id = ?').run(runId);
}

// ── Human decisions (gates G2 / G3) ──────────────────────────────────────────────────────

export function insertHumanDecision(d) {
  const id = d.id ?? newId('dec');
  if (!d.actor) {
    // FR-COUNCIL-008: the engine shall NEVER transition out of awaiting_human without a
    // recorded human decision carrying an actor identity and timestamp.
    throw new Error('A human decision requires an actor (FR-COUNCIL-008).');
  }
  getDb().prepare(`
    INSERT INTO human_decisions (id, run_id, gate, action, base_candidate_id,
      applied_suggestion_ids, note, actor, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    id, d.runId, d.gate, d.action, d.baseCandidateId ?? null,
    J(d.appliedSuggestionIds ?? []), d.note ?? null, d.actor, now()
  );
  return id;
}

export function listHumanDecisions(runId) {
  return getDb()
    .prepare('SELECT * FROM human_decisions WHERE run_id = ? ORDER BY created_at')
    .all(runId)
    .map((r) => ({
      id: r.id,
      gate: r.gate,
      action: r.action,
      baseCandidateId: r.base_candidate_id,
      appliedSuggestionIds: P(r.applied_suggestion_ids, []),
      note: r.note,
      actor: r.actor,
      createdAt: r.created_at,
    }));
}

// ── Executions (code_plan only) ──────────────────────────────────────────────────────────

export function insertExecution(e) {
  const id = e.id ?? newId('exec');
  getDb().prepare(`
    INSERT INTO executions (id, run_id, plan_candidate_id, sandbox_runtime, workspace_path,
      branch_name, base_branch, repository, fork_detected, upstream_repo,
      tests_passed, tests_total, coverage_pct, tests_measured, secret_findings, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, e.runId, e.planCandidateId, e.sandboxRuntime, e.workspacePath,
    e.branchName, e.baseBranch, e.repository, e.forkDetected ? 1 : 0, e.upstreamRepo ?? null,
    // FR-EXE-003: NULL, not 0. "not measured" is the honest value when no test run happened.
    e.testsMeasured ? e.testsPassed : null,
    e.testsMeasured ? e.testsTotal : null,
    e.testsMeasured ? e.coveragePct : null,
    e.testsMeasured ? 1 : 0,
    J(e.secretFindings ?? []), e.status, now()
  );
  for (const [i, f] of (e.fileChanges ?? []).entries()) {
    getDb().prepare(`
      INSERT INTO file_changes (execution_id, path, op, lines_added, lines_removed, before_body, after_body, ordinal)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, f.path, f.op, f.linesAdded, f.linesRemoved, f.beforeBody ?? null, f.afterBody, i);
  }
  return getExecution(e.runId);
}

export function getExecution(runId) {
  const row = getDb().prepare('SELECT * FROM executions WHERE run_id = ?').get(runId);
  if (!row) return null;
  const files = getDb()
    .prepare('SELECT * FROM file_changes WHERE execution_id = ? ORDER BY ordinal')
    .all(row.id)
    .map((f) => ({
      path: f.path,
      op: f.op,
      linesAdded: f.lines_added,
      linesRemoved: f.lines_removed,
      beforeBody: f.before_body,
      afterBody: f.after_body,
    }));
  return {
    id: row.id,
    runId: row.run_id,
    planCandidateId: row.plan_candidate_id,
    sandboxRuntime: row.sandbox_runtime,
    workspacePath: row.workspace_path,
    branchName: row.branch_name,
    baseBranch: row.base_branch,
    repository: row.repository,
    forkDetected: !!row.fork_detected,
    upstreamRepo: row.upstream_repo,
    testsMeasured: !!row.tests_measured,
    testsPassed: row.tests_passed,
    testsTotal: row.tests_total,
    coveragePct: row.coverage_pct,
    secretFindings: P(row.secret_findings, []),
    status: row.status,
    files,
    filesChanged: files.length,
    linesAdded: files.reduce((a, f) => a + f.linesAdded, 0),
    linesRemoved: files.reduce((a, f) => a + f.linesRemoved, 0),
    createdAt: row.created_at,
  };
}

/** FR-COUNCIL-007: `executing` runs EXACTLY ONCE per run. A re-run requires a new run ID. */
export function hasExecution(runId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM executions WHERE run_id = ?').get(runId).n > 0;
}
