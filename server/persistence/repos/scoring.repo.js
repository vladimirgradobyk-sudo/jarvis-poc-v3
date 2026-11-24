// Scorecards and section scores — gate G4, the accuracy instrument.
//
// This productises the pilot architect's hand-maintained 25-row Confluence table
// (HLD Section · Manual Effort · Agent Output Quality · Architect Refactoring · Agent Savings),
// which concluded "Overall time savings is approximately 75%". It is the only place quality is
// actually measured, and it is DELIBERATELY EFFORTFUL so reviewers cannot skim.

import { getDb, newId, now } from '../db.js';

export function createScorecard({ runId, candidateId, template }) {
  const id = newId('sc');
  getDb().prepare(`
    INSERT INTO scorecards (id, run_id, candidate_id, template_id, template_version, status, created_at)
    VALUES (?,?,?,?,?,'in_progress',?)
  `).run(id, runId, candidateId, template.id, template.version, now());

  // Rows are generated from the template version's SCORABLE sections only.
  const scorable = template.sections.filter((s) => s.scorable);
  for (const [i, s] of scorable.entries()) {
    getDb().prepare(
      'INSERT INTO section_scores (scorecard_id, section_id, heading, ordinal) VALUES (?,?,?,?)'
    ).run(id, s.id, s.heading, i);
  }
  return getScorecard(id);
}

export function getScorecard(id) {
  const row = getDb().prepare('SELECT * FROM scorecards WHERE id = ?').get(id);
  if (!row) return null;
  const rows = getDb()
    .prepare('SELECT * FROM section_scores WHERE scorecard_id = ? ORDER BY ordinal')
    .all(id)
    .map((r) => ({
      sectionId: r.section_id,
      heading: r.heading,
      ordinal: r.ordinal,
      verdict: r.verdict,
      manualEffortHours: r.manual_effort_hours,
      reworkHours: r.rework_hours,
      accuracyPercent: r.accuracy_percent,
      effortSavedPercent: r.effort_saved_percent,
      findings: r.findings,
      actor: r.actor,
      scoredAt: r.scored_at,
      scored: r.scored_at !== null,
    }));
  return {
    id: row.id,
    runId: row.run_id,
    candidateId: row.candidate_id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    status: row.status,
    actor: row.actor,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    rows,
    ...aggregate(rows),
  };
}

export function getScorecardForRun(runId) {
  const row = getDb()
    .prepare('SELECT id FROM scorecards WHERE run_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(runId);
  return row ? getScorecard(row.id) : null;
}

/**
 * FR-API-030: every aggregate is computed SERVER-side. A request supplying effortSavedPercent
 * or any aggregate is rejected by the route — the client cannot assert its own savings figure.
 */
function aggregate(rows) {
  const scored = rows.filter((r) => r.scored);
  const totalRows = rows.length;
  const scoredRows = scored.length;
  if (scoredRows === 0) {
    return { scoredRows: 0, totalRows, aggregateAccuracy: null, aggregateEffortSavedPercent: null,
             totalManualHours: 0, totalReworkHours: 0, complete: totalRows === 0 };
  }
  const manual = scored.reduce((a, r) => a + (r.manualEffortHours ?? 0), 0);
  const rework = scored.reduce((a, r) => a + (r.reworkHours ?? 0), 0);
  const accuracy = scored.reduce((a, r) => a + (r.accuracyPercent ?? 0), 0) / scoredRows;
  return {
    scoredRows,
    totalRows,
    aggregateAccuracy: round1(accuracy),
    // Aggregate saving is computed from the TOTALS, not as a mean of per-row percentages —
    // averaging percentages would let a 0.5-hour section outweigh a 6-hour one.
    aggregateEffortSavedPercent: manual > 0 ? round1(((manual - rework) / manual) * 100) : null,
    totalManualHours: round1(manual),
    totalReworkHours: round1(rework),
    complete: scoredRows === totalRows,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

export function scoreSection(scorecardId, sectionId, input, actor) {
  const existing = getDb()
    .prepare('SELECT * FROM section_scores WHERE scorecard_id = ? AND section_id = ?')
    .get(scorecardId, sectionId);
  // FR-API-031: reject scoring a section not present in this scorecard's template version.
  if (!existing) return { error: 'section_not_in_scorecard' };

  const card = getDb().prepare('SELECT status FROM scorecards WHERE id = ?').get(scorecardId);
  // FR-API-032: a complete scorecard is immutable. A correction creates a NEW scorecard.
  if (card?.status === 'complete') return { error: 'scorecard_complete' };

  const manual = Number(input.manualEffortHours);
  const rework = Number(input.reworkHours);
  const effortSaved = manual > 0 ? round1(((manual - rework) / manual) * 100) : null;

  getDb().prepare(`
    UPDATE section_scores
       SET verdict = ?, manual_effort_hours = ?, rework_hours = ?, accuracy_percent = ?,
           effort_saved_percent = ?, findings = ?, actor = ?, scored_at = ?
     WHERE scorecard_id = ? AND section_id = ?
  `).run(
    input.verdict, manual, rework, Number(input.accuracyPercent),
    effortSaved, input.findings ?? null, actor, now(), scorecardId, sectionId
  );
  return { ok: true };
}

/** Freeze. Rejects while any row is unscored — FR-SCORE-001 is enforced here, not in the UI. */
export function completeScorecard(scorecardId, actor) {
  const card = getScorecard(scorecardId);
  if (!card) return { error: 'not_found' };
  if (!card.complete) {
    return {
      error: 'scorecard_incomplete',
      detail: {
        scoredRows: card.scoredRows,
        totalRows: card.totalRows,
        unscored: card.rows.filter((r) => !r.scored).map((r) => ({ sectionId: r.sectionId, heading: r.heading })),
      },
    };
  }
  getDb()
    .prepare(`UPDATE scorecards SET status = 'complete', actor = ?, completed_at = ? WHERE id = ?`)
    .run(actor, now(), scorecardId);
  return { ok: true, scorecard: getScorecard(scorecardId) };
}

/** FR-SCORE-004/005: accuracy trends per skill, model and template version. */
export function accuracyBySkill() {
  return getDb().prepare(`
    SELECT r.skill_id AS skillId,
           COUNT(DISTINCT sc.id) AS scorecards,
           ROUND(AVG(ss.accuracy_percent), 1) AS meanAccuracy,
           ROUND(AVG(ss.effort_saved_percent), 1) AS meanEffortSaved
      FROM scorecards sc
      JOIN runs r ON r.id = sc.run_id
      JOIN section_scores ss ON ss.scorecard_id = sc.id AND ss.scored_at IS NOT NULL
     GROUP BY r.skill_id
     ORDER BY r.skill_id
  `).all();
}
