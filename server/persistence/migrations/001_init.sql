-- JARVIS PoC schema. Follows data-model.md §9 with the PoC's reduced entity set.
--
-- Immutability rules (data-model §10.1) are enforced by triggers, not by convention:
--   run_events        append-only, never updated or deleted
--   reviews           immutable once written
--   approval_decisions immutable; single-use via consumed_at
--   provenance_records immutable once the artifact is approved

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Runs
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,          -- FR-NAV-007: generated server-side, human-readable
  skill_id          TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  stage_id          TEXT NOT NULL,
  artifact_kind     TEXT NOT NULL,
  epic_ref          TEXT,
  state             TEXT NOT NULL,
  current_phase     TEXT NOT NULL,
  phases            TEXT NOT NULL,          -- JSON array, the skill's declared phase sequence
  captain_mode      TEXT,
  degraded          INTEGER NOT NULL DEFAULT 0,
  degraded_reason   TEXT,
  config_hash       TEXT NOT NULL,
  transport         TEXT NOT NULL,
  inputs            TEXT NOT NULL,          -- JSON, redacted at the boundary
  writer_selection  TEXT NOT NULL,          -- JSON: [{profileId, logicalModel, resolvedModel, family, displayName}]
  estimate          TEXT,                   -- JSON CostEstimate, recorded before generate (FR-COST-001)
  quality_score     INTEGER,                -- DEC-27, advisory
  quality_override_reason TEXT,
  created_by        TEXT NOT NULL,          -- actor = OS user (FR-API-011, DEC-08)
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,
  supersedes        TEXT REFERENCES runs(id)
);
CREATE INDEX idx_runs_state     ON runs(state);
CREATE INDEX idx_runs_created   ON runs(created_at DESC);
CREATE INDEX idx_runs_epic      ON runs(epic_ref);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Candidates, reviews, verdicts
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE candidates (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  writer_profile_id TEXT NOT NULL,
  writer_display_name TEXT NOT NULL,
  resolved_model  TEXT NOT NULL,
  model_display_name TEXT NOT NULL,         -- FR-MODEL-003: canonical, never disagrees with resolved
  model_family    TEXT NOT NULL,
  origin          TEXT NOT NULL,            -- 'writer' | 'synthesis' | 'human_edit'
  derived_from    TEXT REFERENCES candidates(id),
  body            TEXT NOT NULL,
  sections        TEXT NOT NULL,            -- JSON [{id, heading, body, sourceCandidateId?}]
  word_count      INTEGER NOT NULL,
  incomplete      INTEGER NOT NULL DEFAULT 0,  -- FR-COUNCIL-005: partial after cancellation
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  premium_requests REAL NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_candidates_run ON candidates(run_id);

-- FR-GEN-005: unresolved placeholders are detected, counted, and BLOCK publication.
CREATE TABLE candidate_placeholders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  section_id   TEXT NOT NULL,
  section_heading TEXT NOT NULL,
  text         TEXT NOT NULL
);
CREATE INDEX idx_placeholders_candidate ON candidate_placeholders(candidate_id);

CREATE TABLE candidate_citations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  section_id   TEXT NOT NULL,
  source_label TEXT NOT NULL
);

-- N writers produce exactly N² reviews (FR-REV-001). Self-reviews are FLAGGED, not inferred.
CREATE TABLE reviews (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  evaluator_profile_id TEXT NOT NULL,
  evaluator_display_name TEXT NOT NULL,
  candidate_id   TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  is_self        INTEGER NOT NULL,          -- FR-REV-003
  overall_score  INTEGER NOT NULL,
  criterion_scores TEXT NOT NULL,           -- JSON {criterionId: score}
  strengths      TEXT NOT NULL,             -- JSON string[]
  concerns       TEXT NOT NULL,             -- JSON string[]
  feedback       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (run_id, evaluator_profile_id, candidate_id)
);
CREATE INDEX idx_reviews_run ON reviews(run_id);

CREATE TABLE verdicts (
  id                   TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  winner_candidate_id  TEXT NOT NULL REFERENCES candidates(id),
  captain_profile_id   TEXT NOT NULL,
  captain_mode         TEXT NOT NULL,       -- FR-COUNCIL-010: recorded; a verdict is uninterpretable without it
  resolved_model       TEXT NOT NULL,
  model_display_name   TEXT NOT NULL,
  rationale            TEXT NOT NULL,
  full_analysis        TEXT NOT NULL,       -- FR-ADJ-003: full prose, not a summary line
  no_verdict           INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL
);

-- FR-ADJ-002: EVERY suggestion is attributed to its source candidate. An unattributed
-- suggestion is not actionable, so source_candidate_id is NOT NULL.
CREATE TABLE suggestions (
  id                  TEXT PRIMARY KEY,
  verdict_id          TEXT NOT NULL REFERENCES verdicts(id) ON DELETE CASCADE,
  source_candidate_id TEXT NOT NULL REFERENCES candidates(id),
  source_label        TEXT NOT NULL,        -- 'From Document 1'
  target_section_id   TEXT,
  text                TEXT NOT NULL,
  ordinal             INTEGER NOT NULL
);
CREATE INDEX idx_suggestions_verdict ON suggestions(verdict_id);

-- FR-COUNCIL-008: no transition out of awaiting_human without a recorded actor + timestamp.
CREATE TABLE human_decisions (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  gate           TEXT NOT NULL,             -- 'G2' | 'G3'
  action         TEXT NOT NULL,
  base_candidate_id TEXT REFERENCES candidates(id),
  applied_suggestion_ids TEXT NOT NULL,     -- JSON string[]
  note           TEXT,
  actor          TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_decisions_run ON human_decisions(run_id);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Code execution
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE executions (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  plan_candidate_id TEXT NOT NULL REFERENCES candidates(id),
  sandbox_runtime TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  branch_name    TEXT NOT NULL,
  base_branch    TEXT NOT NULL,
  repository     TEXT NOT NULL,
  fork_detected  INTEGER NOT NULL DEFAULT 0,
  upstream_repo  TEXT,
  -- FR-EXE-003: NULL means "not measured". Never 0/0 as a default — a counter that
  -- contradicts the visible diff costs more trust than no counter.
  tests_passed   INTEGER,
  tests_total    INTEGER,
  coverage_pct   REAL,
  tests_measured INTEGER NOT NULL DEFAULT 0,
  secret_findings TEXT NOT NULL DEFAULT '[]',  -- JSON; non-empty BLOCKS the proposal (NFR-SEC-007)
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE file_changes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  op           TEXT NOT NULL,              -- 'add' | 'modify'
  lines_added  INTEGER NOT NULL,
  lines_removed INTEGER NOT NULL,
  before_body  TEXT,
  after_body   TEXT NOT NULL,
  ordinal      INTEGER NOT NULL
);
CREATE INDEX idx_filechanges_exec ON file_changes(execution_id);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Scoring — the accuracy instrument (gate G4)
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE scorecards (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  candidate_id  TEXT NOT NULL REFERENCES candidates(id),
  template_id   TEXT NOT NULL,
  template_version TEXT NOT NULL,
  status        TEXT NOT NULL,             -- 'in_progress' | 'complete'
  actor         TEXT,
  completed_at  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_scorecards_run ON scorecards(run_id);

CREATE TABLE section_scores (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scorecard_id    TEXT NOT NULL REFERENCES scorecards(id) ON DELETE CASCADE,
  section_id      TEXT NOT NULL,
  heading         TEXT NOT NULL,
  ordinal         INTEGER NOT NULL,
  -- NULL until a human scores it. FR-SCORE-006: no auto-fill, no inference, no apply-to-all.
  verdict         TEXT,                    -- 'accurate'|'minor_rework'|'major_rework'|'unusable'
  manual_effort_hours REAL,
  rework_hours    REAL,
  accuracy_percent INTEGER,
  effort_saved_percent REAL,               -- computed SERVER-side only (FR-API-030)
  findings        TEXT,
  actor           TEXT,
  scored_at       TEXT,
  UNIQUE (scorecard_id, section_id)
);
CREATE INDEX idx_sectionscores_card ON section_scores(scorecard_id);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Proposals, approvals, publication (gate G5)
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE proposals (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  candidate_id   TEXT NOT NULL REFERENCES candidates(id),
  version        INTEGER NOT NULL,
  operation      TEXT NOT NULL,            -- 'create' | 'update' | 'pr'
  status         TEXT NOT NULL,            -- 'open'|'approved'|'applied'|'rejected'|'stale'|'superseded'
  targets        TEXT NOT NULL,            -- JSON PublishTarget[]
  validation_status TEXT NOT NULL,
  validation_findings TEXT NOT NULL,       -- JSON
  -- RCR-STALE-001: the anchor is re-verified immediately before apply, not only at approval.
  stale_check_anchor TEXT NOT NULL,
  -- FR-API-040: approval binds to BOTH version and fingerprint, so you cannot approve
  -- something other than what the client displayed.
  operation_fingerprint TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (run_id, version)
);
CREATE INDEX idx_proposals_run ON proposals(run_id);

CREATE TABLE approval_decisions (
  id               TEXT PRIMARY KEY,
  proposal_id      TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  proposal_version INTEGER NOT NULL,
  operation_fingerprint TEXT NOT NULL,
  decision         TEXT NOT NULL,          -- 'approve' | 'reject'
  note             TEXT,
  actor            TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  consumed_at      TEXT                    -- SINGLE-USE. Non-null = already spent.
);
CREATE INDEX idx_approvals_proposal ON approval_decisions(proposal_id);
-- FR-API-042: at most ONE live unconsumed approval per proposal version.
CREATE UNIQUE INDEX idx_approvals_one_live
  ON approval_decisions(proposal_id, proposal_version)
  WHERE consumed_at IS NULL AND decision = 'approve';

CREATE TABLE publish_results (
  id            TEXT PRIMARY KEY,
  proposal_id   TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  approval_id   TEXT NOT NULL REFERENCES approval_decisions(id),
  target_index  INTEGER NOT NULL,
  attempt       INTEGER NOT NULL,
  ok            INTEGER NOT NULL,
  external_id   TEXT,
  external_url  TEXT,
  error_code    TEXT,
  error_message TEXT,
  idempotency_key TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_publishresults_proposal ON publish_results(proposal_id);
-- FR-API-051/052: one stored result per idempotency key. A replay returns the ORIGINAL result
-- and performs no external call, so a retry can never create a second page or issue.
CREATE UNIQUE INDEX idx_publishresults_idem ON publish_results(idempotency_key) WHERE ok = 1;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Provenance, events, cost, audit
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE provenance_records (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  candidate_id  TEXT NOT NULL REFERENCES candidates(id),
  record        TEXT NOT NULL,             -- JSON ProvenanceRecord
  immutable     INTEGER NOT NULL DEFAULT 0, -- set 1 on approval (FR-PROV-003)
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_provenance_run ON provenance_records(run_id);

-- APPEND-ONLY. The event stream IS the audit trail and the UI's only source of truth
-- (FR-EVT-003, FR-ARCH-SYS-032). writer.token events are transport-only and never land here
-- (FR-EVT-004).
CREATE TABLE run_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,                -- JSON, redacted; never secrets or PII (FR-EVT-005)
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_run ON run_events(run_id, seq);

CREATE TRIGGER run_events_no_update BEFORE UPDATE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run_events is append-only (FR-EVT-003): events are immutable.');
END;
CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events
WHEN (SELECT COUNT(*) FROM runs WHERE id = OLD.run_id) > 0
BEGIN
  SELECT RAISE(ABORT, 'run_events is append-only (FR-EVT-003): events cannot be deleted.');
END;

CREATE TRIGGER reviews_no_update BEFORE UPDATE ON reviews
BEGIN
  SELECT RAISE(ABORT, 'reviews are immutable (data-model §10.1). A correction is a new run.');
END;

CREATE TRIGGER approvals_immutable BEFORE UPDATE OF decision, actor, operation_fingerprint, proposal_version ON approval_decisions
BEGIN
  SELECT RAISE(ABORT, 'An approval decision is immutable. Only consumed_at may be set.');
END;

-- The cost ledger is a first-class table, not a derived report, so every usage view in the
-- admin console reconciles to ONE total (FR-ADMIN-002).
CREATE TABLE cost_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  phase         TEXT NOT NULL,
  role          TEXT NOT NULL,             -- 'writer' | 'captain' | 'reviewer' | 'synthesis' | 'execute'
  profile_id    TEXT,
  resolved_model TEXT NOT NULL,
  model_display_name TEXT NOT NULL,
  model_family  TEXT NOT NULL,
  multiplier    REAL NOT NULL,
  calls         INTEGER NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  premium_requests REAL NOT NULL,
  actor         TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_cost_run  ON cost_records(run_id);
CREATE INDEX idx_cost_date ON cost_records(created_at);

-- NFR-OBS-001: content-free audit events. NO prompt text, NO source content, NO secrets, NO PII.
CREATE TABLE audit_events (
  id            TEXT PRIMARY KEY,
  category      TEXT NOT NULL,             -- propose|approve|apply|publish|policy|refusal|config
  action        TEXT NOT NULL,
  run_id        TEXT,
  proposal_id   TEXT,
  outcome       TEXT NOT NULL,             -- allowed | blocked | failed
  reason_code   TEXT,
  requirement_id TEXT,
  correlation_id TEXT NOT NULL,
  actor         TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_audit_category ON audit_events(category, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Mock systems of record (PoC only — see docs/DEVIATIONS.md DV-03)
-- Real adapters would write to Confluence DC / Jira / Bitbucket. The CONTRACT is identical:
-- dry-run preview, deterministic idempotency key, stale-check anchor, per-item results.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE mock_confluence_pages (
  id          TEXT PRIMARY KEY,
  space       TEXT NOT NULL,
  parent_id   TEXT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL
);

CREATE TABLE mock_jira_issues (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  issue_type  TEXT NOT NULL,
  summary     TEXT NOT NULL,
  description TEXT NOT NULL,
  assignee    TEXT,
  parent_key  TEXT,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE mock_pull_requests (
  id           TEXT PRIMARY KEY,
  repository   TEXT NOT NULL,
  branch       TEXT NOT NULL,
  base_branch  TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  files_changed INTEGER NOT NULL,
  lines_added  INTEGER NOT NULL,
  lines_removed INTEGER NOT NULL,
  diff         TEXT NOT NULL,
  state        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL
);

INSERT INTO schema_version (version, applied_at) VALUES (1, datetime('now'));
