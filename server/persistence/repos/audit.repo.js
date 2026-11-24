// Audit log (NFR-OBS-001). Content-free by construction: this module has no parameter for
// prompt text or source content, so there is no path by which they could be written.

import { getDb, newId, now } from '../db.js';

export function audit({ category, action, outcome, runId = null, proposalId = null,
                        reasonCode = null, requirementId = null, correlationId, actor }) {
  const id = newId('aud');
  getDb().prepare(`
    INSERT INTO audit_events (id, category, action, run_id, proposal_id, outcome,
      reason_code, requirement_id, correlation_id, actor, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, category, action, runId, proposalId, outcome, reasonCode, requirementId,
         correlationId ?? 'none', actor, now());
  return id;
}

export function listAudit({ category = null, outcome = null, runId = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (category) { where.push('category = ?'); args.push(category); }
  if (outcome) { where.push('outcome = ?'); args.push(outcome); }
  if (runId) { where.push('run_id = ?'); args.push(runId); }
  const sql = 'SELECT * FROM audit_events' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY created_at DESC, id DESC LIMIT ?';
  args.push(limit);
  return getDb().prepare(sql).all(...args).map((r) => ({
    id: r.id,
    category: r.category,
    action: r.action,
    runId: r.run_id,
    proposalId: r.proposal_id,
    outcome: r.outcome,
    reasonCode: r.reason_code,
    requirementId: r.requirement_id,
    correlationId: r.correlation_id,
    actor: r.actor,
    createdAt: r.created_at,
  }));
}

/** Count of writes performed WITHOUT an approval. This must always be zero (BR-001, AC 3). */
export function blockedWriteCount() {
  return getDb().prepare(
    `SELECT COUNT(*) AS n FROM audit_events WHERE category = 'apply' AND outcome = 'blocked'`
  ).get().n;
}
