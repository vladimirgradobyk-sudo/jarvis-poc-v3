// Run state machine (council-engine-spec §5). Legal transitions and the guards that matter.
//
// The engine is artifact-agnostic and agent-agnostic. It knows about phases, writers, rubrics
// and captains — never about PRDs, HLDs, Jira or pull requests. If an `if (skill.id === ...)`
// ever appears in this directory, the engine is under-specified and should be extended instead.

export const STATES = [
  'created', 'queued', 'generating', 'reviewing', 'adjudicating', 'awaiting_human',
  'synthesizing', 'executing', 'scoring', 'approved', 'published', 'cancelled', 'failed',
];

const LEGAL = {
  created:       ['queued', 'generating', 'cancelled', 'failed'],
  queued:        ['generating', 'cancelled', 'failed'],
  // `generating → scoring|approved` is the solo-report path: no review, no verdict, no
  // cherry-pick decision, so there is no gate between generation and G4/G5.
  // `generating → adjudicating` is the single-writer council path: one draft, no peer review, so
  // the Captain reviews it directly without a reviewing phase in between.
  generating:    ['reviewing', 'adjudicating', 'awaiting_human', 'scoring', 'approved', 'cancelled', 'failed'],
  reviewing:     ['adjudicating', 'awaiting_human', 'cancelled', 'failed'],
  adjudicating:  ['awaiting_human', 'cancelled', 'failed'],
  awaiting_human:['synthesizing', 'executing', 'scoring', 'approved', 'adjudicating', 'cancelled', 'failed'],
  synthesizing:  ['executing', 'scoring', 'approved', 'cancelled', 'failed'],
  executing:     ['scoring', 'approved', 'cancelled', 'failed'],
  scoring:       ['approved', 'cancelled', 'failed'],
  approved:      ['published', 'failed', 'cancelled'],
  published:     [],
  cancelled:     [],
  failed:        ['generating', 'reviewing', 'adjudicating', 'awaiting_human'],  // resume
};

export const TERMINAL = new Set(['published', 'cancelled']);

export function canTransition(from, to) {
  return (LEGAL[from] ?? []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal run transition ${from} → ${to}. Legal from "${from}": ${(LEGAL[from] ?? []).join(', ') || 'none (terminal)'}.`);
  }
}

/** FR-COUNCIL-005: cancellation is permitted in ANY non-terminal state. */
export function canCancel(state) {
  return !TERMINAL.has(state);
}

/**
 * Which state a phase runs in, and which state follows. Derived from the skill's DECLARED phase
 * list, so documents (compare → adjudicate) and code plans (adjudicate → execute) both work
 * without the engine knowing which it is handling.
 */
export const PHASE_STATE = {
  generate: 'generating',
  review: 'reviewing',
  adjudicate: 'adjudicating',
};

/**
 * FR-COUNCIL-003: a QUORUM of ≥2 settled candidates is required to enter `reviewing`. With one
 * candidate, skip to `awaiting_human` and mark the run DEGRADED — peer review of a single draft
 * is not review, and pretending otherwise would be the silent degradation the spec forbids.
 */
export const QUORUM = 2;

export function quorumDecision(settledCount, phases) {
  if (settledCount === 0) {
    return { proceed: false, nextState: 'failed', degraded: true,
             reason: 'No drafts were produced.' };
  }
  // The quorum rule exists to describe a COUNCIL that lost writers. A skill configured
  // `writers: 1` with `review` omitted is the designed SOLO case (council-engine-spec §3) — the
  // same engine with phases omitted — and is not degraded. Applying the rule to it would label
  // every report run "degraded" and route it to a human gate with nothing to decide.
  if (!phases.includes('review')) {
    return { proceed: true, degraded: false, solo: true };
  }
  if (settledCount < QUORUM) {
    return {
      proceed: false,
      nextState: 'awaiting_human',
      degraded: true,
      reason: 'Only one draft completed. Peer review and adjudication are skipped.',
      skipped: ['review', 'compare', 'adjudicate'].filter((p) => phases.includes(p)),
    };
  }
  return { proceed: true, degraded: false };
}

/**
 * The status string shown beside a run. This is the SINGLE place one is produced on the server;
 * the client has an equivalent single place in web/lib/reducer.js.
 *
 * FR-HUM-006: the pilot displayed "Captain deliberating…" ABOVE "✓ Verdict ready". Status must
 * derive from run state, never be set independently.
 */
export function statusLabel(run, uiLabels = {}) {
  const phaseLabel = (p) => uiLabels[p] ?? p;
  switch (run.state) {
    case 'created':
    case 'queued':        return 'Queued';
    case 'generating':    return run.artifactKind === 'code_plan' ? 'Generating plans…' : 'Generating documents…';
    case 'reviewing':     return 'Evaluating…';
    case 'adjudicating':  return 'Captain deliberating…';
    case 'awaiting_human':return run.artifactKind === 'code_plan' ? 'Plan ready — choose one' : 'Verdict ready';
    case 'synthesizing':  return 'Building document…';
    case 'executing':     return 'Executing selected plan…';
    case 'scoring':       return 'Awaiting accuracy scoring';
    case 'approved':      return 'Approved — ready to publish';
    case 'published':     return 'Published';
    case 'cancelled':     return 'Cancelled — partial results retained';
    case 'failed':        return run.degradedReason ? `Failed — ${run.degradedReason}` : 'Failed';
    default:              return phaseLabel(run.currentPhase);
  }
}

/** The session-list status dot (screen-specs §1.2). "Awaiting you" is the state that most needs visibility. */
export function statusKind(run) {
  switch (run.state) {
    case 'awaiting_human':
    case 'scoring':
    case 'approved':   return 'awaiting';
    case 'published':  return 'published';
    case 'failed':     return 'failed';
    case 'cancelled':  return 'cancelled';
    default:           return run.degraded ? 'degraded' : 'running';
  }
}
