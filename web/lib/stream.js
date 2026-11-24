// SSE client with resume-by-sequence (FR-EVT-002, FR-API-021).
//
// The UI is a PROJECTION of this event stream (council-engine-spec §8). Because the client
// tracks the last sequence it saw, reconnect-and-replay falls out for free: the browser's
// EventSource sends Last-Event-ID automatically from the `id:` field the server emits.

export class RunStream {
  constructor() {
    this.source = null;
    this.listeners = new Set();
    this.connected = false;
    this.lastSeq = 0;
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  connect() {
    if (this.source) return;
    const src = new EventSource('/api/stream');
    this.source = src;

    src.onopen = () => {
      this.connected = true;
      this.emit({ type: '__connection', payload: { connected: true } });
    };

    src.onerror = () => {
      // EventSource reconnects on its own and replays from Last-Event-ID, so this is a status
      // change rather than a failure. The banner reads "Reconnecting to run…" (§4.2).
      this.connected = false;
      this.emit({ type: '__connection', payload: { connected: false } });
    };

    // Every event type the engine emits. Registered explicitly rather than via onmessage
    // because the server sets a named `event:` field.
    const types = [
      'stream.ready', 'stream.resync',
      'run.created', 'run.phase', 'run.degraded', 'run.failed', 'run.cancelled',
      'writer.started', 'writer.step', 'writer.settled', 'writer.failed',
      'review.started', 'review.recorded', 'review.failed', 'review.complete',
      'verdict.ready', 'verdict.failed', 'readjudicate.requested',
      'human.decision', 'synthesis.complete', 'candidate.edited',
      'exec.step', 'exec.file', 'exec.complete', 'exec.blocked',
      'quality.scored', 'score.section', 'score.complete',
      'proposal.created', 'approval.recorded', 'publish.result',
    ];
    for (const t of types) {
      src.addEventListener(t, (e) => {
        let payload = {};
        try { payload = JSON.parse(e.data); } catch { /* ignore malformed frame */ }
        const seq = Number.parseInt(e.lastEventId ?? '0', 10);
        if (seq) this.lastSeq = Math.max(this.lastSeq, seq);
        this.emit({ type: t, seq, payload });
      });
    }
  }

  emit(event) {
    for (const fn of this.listeners) {
      try { fn(event); } catch (err) { console.error('stream listener', err); }
    }
  }

  close() {
    this.source?.close();
    this.source = null;
    this.connected = false;
  }
}
