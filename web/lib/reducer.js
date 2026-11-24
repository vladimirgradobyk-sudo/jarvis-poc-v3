// Event → run projection.
//
// THE SINGLE PLACE A RUN STATUS STRING IS PRODUCED ON THE CLIENT (repo-scaffold §4.2
// chokepoint table). FR-HUM-006: the pilot displayed "Captain deliberating…" ABOVE
// "✓ Verdict ready". Status must DERIVE from run state; it can never be set independently, and
// there is no second code path that could disagree.

export const PHASE_ORDER = ['configure', 'generate', 'review', 'compare', 'adjudicate', 'execute', 'publish'];

/** Default phase labels. A skill may override any of them in config (`uiLabels`). */
const DEFAULT_LABELS = {
  document: { configure: 'Configure', generate: 'Execute', review: 'Self & Peer Eval',
              compare: 'Compare', adjudicate: "Captain's Pick", publish: 'Publish' },
  structured_items: { configure: 'Configure', generate: 'Execute', review: 'Self & Peer Eval',
                      adjudicate: "Captain's Pick", publish: 'Publish' },
  code_plan: { configure: 'Configure', generate: 'Plan', review: 'Self & Peer Eval',
               adjudicate: "Captain's Pick", execute: 'Execute', publish: 'Publish' },
  report: { configure: 'Configure', generate: 'Review', publish: 'Publish' },
};

export function phaseLabel(phase, artifactKind, overrides = {}) {
  return overrides[phase] ?? DEFAULT_LABELS[artifactKind]?.[phase] ?? capitalise(phase);
}

/**
 * The status string. Derived from run state ALONE — never from a separate "status" field, and
 * never combined with a phase label that could contradict it.
 */
export function statusLabel(run) {
  if (!run) return '';
  switch (run.state) {
    case 'created':
    case 'queued':         return 'Queued';
    case 'generating':     return run.artifactKind === 'code_plan' ? 'Generating plans…'
                                : run.artifactKind === 'report' ? 'Reviewing…' : 'Generating documents…';
    case 'reviewing':      return 'Evaluating…';
    case 'adjudicating':   return 'Captain deliberating…';
    case 'awaiting_human': return run.artifactKind === 'code_plan' ? 'Plans ready — choose one' : 'Verdict ready';
    case 'synthesizing':   return 'Building document…';
    case 'executing':      return 'Executing selected plan…';
    case 'scoring':        return 'Awaiting accuracy scoring';
    case 'approved':       return 'Approved — ready to publish';
    case 'published':      return 'Published';
    case 'cancelled':      return 'Cancelled — partial results retained';
    case 'failed':         return run.degradedReason ? `Failed — ${run.degradedReason}` : 'Failed';
    default:               return run.state;
  }
}

export function statusKind(run) {
  if (!run) return 'running';
  switch (run.state) {
    case 'awaiting_human':
    case 'scoring':
    case 'approved':  return 'awaiting';
    case 'published': return 'published';
    case 'failed':    return 'failed';
    case 'cancelled': return 'cancelled';
    default:          return run.degraded ? 'degraded' : 'running';
  }
}

/** Which tab the modal should show for the current run state. */
export function activePhaseFor(run) {
  if (!run) return 'configure';
  switch (run.state) {
    case 'created': case 'queued':        return 'configure';
    case 'generating':                    return 'generate';
    case 'reviewing':                     return 'review';
    case 'adjudicating':                  return 'adjudicate';
    case 'awaiting_human':                return run.phases.includes('compare') ? 'compare' : 'adjudicate';
    case 'synthesizing': case 'executing':return run.phases.includes('execute') ? 'execute' : 'adjudicate';
    default:                              return 'publish';
  }
}

/** Which tabs are reachable. Future phases are DISABLED, not hidden (§6.4). */
export function reachablePhases(run) {
  if (!run) return new Set(['configure']);
  const reached = new Set(['configure']);
  const idx = (p) => PHASE_ORDER.indexOf(p);
  const stateFloor = {
    created: 'configure', queued: 'configure', generating: 'generate', reviewing: 'review',
    adjudicating: 'adjudicate', awaiting_human: 'adjudicate', synthesizing: 'adjudicate',
    executing: 'execute', scoring: 'publish', approved: 'publish', published: 'publish',
    failed: 'publish', cancelled: 'publish',
  }[run.state] ?? 'configure';
  for (const p of run.phases) if (idx(p) <= idx(stateFloor)) reached.add(p);
  return reached;
}

/**
 * Live per-writer progress, folded from the event stream. This is what makes the Generate
 * screen a projection rather than a poll: steps arrive as events and append, and settled
 * content is never reflowed (design-system §7.5).
 */
export function createProjection() {
  return {
    writers: new Map(),   // profileId → { state, steps[], elapsedMs, words, tokens, premiumRequests, error }
    reviewDone: 0,
    reviewExpected: 0,
    execFiles: [],
    execSteps: [],
    connection: true,
    lastEventAt: null,
    degradedReason: null,
    notices: [],
  };
}

export function applyEvent(p, event) {
  const d = event.payload ?? {};
  p.lastEventAt = d.at ?? new Date().toISOString();

  switch (event.type) {
    case '__connection':
      p.connection = d.connected;
      break;

    case 'writer.started':
      p.writers.set(d.writerId, {
        profileId: d.writerId, displayName: d.displayName, modelDisplayName: d.modelDisplayName,
        family: d.family, state: 'generating', steps: [], elapsedMs: 0,
      });
      break;

    case 'writer.step': {
      const w = p.writers.get(d.writerId);
      if (!w) break;
      const existing = w.steps.find((s) => s.step === d.step);
      // Append-only: a completed step is updated in place and never moved (§7.5).
      if (existing) { existing.status = d.status; existing.elapsedMs = d.elapsedMs; }
      else w.steps.push({ step: d.step, status: d.status, elapsedMs: d.elapsedMs });
      w.elapsedMs = d.elapsedMs ?? w.elapsedMs;
      break;
    }

    case 'writer.settled': {
      const w = p.writers.get(d.writerId) ?? { profileId: d.writerId, steps: [] };
      Object.assign(w, {
        state: 'done', candidateId: d.candidateId, words: d.words, sections: d.sections,
        placeholders: d.placeholders, citations: d.citations,
        tokens: d.tokens, premiumRequests: d.premiumRequests, elapsedMs: d.elapsedMs,
      });
      p.writers.set(d.writerId, w);
      break;
    }

    case 'writer.failed': {
      const w = p.writers.get(d.writerId) ?? { profileId: d.writerId, steps: [] };
      Object.assign(w, { state: 'failed', error: d.reason, displayName: d.displayName ?? w.displayName });
      p.writers.set(d.writerId, w);
      break;
    }

    case 'review.started':
      p.reviewExpected = d.expected ?? 0;
      p.reviewDone = 0;
      break;

    case 'review.recorded':
      p.reviewDone = d.done ?? p.reviewDone + 1;
      p.reviewExpected = d.expected ?? p.reviewExpected;
      break;

    case 'exec.step':
      p.execSteps.push({ step: d.step, status: d.status });
      break;

    case 'exec.file':
      p.execFiles.push({ path: d.path, op: d.op, added: d.added, removed: d.removed });
      break;

    case 'run.degraded':
      p.degradedReason = d.reason ?? null;
      break;

    // Degradation and refusals are surfaced as notices rather than silently folded away
    // (FR-COUNCIL-009).
    case 'exec.blocked':
      p.notices.push({ kind: 'danger', text: `Execution blocked: ${d.reason}.` });
      break;

    case 'synthesis.complete':
      for (const na of d.notApplied ?? []) {
        p.notices.push({ kind: 'warning', text: `A selected improvement was not applied: ${na.reason}` });
      }
      break;
  }
  return p;
}

export function scoreBand(score) {
  if (score == null) return '';
  if (score >= 80) return 'score-high';
  if (score >= 60) return 'score-mid';
  return 'score-low';
}

export function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function duration(ms) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
