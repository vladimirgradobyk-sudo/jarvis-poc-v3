// Cost ledger (WP-13). The unit of record is the Copilot PREMIUM REQUEST (AM-04 / DEC-19):
//   premiumRequests = Σ over calls ( model.premiumRequestMultiplier )
// Raw tokens are metered and capped in addition, because an inflated context is the other way
// to spend without noticing.
//
// The ledger is a first-class table rather than a derived report, so every usage view in the
// admin console reconciles to ONE total (FR-ADMIN-002).

import { getDb, now } from '../db.js';

export function recordCost(entry) {
  getDb().prepare(`
    INSERT INTO cost_records (run_id, phase, role, profile_id, resolved_model,
      model_display_name, model_family, multiplier, calls, input_tokens, output_tokens,
      premium_requests, actor, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    entry.runId, entry.phase, entry.role, entry.profileId ?? null, entry.resolvedModel,
    entry.modelDisplayName, entry.modelFamily, entry.multiplier, entry.calls,
    entry.inputTokens, entry.outputTokens, entry.premiumRequests, entry.actor, now()
  );
}

export function runCost(runId) {
  const rows = getDb()
    .prepare('SELECT * FROM cost_records WHERE run_id = ? ORDER BY id')
    .all(runId)
    .map((r) => ({
      phase: r.phase,
      role: r.role,
      profileId: r.profile_id,
      resolvedModel: r.resolved_model,
      modelDisplayName: r.model_display_name,
      modelFamily: r.model_family,
      multiplier: r.multiplier,
      calls: r.calls,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      premiumRequests: r.premium_requests,
    }));

  const total = {
    calls: rows.reduce((a, r) => a + r.calls, 0),
    inputTokens: rows.reduce((a, r) => a + r.inputTokens, 0),
    outputTokens: rows.reduce((a, r) => a + r.outputTokens, 0),
    premiumRequests: round2(rows.reduce((a, r) => a + r.premiumRequests, 0)),
  };
  total.totalTokens = total.inputTokens + total.outputTokens;

  const byPhase = {};
  for (const r of rows) {
    byPhase[r.phase] ??= { premiumRequests: 0, tokens: 0, calls: 0 };
    byPhase[r.phase].premiumRequests = round2(byPhase[r.phase].premiumRequests + r.premiumRequests);
    byPhase[r.phase].tokens += r.inputTokens + r.outputTokens;
    byPhase[r.phase].calls += r.calls;
  }
  return { rows, total, byPhase };
}

/** Premium requests and tokens consumed so far by this run — the mid-run guard reads this. */
export function runConsumption(runId) {
  const r = getDb().prepare(`
    SELECT COALESCE(SUM(premium_requests),0) AS pr,
           COALESCE(SUM(input_tokens + output_tokens),0) AS tk
      FROM cost_records WHERE run_id = ?
  `).get(runId);
  return { premiumRequests: round2(r.pr), tokens: r.tk };
}

/** Today's consumption for one actor. Budget period is the UTC day (DEC-19). */
export function dailyConsumption(actor, dayIso = todayUtc()) {
  const r = getDb().prepare(`
    SELECT COALESCE(SUM(premium_requests),0) AS pr,
           COALESCE(SUM(input_tokens + output_tokens),0) AS tk,
           COUNT(DISTINCT run_id) AS runs
      FROM cost_records
     WHERE actor = ? AND substr(created_at, 1, 10) = ?
  `).get(actor, dayIso);
  return { premiumRequests: round2(r.pr), tokens: r.tk, runs: r.runs, day: dayIso };
}

export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/** FR-ADMIN-002: the ledger totals every admin tab must agree with. */
export function ledgerSummary({ from = null, to = null } = {}) {
  const where = [];
  const args = [];
  if (from) { where.push('substr(created_at,1,10) >= ?'); args.push(from); }
  if (to) { where.push('substr(created_at,1,10) <= ?'); args.push(to); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const totals = getDb().prepare(`
    SELECT COALESCE(SUM(premium_requests),0) AS premiumRequests,
           COALESCE(SUM(input_tokens),0) AS inputTokens,
           COALESCE(SUM(output_tokens),0) AS outputTokens,
           COALESCE(SUM(calls),0) AS calls,
           COUNT(DISTINCT run_id) AS runs
      FROM cost_records${w}
  `).get(...args);

  const group = (col) => getDb().prepare(`
    SELECT ${col} AS key,
           ROUND(SUM(premium_requests),2) AS premiumRequests,
           SUM(input_tokens + output_tokens) AS tokens,
           COUNT(DISTINCT run_id) AS runs
      FROM cost_records${w}
     GROUP BY ${col} ORDER BY premiumRequests DESC
  `).all(...args);

  // Qualify the date predicate against the aliased table rather than string-rewriting it.
  const whereC = where.map((x) => x.replace('created_at', 'c.created_at'));
  const bySkill = getDb().prepare(`
    SELECT r.skill_id AS key,
           ROUND(SUM(c.premium_requests),2) AS premiumRequests,
           SUM(c.input_tokens + c.output_tokens) AS tokens,
           COUNT(DISTINCT c.run_id) AS runs
      FROM cost_records c JOIN runs r ON r.id = c.run_id
      ${whereC.length ? `WHERE ${whereC.join(' AND ')}` : ''}
     GROUP BY r.skill_id ORDER BY premiumRequests DESC
  `).all(...args);

  const byDay = getDb().prepare(`
    SELECT substr(created_at,1,10) AS key,
           ROUND(SUM(premium_requests),2) AS premiumRequests,
           SUM(input_tokens + output_tokens) AS tokens,
           COUNT(DISTINCT run_id) AS runs
      FROM cost_records${w}
     GROUP BY key ORDER BY key
  `).all(...args);

  return {
    totals: { ...totals, premiumRequests: round2(totals.premiumRequests),
              totalTokens: totals.inputTokens + totals.outputTokens },
    byPhase: group('phase'),
    byModelFamily: group('model_family'),
    byModel: group('model_display_name'),
    bySkill,
    byDay,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
