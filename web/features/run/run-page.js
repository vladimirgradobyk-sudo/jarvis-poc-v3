// The Run page (screen-specs rework): one dedicated, in-place page per skill run, replacing the
// tabbed Council popup. Progressive disclosure — the top card morphs in place (Setup → Running →
// a compact header), and the results reveal below in order. Every leaf (score tile, rubric
// meters, Captain's review, document view, editor) and the whole server flow are reused; the G4
// scorecard and G5 approval stay as their existing gates, launched from the bottom bar.

import { h, mount, frag, clear, Button, Chip, Badge, Banner, ScoreTile, RubricMeter, Field,
         EmptyState, KV, DocumentView, Modal, toast, renderMarkdown } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { statusLabel, createProjection, applyEvent, duration } from '../../lib/reducer.js';
import { ScorecardGate, ApprovalGate, openProvenance } from '../review/gates.js';

const CRIT_LABEL = (k) => ({ riskManagement: 'Risk Management', actionability: 'Actionability' }[k]
  ?? k.charAt(0).toUpperCase() + k.slice(1));

export class RunPage {
  constructor({ skillId, runId, boot, stream, onBack, onChanged }) {
    this.skillId = skillId;
    this.runId = runId ?? null;
    this.boot = boot;
    this.stream = stream;
    this.onBack = onBack;
    this.onChanged = onChanged ?? (() => {});

    this.skill = null;              // skill detail
    this.host = h('div', { class: 'run-page stack stack-5' });
    this.projection = createProjection();
    this.unsub = null;
    this.timer = null;

    // Setup state
    this.values = {};
    this.errors = {};
    this.artifactOptions = {};
    this.writerModel = null;
    this.captainModel = null;
    this.scorecardEnabled = false;
    this.estimate = null; this.estBlock = null; this.estimating = false;
    this._lastReady = false;

    // Run state
    this.data = null;
    this.startedAt = null;
    this.busy = false;
    this.busyAction = null;   // 'review' | 'evaluate' — which bottom-bar action is in flight
    this._renderedPhase = null;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────

  async mountInto(container) {
    clear(container);
    mount(container, this.host);
    mount(this.host, h('div', { class: 'row' }, h('span', { class: 'spinner' }), h('span', {}, 'Loading…')));

    if (this.runId) {
      this.data = await api.run(this.runId);
      this.skill = await api.skill(this.data.run.skillId);
      this.skillId = this.data.run.skillId;
      this.startedAt = Date.parse(this.data.run.createdAt) || Date.now();
      this.subscribe();
    } else {
      this.skill = await api.skill(this.skillId);
      await this.initInputs();
      this.writerModel = this.skill.council?.roster?.[0]?.defaultModel ?? null;
      this.captainModel = this.policyCaptainLogical();
    }
    this.render();
    if (!this.runId) this.refreshEstimate();
    return this.host;
  }

  destroy() { this.unsub?.(); if (this.timer) clearInterval(this.timer); }

  async initInputs() {
    for (const f of this.skill.inputs) {
      if (f.type !== 'artifact_ref') continue;
      const res = await api.artifacts(f.acceptsArtifactKinds ?? [], f.acceptsSkills ?? []);
      this.artifactOptions[f.id] = res.artifacts;
      if (res.artifacts.length) this.values[f.id] = res.artifacts[0].candidateId;
    }
    for (const f of this.skill.inputs) if (f.default !== undefined) this.values[f.id] = f.default;
  }

  subscribe() {
    this.unsub?.();
    this.unsub = this.stream.onEvent((ev) => {
      if (ev.payload?.runId && ev.payload.runId !== this.runId) return;
      applyEvent(this.projection, ev);
      const refetch = ['run.phase', 'writer.settled', 'verdict.ready', 'verdict.failed',
                       'synthesis.complete', 'quality.scored', 'run.failed', 'run.degraded', 'candidate.edited'];
      if (refetch.includes(ev.type)) { this.refresh().catch(() => {}); return; }
      // Frequent per-step events patch the step log in place (no full re-render, no re-animate).
      if (ev.type === 'writer.step' || ev.type === 'writer.started') this.patchStepLog();
    });
  }

  async refresh() {
    if (!this.runId) return;
    this.data = await api.run(this.runId);
    this.onChanged();
    this.render();
  }

  renderIfMounted() { if (this.host.isConnected) this.render(); }

  // ── phase ────────────────────────────────────────────────────────────────────────────────

  phase() {
    if (!this.runId || !this.data) return 'setup';
    const s = this.data.run.state;
    if (['created'].includes(s)) return 'setup';
    if (['generating', 'reviewing', 'adjudicating', 'synthesizing', 'executing', 'queued'].includes(s)) return 'running';
    return 'done';   // awaiting_human, scoring, approved, published, failed, cancelled
  }

  // ── render ───────────────────────────────────────────────────────────────────────────────

  render() {
    clear(this.host);
    const phase = this.phase();
    const animate = phase !== this._renderedPhase;   // animate only on a phase change, not on refresh
    this._renderedPhase = phase;

    mount(this.host,
      h('div', { class: 'row' },
        Button({ label: '‹ Back', variant: 'ghost', size: 'sm', onClick: () => this.onBack() }),
        h('div', { class: 'stack stack-1 grow' },
          h('div', { class: 'row wrap' },
            h('h1', { style: 'font:var(--text-h1)' }, this.skill.name),
            Chip({ label: this.skill.outputType, tone: 'accent' })),
          h('div', { class: 'caption muted' },
            `${this.skill.agentRole}${this.skill.agentAlias ? ` · ${this.skill.agentAlias}` : ''}`)),
      ),
    );

    // The top card holds the morphing state (setup → running → compact), always in the same place.
    mount(this.host, h('div', { class: `run-top${animate ? ' run-animate' : ''}` },
      phase === 'setup' ? this.renderSetup()
      : phase === 'running' ? this.renderRunning()
      : this.renderDoneHeader()));

    if (phase === 'done') mount(this.host, ...this.renderResults());

    this.manageTimer(phase);
  }

  manageTimer(phase) {
    if (phase === 'running' && !this.timer) {
      this.timer = setInterval(() => { this.updateMetrics(); }, 1000);
    } else if (phase !== 'running' && this.timer) {
      clearInterval(this.timer); this.timer = null;
    }
  }

  // ── setup ────────────────────────────────────────────────────────────────────────────────

  renderSetup() {
    const ready = this.inputsValid();
    return h('div', { class: 'run-card stack stack-4' },
      h('div', { class: 'section-bar' }, 'Set up this run'),
      h('div', { class: 'run-card-body stack stack-4' },
        this.renderInputs(),
        // Progressive disclosure: models reveal once the required inputs are in.
        ready
          ? h('div', { class: 'run-reveal stack stack-4' }, this.renderModels(), this.renderRunBar())
          : h('div', { class: 'caption muted' }, 'Fill the required inputs above to choose models and run.'),
      ),
    );
  }

  renderInputs() {
    const fields = this.skill.inputs.map((f) => {
      const id = `in-${f.id}`;
      let control;
      if (f.type === 'textarea') {
        control = h('textarea', { id, rows: '3', placeholder: f.placeholder ?? '',
          oninput: (e) => { this.values[f.id] = e.target.value; delete this.errors[f.id]; this.onInputChanged(); } });
        control.value = this.values[f.id] ?? '';
      } else if (f.type === 'enum') {
        control = h('select', { id, onchange: (e) => { this.values[f.id] = e.target.value; this.refreshEstimate(); } },
          f.options.map((o) => h('option', { value: o.value, selected: this.values[f.id] === o.value }, o.label)));
      } else if (f.type === 'artifact_ref') {
        const opts = this.artifactOptions[f.id] ?? [];
        control = opts.length
          ? h('select', { id, onchange: (e) => { this.values[f.id] = e.target.value; this.refreshEstimate(); } },
              opts.map((a) => h('option', { value: a.candidateId, selected: this.values[f.id] === a.candidateId },
                `${a.runTitle} · ${a.words} words · ${a.state}`)))
          : h('div', { class: 'banner banner-warning', id }, 'No published artifact of the required kind exists yet. Run the upstream skill first.');
      } else if (f.type === 'repo_ref') {
        this.values[f.id] = 'sample-repo';
        control = h('select', { id }, h('option', { value: 'sample-repo', selected: true }, 'sample-repo (bundled)'));
      } else {
        control = h('input', { type: f.type === 'url' ? 'url' : 'text', id, placeholder: f.placeholder ?? '',
          oninput: (e) => { this.values[f.id] = e.target.value; delete this.errors[f.id]; this.onInputChanged(); } });
        control.value = this.values[f.id] ?? '';
      }
      return Field({ id, label: f.label, required: !!f.required, help: f.help, error: this.errors[f.id], control });
    });

    const scorable = (this.skill.template?.sections ?? []).some((s) => s.scorable);
    return h('div', { class: 'stack stack-3' },
      h('div', { class: 'overline' }, 'Inputs'),
      ...fields,
      scorable && h('label', { class: 'check-opt' },
        h('input', { type: 'checkbox', checked: this.scorecardEnabled,
          onchange: (e) => { this.scorecardEnabled = e.target.checked; } }),
        h('span', { class: 'stack stack-1' },
          h('span', {}, 'Score each section before publishing (G4 accuracy scorecard)'),
          h('span', { class: 'caption muted' }, 'Optional — enables Run Evaluation after the run.'))),
    );
  }

  renderModels() {
    const sel = (id, groups, value, onChange) => h('select', { id,
      onchange: (e) => onChange(e.target.value) },
      groups.map((g) => h('optgroup', { label: g.provider },
        g.options.map((o) => h('option', { value: o.logicalModel, selected: value === o.logicalModel }, o.label)))));
    const writer = this.skill.council?.roster?.[0];
    return h('div', { class: 'stack stack-3' },
      h('div', { class: 'overline' }, 'Models'),
      h('div', { class: 'grid-2' },
        h('div', { class: 'panel' },
          h('div', { class: 'section-bar' }, 'Writer'),
          h('div', { class: 'panel-body stack stack-2' },
            writer && h('div', { class: 'row wrap' },
              h('strong', {}, writer.displayName),
              writer.focusChip && Chip({ label: writer.focusChip, overline: true, tone: 'accent' })),
            writer?.roleDescription && h('div', { class: 'small secondary' }, writer.roleDescription),
            Field({ id: 'rp-writer-model', label: 'Writer model', help: 'The writer drafts on this model.',
              control: sel('rp-writer-model', this.boot.modelPicker ?? [], this.writerModel,
                (v) => { this.writerModel = v; this.refreshEstimate(); }) }),
            this.modelDetail(this.writerModel, this.boot.modelPicker))),
        h('div', { class: 'panel' },
          h('div', { class: 'section-bar' }, 'Captain'),
          h('div', { class: 'panel-body stack stack-2' },
            h('div', { class: 'row wrap' }, h('strong', {}, 'Captain'), h('span', { class: 'muted' }, '· Reviewer'),
              Badge({ label: 'Reviews the draft' })),
            Field({ id: 'rp-captain-model', label: 'Captain model', help: 'The Captain reviews and scores the draft on this model.',
              control: sel('rp-captain-model', this.captainOptions(), this.captainModel,
                (v) => { this.captainModel = v; this.refreshEstimate(); }) }),
            this.modelDetail(this.captainModel, this.captainOptions()))),
      ),
    );
  }

  /** Model details revealed below the selector (family, provider, context window). */
  modelDetail(logical, groups) {
    let found = null;
    for (const g of groups ?? []) { const o = (g.options ?? []).find((x) => x.logicalModel === logical); if (o) { found = { ...o, provider: g.provider }; break; } }
    if (!found) return null;
    return h('div', { class: 'row wrap caption muted run-reveal' },
      Chip({ label: found.displayName }),
      found.family && Chip({ label: found.family, title: 'Model family' }),
      found.provider && Chip({ label: found.provider }),
      found.contextWindow && Chip({ label: `${Math.round(found.contextWindow / 1000)}k ctx` }),
      found.policyFixed && Chip({ label: 'policy default', tone: 'accent' }));
  }

  renderRunBar() {
    return h('div', { id: 'rp-runbar', class: 'stack stack-2' }, ...this.runBarInner());
  }

  runBarInner() {
    const e = this.estimate;
    return [
      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Estimated cost'),
        h('div', { class: 'panel-body' },
          this.estimating || !e
            ? h('div', { class: 'row' }, h('span', { class: 'spinner' }), h('span', { class: 'small' }, 'Estimating…'))
            : frag(
                h('div', { class: 'row wrap' },
                  Chip({ label: `${e.premiumRequestsLow}–${e.premiumRequestsHigh} premium requests`, tone: 'accent' }),
                  Chip({ label: `${e.estimatedTotalTokens.toLocaleString()} tokens` }),
                  Chip({ label: `~${Math.round((this.skill.estimatedDurationSeconds ?? 0) / 60)} min` }),
                  Chip({ label: `${e.totalCalls} model calls` })),
                this.estBlock && Banner({ tone: 'danger', title: 'Cannot start this run', message: this.estBlock.message })))),
      h('div', { class: 'row' },
        Button({ label: 'Run Agent', variant: 'primary', busy: this.busy, disabled: !!this.estBlock || this.estimating,
          title: this.estBlock?.message ?? null, onClick: () => this.runAgent() }),
        h('span', { class: 'caption muted' }, 'Nothing is written until you approve at the publication gate.')),
    ];
  }

  patchRunBar() {
    const el = this.host.querySelector('#rp-runbar');
    if (!el) return;
    clear(el); mount(el, ...this.runBarInner());
  }

  // ── running ──────────────────────────────────────────────────────────────────────────────

  renderRunning() {
    const run = this.data.run;
    const live = [...this.projection.writers.values()];
    const w = live[0] ?? run.writerSelection[0];
    const steps = w?.steps ?? [];
    const cost = this.data.cost?.total ?? { totalTokens: 0, premiumRequests: 0 };

    return h('div', { class: 'run-card stack stack-4' },
      h('div', { class: 'section-bar' }, 'Running', h('span', { class: 'count' }, statusLabel(run))),
      h('div', { class: 'run-card-body stack stack-3' },
        h('div', { class: 'run-metrics', id: 'run-metrics' }, ...this.metricTiles(cost)),
        h('div', { class: 'panel' },
          h('div', { class: 'section-bar' }, w?.displayName ?? 'Agent',
            h('span', { class: 'count' }, w?.modelDisplayName ?? '')),
          h('div', { class: 'panel-body' },
            h('div', { class: 'steplog', id: 'rp-steplog', 'aria-live': 'polite' }, ...this.stepLines(steps)))),
        run.state === 'failed' && Banner({ tone: 'danger', title: 'The run failed', message: run.degradedReason ?? '' }),
      ),
    );
  }

  stepLines(steps) {
    if (!steps.length) return [h('div', { class: 'muted caption' }, 'Starting…')];
    return steps.slice(-8).map((s) => h('div', { class: 'steplog-line' },
      h('span', { class: 'tick' }, s.status === 'done' ? '✓' : '·'),
      h('span', { class: 'grow' }, s.step),
      h('span', { class: 'elapsed' }, s.status === 'done' ? '' : duration(s.elapsedMs))));
  }

  patchStepLog() {
    const host = this.host.querySelector('#rp-steplog');
    if (!host || this.phase() !== 'running') return;
    const w = [...this.projection.writers.values()][0];
    clear(host); mount(host, ...this.stepLines(w?.steps ?? []));
  }

  metricTiles(cost) {
    const elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const totalMs = (this.skill.estimatedDurationSeconds ?? 0) * 1000;
    const remainMs = Math.max(0, totalMs - elapsedMs);
    const pct = totalMs ? Math.min(100, Math.round((elapsedMs / totalMs) * 100)) : null;
    const tile = (label, value) => h('div', { class: 'run-metric' },
      h('div', { class: 'run-metric-value' }, value), h('div', { class: 'caption muted' }, label));
    return [
      tile('Progress', pct == null ? '—' : `${pct}%`),
      tile('Elapsed', duration(elapsedMs)),
      tile('Est. remaining', remainMs ? `~${duration(remainMs)}` : '—'),
      tile('Tokens', (cost.totalTokens ?? 0).toLocaleString()),
      tile('Premium req.', cost.premiumRequests ?? 0),
    ];
  }

  updateMetrics() {
    const host = this.host.querySelector('#run-metrics');
    if (!host) return;
    clear(host);
    mount(host, ...this.metricTiles(this.data.cost?.total ?? {}));
  }

  // ── done ─────────────────────────────────────────────────────────────────────────────────

  renderDoneHeader() {
    const run = this.data.run;
    const sel = run.writerSelection[0];
    const cost = this.data.cost?.total ?? {};
    return h('div', { class: 'run-card run-card-compact' },
      h('div', { class: 'row wrap' },
        Badge({ label: run.state === 'published' ? 'Published' : 'Run complete', tone: 'winner' }),
        Chip({ label: `Writer · ${sel?.modelDisplayName ?? '—'}` }),
        this.data.verdict && Chip({ label: `Captain · ${this.data.verdict.modelDisplayName}` }),
        h('span', { class: 'right caption muted' },
          `${cost.premiumRequests ?? 0} premium req · ${(cost.totalTokens ?? 0).toLocaleString()} tokens`)),
    );
  }

  renderResults() {
    const run = this.data.run;
    if (run.state === 'failed') {
      return [Banner({ tone: 'danger', title: 'The run failed', message: run.degradedReason ?? '' })];
    }
    const verdict = this.data.verdict;
    const evalu = verdict?.evaluation;
    const finalCand = this.data.candidates.find((c) => c.origin === 'human_edit')
      ?? this.data.candidates.find((c) => c.origin === 'synthesis')
      ?? this.data.candidates.find((c) => c.origin === 'writer')
      ?? this.data.candidates.slice(-1)[0];

    const out = [];

    // 1. Score
    if (evalu) {
      out.push(h('div', { class: 'run-section panel' },
        h('div', { class: 'section-bar' }, 'Score',
          h('span', { class: 'count' }, `reviewed by Captain · ${verdict.modelDisplayName}`)),
        h('div', { class: 'panel-body grid-2' },
          h('div', { class: 'stack stack-2' },
            ScoreTile({ value: evalu.overallScore, label: finalCand?.writerDisplayName ?? 'Draft', caption: 'Captain score' }),
            h('div', { class: 'row caption wrap' },
              finalCand && Chip({ label: `${finalCand.wordCount.toLocaleString()} words` }),
              finalCand && Chip({ label: `${finalCand.citations.length} citations` }),
              finalCand && finalCand.placeholders.length > 0 &&
                Chip({ label: `${finalCand.placeholders.length} placeholder(s)`, tone: 'warning', glyph: '!' }))),
          h('div', { class: 'stack stack-1' },
            Object.entries(evalu.criterionScores).map(([k, v]) => RubricMeter({ label: CRIT_LABEL(k), value: v }))))));
    }

    // 2. Captain's Review
    if (verdict) {
      out.push(h('div', { class: 'run-section panel' },
        h('div', { class: 'section-bar' }, "Captain's Review",
          Chip({ label: verdict.captainMode, tone: 'accent' })),
        h('div', { class: 'panel-body stack stack-3' },
          h('div', {}, verdict.rationale),
          h('details', {}, h('summary', {}, "Captain's full analysis"),
            h('div', { class: 'doc', style: 'padding-top:var(--space-3)', html: renderMarkdown(verdict.fullAnalysis) })))));
    }

    // 3. Result preview + Edit
    if (finalCand) {
      out.push(h('div', { class: 'run-section panel' },
        h('div', { class: 'section-bar' }, 'Result',
          h('span', { class: 'count' }, `${finalCand.wordCount.toLocaleString()} words`),
          finalCand.placeholders.length === 0 && run.state === 'awaiting_human'
            && Button({ label: 'Edit', variant: 'secondary', size: 'sm', onClick: () => this.openEditor(finalCand) })),
        h('div', { class: 'panel-body stack stack-3' },
          finalCand.placeholders.length > 0 && Banner({ tone: 'danger', title: 'Publication is blocked',
            message: `${finalCand.placeholders.length} unresolved placeholder(s) in ${finalCand.placeholders.map((p) => p.sectionHeading).join(', ')}. Edit to resolve before publishing.`,
            actions: [Button({ label: 'Edit to resolve', variant: 'primary', size: 'sm', onClick: () => this.openEditor(finalCand) })] }),
          DocumentView(finalCand.body))));
    }

    // 4. Bottom bar
    out.push(this.renderReviewBar());
    return out;
  }

  renderReviewBar() {
    const run = this.data.run;
    const scorecardOn = run.scorecardEnabled != null ? run.scorecardEnabled : !!this.data.skill.requiresScorecard;
    if (run.state === 'published') {
      return h('div', { class: 'run-section run-bar' },
        Banner({ tone: 'success', title: 'Published', message: 'This run is complete and its provenance is sealed.' }),
        h('div', { class: 'row' },
          Button({ label: 'View provenance', variant: 'secondary', onClick: () => openProvenance(this.runId) }),
          Button({ label: 'Done', variant: 'ghost', onClick: () => this.onBack() })));
    }
    return h('div', { class: 'run-section run-bar row wrap' },
      Button({ label: 'Mark as Reviewed', variant: 'primary',
        busy: this.busyAction === 'review', disabled: this.busyAction === 'evaluate',
        onClick: () => this.markReviewed() }),
      scorecardOn && Button({ label: 'Run Evaluation', variant: 'secondary',
        busy: this.busyAction === 'evaluate', disabled: this.busyAction === 'review',
        onClick: () => this.runEvaluation() }),
      h('span', { class: 'caption muted' },
        'Mark as Reviewed opens the approval gate before anything is written to the next stage.'));
  }

  // ── actions ──────────────────────────────────────────────────────────────────────────────

  inputsValid() {
    return this.skill.inputs.every((f) => {
      if (!f.required) return true;
      const v = this.values[f.id];
      return v !== undefined && v !== null && String(v).trim() !== '';
    });
  }

  onInputChanged() {
    // Reveal (or hide) the models + run bar the moment the inputs cross the valid threshold —
    // a full re-render only on that transition, so typing never loses focus.
    const ready = this.inputsValid();
    if (ready !== this._lastReady) { this._lastReady = ready; this.render(); }
    this.refreshEstimate();
  }

  /** Captain model options, falling back to the writer picker if the Captain picker is absent
   *  (e.g. a server build without captainPicker) so the dropdown is never empty. */
  captainOptions() {
    const cp = this.boot.captainPicker ?? [];
    return cp.some((g) => (g.options ?? []).length) ? cp : (this.boot.modelPicker ?? []);
  }

  policyCaptainLogical() {
    const groups = this.captainOptions();
    for (const g of groups) { const o = (g.options ?? []).find((x) => x.policyFixed); if (o) return o.logicalModel; }
    return groups[0]?.options?.[0]?.logicalModel ?? null;
  }

  writerSelectionBody() {
    const w = this.skill.council?.roster?.[0];
    return w && this.writerModel ? [{ writerProfileId: w.id, logicalModel: this.writerModel }] : undefined;
  }

  refreshEstimate = debounce(async function () {
    if (!this.inputsValid()) { this.estimate = null; return; }
    this.estimating = true; this.patchRunBar();
    try {
      const res = await api.estimate({ skillId: this.skillId, inputs: this.values, writerSelection: this.writerSelectionBody() });
      this.estimate = res.estimate; this.estBlock = res.block;
    } catch (err) { this.estimate = null; this.estBlock = { message: err.message }; }
    this.estimating = false; this.patchRunBar();
  }, 250);

  async runAgent() {
    if (!this.inputsValid()) return;
    this.busy = true; this.render();
    try {
      const created = await api.createRun({ skillId: this.skillId, inputs: this.values, start: false,
        writerSelection: this.writerSelectionBody(),
        scorecardEnabled: this.scorecardEnabled });
      this.runId = created.run.id;
      this.data = await api.run(this.runId);
      this.startedAt = Date.now();
      this.subscribe();
      await api.generate(this.runId, { writerSelection: this.writerSelectionBody(), captainModel: this.captainModel });
      this.onChanged();
      await this.refresh();
    } catch (err) {
      toast(err.message, 'danger', 9000);
    } finally { this.busy = false; this.renderIfMounted(); }
  }

  /** Record the one-decision accept so the run can advance. No busy/render here — the caller
   *  owns the button's loading state (and clears it in a finally). */
  async ensureDecided() {
    const run = this.data.run;
    if (run.state !== 'awaiting_human' || !this.data.verdict) return;
    await api.decide(this.runId, { action: 'accept', baseCandidateId: this.data.verdict.winnerCandidateId, appliedSuggestionIds: [] });
    await this.refresh();   // re-renders with the current busyAction still set
  }

  async markReviewed() {
    this.busyAction = 'review'; this.render();
    try {
      await this.ensureDecided();
      await this.openApproval();
    } catch (err) { toast(err.message, 'danger', 9000); }
    finally { this.busyAction = null; this.renderIfMounted(); }
  }

  async runEvaluation() {
    this.busyAction = 'evaluate'; this.render();
    try {
      await this.ensureDecided();
      const d = await api.run(this.runId);
      if (d.run.state === 'scoring') {
        const gate = new ScorecardGate({ runId: this.runId, onComplete: () => this.refresh() });
        await gate.open();
      } else {
        toast('No section scorecard for this run — the Captain evaluation is shown above.', 'info', 6000);
      }
    } catch (err) { toast(err.message, 'danger', 9000); }
    finally { this.busyAction = null; this.renderIfMounted(); }
  }

  async openApproval() {
    const d = await api.run(this.runId);
    const overrides = {};
    if (d.skill.writeTargets.includes('confluence_page')) {
      overrides.space = 'alberta';
      overrides.title = `${d.template.title} — ${d.run.epicRef ?? d.run.title}`;
    }
    if (d.skill.writeTargets.includes('jira_issue')) {
      overrides.assignee = d.run.inputs.assignee ?? this.boot.actor;
      overrides.simulatePartialFailure = true;
    }
    const gate = new ApprovalGate({ runId: this.runId, onPublished: () => this.refresh() });
    await gate.open(overrides);
  }

  openEditor(candidate) {
    const ta = h('textarea', { rows: '20', style: 'font:var(--text-mono-small)' });
    ta.value = candidate.body;
    const summary = h('input', { type: 'text', placeholder: 'What did you change, and why?' });
    const modal = Modal({
      title: 'Edit the result', size: 'md', labelledBy: 'rp-edit-title',
      subtitle: 'Your revision is recorded as a new version with provenance. The original is never altered.',
      body: h('div', { class: 'stack stack-3' },
        Banner({ tone: 'info', message: 'Resolve every TBD [UNKNOWN …] marker. Publication stays blocked until none remain.' }),
        h('div', { class: 'field' }, h('label', {}, 'Change summary'), summary), ta),
      footer: frag(
        Button({ label: 'Save revision', variant: 'primary', onClick: async () => {
          try {
            await api.editCandidate(candidate.id, { body: ta.value, summary: summary.value || 'Human revision.' });
            toast('Revision saved.', 'success'); modal.remove(); await this.refresh();
          } catch (e) { toast(e.message, 'danger', 9000); }
        } }),
        Button({ label: 'Cancel', onClick: () => modal.remove() })),
      onClose: () => modal.remove(),
    });
    mount(document.body, modal);
    ta.focus();
  }
}

function debounce(fn, ms) {
  let t = null;
  return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
}
