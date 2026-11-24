// Proposals, approvals, publish results, provenance — gate G5.
//
// The whole point of this module: no write reaches an external system without a CURRENT,
// EXPLICIT, SINGLE-USE approval bound to the exact version and operation reviewed
// (FR-APPROVE-001, FR-API-040/041/042, RCR-STALE-001).

import { getDb, newId, now } from '../db.js';
import { createHash } from 'node:crypto';

const J = JSON.stringify;
const P = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ── Proposals ────────────────────────────────────────────────────────────────────────────

export function nextProposalVersion(runId) {
  const r = getDb().prepare('SELECT COALESCE(MAX(version),0) AS v FROM proposals WHERE run_id = ?').get(runId);
  return r.v + 1;
}

/**
 * The fingerprint covers everything a human sees on the approval screen: operation, targets and
 * the exact content hash. Approving v1 of a proposal then editing the candidate changes the
 * fingerprint, so the stored approval no longer matches and the publish is refused.
 */
export function computeFingerprint({ operation, targets, candidateBody }) {
  return 'sha256:' + createHash('sha256')
    .update(J({ operation, targets, body: candidateBody }))
    .digest('hex')
    .slice(0, 16);
}

export function insertProposal(p) {
  const id = newId('prop');
  // Any earlier open proposal for this run is superseded — only one may be live.
  getDb().prepare(
    `UPDATE proposals SET status = 'superseded' WHERE run_id = ? AND status IN ('open','stale')`
  ).run(p.runId);

  getDb().prepare(`
    INSERT INTO proposals (id, run_id, candidate_id, version, operation, status, targets,
      validation_status, validation_findings, stale_check_anchor, operation_fingerprint, created_at)
    VALUES (?,?,?,?,?,'open',?,?,?,?,?,?)
  `).run(
    id, p.runId, p.candidateId, p.version, p.operation, J(p.targets),
    p.validationStatus, J(p.validationFindings ?? []), p.staleCheckAnchor,
    p.operationFingerprint, now()
  );
  return getProposal(id);
}

function hydrateProposal(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    candidateId: row.candidate_id,
    version: row.version,
    operation: row.operation,
    status: row.status,
    targets: P(row.targets, []),
    validationStatus: row.validation_status,
    validationFindings: P(row.validation_findings, []),
    staleCheckAnchor: row.stale_check_anchor,
    operationFingerprint: row.operation_fingerprint,
    createdAt: row.created_at,
  };
}

export function getProposal(id) {
  return hydrateProposal(getDb().prepare('SELECT * FROM proposals WHERE id = ?').get(id));
}

export function getProposalForRun(runId) {
  return hydrateProposal(getDb().prepare(
    `SELECT * FROM proposals WHERE run_id = ? ORDER BY version DESC LIMIT 1`
  ).get(runId));
}

export function setProposalStatus(id, status) {
  getDb().prepare('UPDATE proposals SET status = ? WHERE id = ?').run(status, id);
  return getProposal(id);
}

// ── Approvals ────────────────────────────────────────────────────────────────────────────

export function insertApproval({ proposalId, proposalVersion, operationFingerprint, decision, note, actor }) {
  const id = newId('appr');
  getDb().prepare(`
    INSERT INTO approval_decisions (id, proposal_id, proposal_version, operation_fingerprint,
      decision, note, actor, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, proposalId, proposalVersion, operationFingerprint, decision, note ?? null, actor, now());
  return getApproval(id);
}

function hydrateApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    proposalId: row.proposal_id,
    proposalVersion: row.proposal_version,
    operationFingerprint: row.operation_fingerprint,
    decision: row.decision,
    note: row.note,
    actor: row.actor,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  };
}

export function getApproval(id) {
  return hydrateApproval(getDb().prepare('SELECT * FROM approval_decisions WHERE id = ?').get(id));
}

export function liveApproval(proposalId) {
  return hydrateApproval(getDb().prepare(
    `SELECT * FROM approval_decisions
      WHERE proposal_id = ? AND decision = 'approve' AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`
  ).get(proposalId));
}

/** SINGLE-USE. Consuming is a conditional update, so a concurrent second publish loses. */
export function consumeApproval(id) {
  const info = getDb().prepare(
    'UPDATE approval_decisions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL'
  ).run(now(), id);
  return info.changes === 1;
}

// ── Publish results (idempotency) ────────────────────────────────────────────────────────

/**
 * FR-API-051: a stable per-target idempotency key derived at PROPOSAL time from proposal id,
 * version, target index and a hash of the target descriptor — reused across every attempt.
 */
export function idempotencyKey(proposal, targetIndex) {
  const descriptor = createHash('sha256')
    .update(J(proposal.targets[targetIndex]))
    .digest('hex')
    .slice(0, 12);
  return `pub_${proposal.id}_v${proposal.version}_${targetIndex}_${descriptor}`;
}

/** FR-API-052: a repeat with the same key returns the ORIGINAL result and performs no call. */
export function findSuccessfulResult(idemKey) {
  const row = getDb().prepare(
    'SELECT * FROM publish_results WHERE idempotency_key = ? AND ok = 1 LIMIT 1'
  ).get(idemKey);
  return row ? hydrateResult(row) : null;
}

function hydrateResult(r) {
  return {
    id: r.id,
    proposalId: r.proposal_id,
    approvalId: r.approval_id,
    targetIndex: r.target_index,
    attempt: r.attempt,
    ok: !!r.ok,
    externalId: r.external_id,
    externalUrl: r.external_url,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
  };
}

export function insertResult(res) {
  const id = newId('pres');
  const attempt = getDb().prepare(
    'SELECT COALESCE(MAX(attempt),0)+1 AS a FROM publish_results WHERE proposal_id = ? AND target_index = ?'
  ).get(res.proposalId, res.targetIndex).a;
  getDb().prepare(`
    INSERT INTO publish_results (id, proposal_id, approval_id, target_index, attempt, ok,
      external_id, external_url, error_code, error_message, idempotency_key, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, res.proposalId, res.approvalId, res.targetIndex, attempt, res.ok ? 1 : 0,
    res.externalId ?? null, res.externalUrl ?? null, res.errorCode ?? null,
    res.errorMessage ?? null, res.idempotencyKey, now()
  );
  return { ...res, id, attempt };
}

/** FR-API-056: one row per target per attempt, so history is reconstructable. */
export function listResults(proposalId) {
  return getDb()
    .prepare('SELECT * FROM publish_results WHERE proposal_id = ? ORDER BY target_index, attempt')
    .all(proposalId)
    .map(hydrateResult);
}

/** Latest outcome per target — what the Publish Result screen renders. */
export function latestResults(proposalId) {
  const all = listResults(proposalId);
  const byTarget = new Map();
  for (const r of all) {
    const prev = byTarget.get(r.targetIndex);
    // A success is never overwritten by a later failure: FR-PUBLISH-003 forbids a blanket
    // retry that would duplicate the items that already succeeded.
    if (!prev || (!prev.ok && r.ok) || (prev.ok === r.ok && r.attempt > prev.attempt)) {
      byTarget.set(r.targetIndex, r);
    }
  }
  return [...byTarget.values()].sort((a, b) => a.targetIndex - b.targetIndex);
}

// ── Provenance ───────────────────────────────────────────────────────────────────────────

export function insertProvenance(runId, candidateId, record) {
  const id = newId('prov');
  getDb().prepare(
    'INSERT INTO provenance_records (id, run_id, candidate_id, record, created_at) VALUES (?,?,?,?,?)'
  ).run(id, runId, candidateId, J(record), now());
  return id;
}

export function getProvenance(candidateId) {
  const row = getDb().prepare(
    'SELECT * FROM provenance_records WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(candidateId);
  if (!row) return null;
  return { id: row.id, runId: row.run_id, candidateId: row.candidate_id,
           immutable: !!row.immutable, createdAt: row.created_at, ...P(row.record, {}) };
}

export function getProvenanceForRun(runId) {
  const row = getDb().prepare(
    'SELECT * FROM provenance_records WHERE run_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(runId);
  if (!row) return null;
  return { id: row.id, runId: row.run_id, candidateId: row.candidate_id,
           immutable: !!row.immutable, createdAt: row.created_at, ...P(row.record, {}) };
}

/**
 * FR-PROV-003: provenance becomes immutable on approval.
 *
 * Publication facts are the one exception, and necessarily so: the external ID and URL do not
 * exist until AFTER the approval that authorised the write. Sealing them out would leave every
 * published artifact with an empty `publishedTo`, which is the opposite of provenance. So the
 * seal freezes how the artifact was PRODUCED and DECIDED, and the keys below remain appendable
 * afterwards. Nothing already written is ever overwritten.
 */
const POST_SEAL_KEYS = new Set(['publishedTo', 'approvedBy', 'approvedAt']);

export function sealProvenance(runId, patch) {
  const row = getDb().prepare(
    'SELECT * FROM provenance_records WHERE run_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(runId);
  if (!row) return;

  const current = P(row.record, {});
  if (row.immutable) {
    // Only publication facts may be added once sealed, and only where not already present.
    const allowed = {};
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (!POST_SEAL_KEYS.has(k)) continue;
      const existing = current[k];
      const isEmpty = existing === undefined || existing === null ||
                      (Array.isArray(existing) && existing.length === 0);
      if (isEmpty) allowed[k] = v;
    }
    if (Object.keys(allowed).length === 0) return;
    getDb().prepare('UPDATE provenance_records SET record = ? WHERE id = ?')
      .run(J({ ...current, ...allowed }), row.id);
    return;
  }

  getDb().prepare('UPDATE provenance_records SET record = ?, immutable = 1 WHERE id = ?')
    .run(J({ ...current, ...patch }), row.id);
}

export function patchProvenance(runId, patch) {
  const row = getDb().prepare(
    'SELECT * FROM provenance_records WHERE run_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(runId);
  if (!row || row.immutable) return;
  getDb().prepare('UPDATE provenance_records SET record = ? WHERE id = ?')
    .run(J({ ...P(row.record, {}), ...patch }), row.id);
}
