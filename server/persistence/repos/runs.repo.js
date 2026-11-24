// Runs and the append-only event log.

import { getDb, newId, now } from '../db.js';

const J = JSON.stringify;
const P = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function createRun(r) {
  const id = r.id ?? newId('run');
  const ts = now();
  getDb().prepare(`
    INSERT INTO runs (id, title, skill_id, agent_id, stage_id, artifact_kind, epic_ref,
      state, current_phase, phases, captain_mode, captain_model, scorecard_enabled, degraded, config_hash, transport,
      inputs, writer_selection, estimate, created_by, created_at, updated_at, supersedes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?)
  `).run(
    id, r.title, r.skillId, r.agentId, r.stageId, r.artifactKind, r.epicRef ?? null,
    r.state ?? 'created', r.currentPhase ?? 'configure', J(r.phases), r.captainMode ?? null, r.captainModel ?? null,
    r.scorecardEnabled == null ? null : (r.scorecardEnabled ? 1 : 0),
    r.configHash, r.transport, J(r.inputs), J(r.writerSelection), r.estimate ? J(r.estimate) : null,
    r.createdBy, ts, ts, r.supersedes ?? null
  );
  return getRun(id);
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    skillId: row.skill_id,
    agentId: row.agent_id,
    stageId: row.stage_id,
    artifactKind: row.artifact_kind,
    epicRef: row.epic_ref,
    state: row.state,
    currentPhase: row.current_phase,
    phases: P(row.phases, []),
    captainMode: row.captain_mode,
    captainModel: row.captain_model,
    scorecardEnabled: row.scorecard_enabled == null ? null : !!row.scorecard_enabled,
    degraded: !!row.degraded,
    degradedReason: row.degraded_reason,
    configHash: row.config_hash,
    transport: row.transport,
    inputs: P(row.inputs, {}),
    writerSelection: P(row.writer_selection, []),
    estimate: P(row.estimate),
    qualityScore: row.quality_score,
    qualityOverrideReason: row.quality_override_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    supersedes: row.supersedes,
  };
}

export function getRun(id) {
  return hydrate(getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id));
}

export function listRuns({ limit = 50, state = null, epicRef = null, skillId = null } = {}) {
  const where = [];
  const args = [];
  if (state) { where.push('state = ?'); args.push(state); }
  if (epicRef) { where.push('epic_ref = ?'); args.push(epicRef); }
  if (skillId) { where.push('skill_id = ?'); args.push(skillId); }
  const sql =
    'SELECT * FROM runs' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY created_at DESC LIMIT ?';
  args.push(limit);
  return getDb().prepare(sql).all(...args).map(hydrate);
}

/**
 * FR-COUNCIL-001: a run persists its state after EVERY phase transition and EVERY writer
 * settlement, so a server restart loses no completed work (NFR-REL-003).
 */
export function updateRun(id, patch) {
  const map = {
    state: 'state',
    currentPhase: 'current_phase',
    captainMode: 'captain_mode',
    captainModel: 'captain_model',
    writerSelection: 'writer_selection',
    phases: 'phases',
    degraded: 'degraded',
    degradedReason: 'degraded_reason',
    estimate: 'estimate',
    qualityScore: 'quality_score',
    qualityOverrideReason: 'quality_override_reason',
    completedAt: 'completed_at',
  };
  const sets = ['updated_at = ?'];
  const args = [now()];
  for (const [k, col] of Object.entries(map)) {
    if (!(k in patch)) continue;
    sets.push(`${col} = ?`);
    let v = patch[k];
    if (k === 'degraded') v = v ? 1 : 0;
    if ((k === 'estimate' || k === 'writerSelection' || k === 'phases') && v && typeof v === 'object') v = J(v);
    args.push(v ?? null);
  }
  args.push(id);
  getDb().prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getRun(id);
}

// ── Event log ────────────────────────────────────────────────────────────────────────────

/**
 * Append one event. Returns the assigned monotonic `seq`, which the SSE layer emits as the
 * event id so a reconnecting client can replay from its last-seen value (FR-API-020/021).
 *
 * FR-EVT-004: `writer.token` is transport-only and is rejected here — persisting per-token
 * deltas would bloat storage without adding audit value, since the candidate text is stored.
 */
export function appendEvent(runId, type, payload = {}) {
  if (type === 'writer.token') {
    throw new Error('writer.token is transport-only and must not be persisted (FR-EVT-004).');
  }
  const ts = now();
  const info = getDb()
    .prepare('INSERT INTO run_events (run_id, type, payload, created_at) VALUES (?,?,?,?)')
    .run(runId, type, J(payload), ts);
  return { seq: Number(info.lastInsertRowid), runId, type, payload, createdAt: ts };
}

export function listEvents(runId, sinceSeq = 0, limit = 5000) {
  return getDb()
    .prepare('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
    .all(runId, sinceSeq, limit)
    .map((r) => ({ seq: r.seq, runId: r.run_id, type: r.type, payload: P(r.payload, {}), createdAt: r.created_at }));
}

/** All events across all runs since a sequence — the session stream's replay source. */
export function listEventsSince(sinceSeq = 0, limit = 5000) {
  return getDb()
    .prepare('SELECT * FROM run_events WHERE seq > ? ORDER BY seq LIMIT ?')
    .all(sinceSeq, limit)
    .map((r) => ({ seq: r.seq, runId: r.run_id, type: r.type, payload: P(r.payload, {}), createdAt: r.created_at }));
}

export function maxSeq() {
  return getDb().prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM run_events').get().s;
}

/**
 * FR-NAV-007: run titles are generated SERVER-SIDE, are human-readable, and never expose a raw
 * prompt, agent ID or template fragment. The pilot rendered every row as literally "New Chat"
 * and, where titles existed, leaked internals like `[AGENT] # QE Strategy Agent > **`.
 * Not generated by a model — it must be deterministic and cheap.
 */
export function generateRunTitle(skillName, inputs) {
  const subjectKeys = ['epicUrl', 'storyKey', 'ideaSource', 'jiraProject', 'proposalRef'];
  for (const k of subjectKeys) {
    const v = inputs?.[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    let subject = v.trim();
    // A Jira-style key, used verbatim.
    const key = subject.match(/[A-Z][A-Z0-9]+-\d+/);
    if (key) return `${skillName} · ${key[0]}`;
    // Otherwise the first clause, truncated on a word boundary.
    subject = subject.split(/[\n.;|]/)[0].trim();
    if (subject.length > 48) subject = subject.slice(0, 45).replace(/\s+\S*$/, '') + '…';
    if (subject) return `${skillName} · ${subject}`;
  }
  return skillName;
}
