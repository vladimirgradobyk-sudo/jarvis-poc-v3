// Landing, the three start modes, and the skill input form (gate G1).
//
// There is NO global chat composer (screen-specs §0). Across the pilot's five demos and 33
// minutes nobody typed into one; it defeats the input contract (FR-INPUT-001 requires inputs
// rendered from a declared schema so they can be validated, costed and recorded as typed
// provenance); and a composer with no declared destination has no channel, which makes it an
// injection surface.

import { h, mount, frag, clear, Button, Chip, Banner, Field, EmptyState, Modal, KV, toast }
  from '../../components/ui.js';
import { api } from '../../lib/api.js';

export class Launcher {
  constructor({ boot, onStartRun, onOpenRun, onOpenSkill }) {
    this.boot = boot;
    this.onStartRun = onStartRun;
    this.onOpenRun = onOpenRun;
    this.onOpenSkill = onOpenSkill;
    // FR-NAV-012: the selected segment and the rendered panel derive from ONE state value.
    this.mode = 'workflow';
    this.selectedAgent = null;
    this.selectedStage = null;
    this.search = '';
    this.host = h('div', { class: 'stack stack-5' });
  }

  get catalogue() { return this.boot.catalogue; }

  render(budgetState) {
    this.budgetState = budgetState ?? this.boot.budgetState;
    clear(this.host);
    mount(this.host, 
      this.renderHero(),
      this.renderBudgetBanner(),
      this.renderModePicker(),
      this.renderPanel(),
      this.renderRecent(),
    );
    return this.host;
  }

  renderHero() {
    return h('div', { class: 'stack stack-4' },
      h('div', { class: 'row wrap' },
        Chip({ label: 'Active pilot — Intent service Domain', tone: 'accent', glyph: '\u25cf' })),
      h('h1', { style: 'font:var(--text-display)' }, 'JARVIS'),
      h('p', { class: 'secondary', style: 'max-width:68ch' },
        'Generate, review and publish delivery artifacts with AI — with a human approving every change.'),
      // The 11 canonical delivery stages, surfaced here — they used to be a sticky bar at the
      // foot of the page. All 11 are visible and wrap rather than clipping (FR-NAV-008); an
      // enabled stage opens Workflow mode at that stage.
      this.renderStageRail(),
    );
  }

  renderStageRail() {
    const stages = this.catalogue.stages;
    const active = stages.filter((s) => s.enabled).length;
    const rail = h('div', { class: 'stage-rail', role: 'tablist', 'aria-label': 'Delivery stages' });
    stages.forEach((st, i) => {
      mount(rail, h('button', {
        class: 'stage-chip', role: 'tab', type: 'button',
        'aria-selected': this.mode === 'workflow' && this.selectedStage === st.id ? 'true' : 'false',
        'aria-disabled': st.enabled ? null : 'true',
        tabindex: i === 0 ? '0' : '-1',
        title: st.enabled ? st.purpose : 'Available in a later release',
        onclick: () => {
          if (!st.enabled) return;
          this.mode = 'workflow';
          this.selectedStage = st.id;
          this.render(this.budgetState);
        },
        onkeydown: (e) => {
          const chips = [...rail.querySelectorAll('.stage-chip')];
          const idx = chips.indexOf(e.currentTarget);
          let next = null;
          if (e.key === 'ArrowRight') next = chips[Math.min(chips.length - 1, idx + 1)];
          if (e.key === 'ArrowLeft') next = chips[Math.max(0, idx - 1)];
          if (next) { e.preventDefault(); chips.forEach((c) => c.setAttribute('tabindex', '-1')); next.setAttribute('tabindex', '0'); next.focus(); }
        },
      },
        h('span', { class: 'ord' }, String(st.ordinal).padStart(2, '0')),
        h('span', {}, st.name),
        !st.enabled && h('span', { 'aria-hidden': 'true', class: 'caption' }, '—')));
    });
    return h('div', { class: 'stack stack-1' },
      h('div', { class: 'row' },
        h('span', { class: 'overline grow' }, 'Delivery stages'),
        h('span', { class: 'caption muted' }, `11 stages · ${active} available in this release`)),
      rail);
  }

  renderBudgetBanner() {
    const b = this.budgetState;
    if (!b) return null;
    if (b.exhausted) {
      return Banner({ tone: 'danger', title: 'Daily token budget reached',
                      message: 'Runs are paused until 00:00 UTC. Completed work is unaffected.',
                      requirementId: 'NFR-COST-002' });
    }
    if (b.warning) {
      return Banner({ tone: 'warning',
        message: `Today's usage is at ${b.premiumRequests.percent}% of the ${b.premiumRequests.limit} premium-request budget ` +
                 `(warning threshold ${b.warnPercent}%). ${b.premiumRequests.remaining} remain.` });
    }
    return null;
  }

  renderModePicker() {
    const modes = [
      { id: 'workflow', label: 'SDLC Workflow mode', help: 'Start from a lifecycle stage' },
      { id: 'agent', label: 'Agent mode', help: 'Start from an agent' },
      { id: 'action', label: 'Action mode', help: 'Find a skill' },
    ];
    return h('div', { class: 'stack stack-2' },
      h('div', { class: 'row', role: 'tablist', 'aria-label': 'How to start' },
        modes.map((m) => h('button', {
          class: `btn ${this.mode === m.id ? 'btn-primary' : 'btn-secondary'}`,
          role: 'tab', type: 'button', 'aria-selected': this.mode === m.id ? 'true' : 'false',
          onclick: () => { this.mode = m.id; this.selectedAgent = null; this.selectedStage = null; this.render(this.budgetState); },
        }, m.label))),
      h('div', { class: 'caption' }, modes.find((m) => m.id === this.mode).help));
  }

  renderPanel() {
    const disabled = this.budgetState?.exhausted;
    const panel = this.mode === 'agent' ? this.renderAgentMode()
                : this.mode === 'action' ? this.renderActionMode()
                : this.renderWorkflowMode();
    if (disabled) {
      return h('div', { style: 'opacity:.5;pointer-events:none' }, panel);
    }
    return panel;
  }

  // €€ 1.4.1 Agent mode €€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€

  renderAgentMode() {
    if (this.selectedAgent) return this.renderSkillList(
      this.catalogue.skills.filter((s) => s.agentId === this.selectedAgent),
      () => { this.selectedAgent = null; this.render(this.budgetState); });

    return h('div', { class: 'stack stack-3' },
      h('div', { class: 'overline' }, 'Available agents'),
      h('div', { class: 'grid-3' }, this.catalogue.agents.map((a) => h('button', {
        class: 'card card-selectable stack stack-2', type: 'button',
        style: 'text-align:left;color:inherit',
        onclick: () => { this.selectedAgent = a.id; this.render(this.budgetState); },
      },
        h('div', { class: 'row' },
          h('span', { style: 'font:var(--text-h2);color:var(--accent-default)', 'aria-hidden': 'true' }, a.glyph),
          h('div', { class: 'stack stack-1' },
            // design-system §9: the professional ROLE is the primary label and is always
            // shown; the alias is secondary and never appears alone.
            h('strong', {}, a.role),
            a.alias && h('span', { class: 'caption muted' }, `· ${a.alias}`))),
        // FR-NAV-010: every AgentCard presents the SAME manifest shape. The pilot mixed
        // inline skill lists with "— N skills" counts that did not reconcile.
        h('div', { class: 'small secondary' }, a.manifest.label),
        h('div', { class: 'caption muted' },
          a.skillPreview.join(', ') + (a.skillPreviewMore ? `, +${a.skillPreviewMore} more` : '')),
        h('div', { class: 'row wrap caption' },
          a.stages.map((sid) => Chip({ label: this.catalogue.stages.find((s) => s.id === sid)?.name ?? sid }))),
      ))));
  }

  // €€ 1.4.2 Action mode €€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€

  renderActionMode() {
    const q = this.search.trim().toLowerCase();
    const matches = q
      ? this.catalogue.skills.filter((s) =>
          [s.name, s.description, s.agentRole, s.agentAlias, s.outputType, ...(s.synonyms ?? [])]
            .filter(Boolean).some((f) => String(f).toLowerCase().includes(q)))
      : this.catalogue.skills;

    const input = h('input', {
      type: 'text', id: 'skill-search', value: this.search,
      placeholder: 'Search skills, e.g. "user stories", "HLD", "pull request"',
      oninput: (e) => {
        this.search = e.target.value;
        const host = this.host.querySelector('#action-results');
        if (host) { clear(host); mount(host, this.renderActionResults()); }
      },
    });

    // Groups in agent order with sticky headers; jump chips scroll to a group.
    return h('div', { class: 'stack stack-3' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, input),
        h('span', { class: 'caption muted' }, 'Press / to search')),
      h('div', { class: 'row wrap' },
        this.catalogue.agents.map((a) => Button({
          label: a.role, variant: 'ghost', size: 'sm',
          onClick: () => this.host.querySelector(`#group-${a.id}`)?.scrollIntoView({ block: 'center' }),
        }))),
      h('div', { id: 'action-results', class: 'stack stack-4' }, this.renderActionResults(matches)),
    );
  }

  renderActionResults(preMatched) {
    const q = this.search.trim().toLowerCase();
    const matches = preMatched ?? (q
      ? this.catalogue.skills.filter((s) =>
          [s.name, s.description, s.agentRole, s.agentAlias, s.outputType, ...(s.synonyms ?? [])]
            .filter(Boolean).some((f) => String(f).toLowerCase().includes(q)))
      : this.catalogue.skills);

    if (matches.length === 0) {
      return EmptyState({
        title: `No skills match "${this.search}".`,
        action: Button({ label: 'Browse by stage', variant: 'primary',
                         onClick: () => { this.mode = 'workflow'; this.search = ''; this.render(this.budgetState); } }),
      });
    }

    return frag(this.catalogue.agents.map((a) => {
      const owned = matches.filter((s) => s.agentId === a.id);
      if (owned.length === 0) return null;
      return h('div', { class: 'stack stack-2', id: `group-${a.id}` },
        h('div', { class: 'overline', style: 'position:sticky;top:var(--header-height);background:var(--bg-canvas);padding:var(--space-2) 0;z-index:5' },
          a.role, a.alias ? ` · ${a.alias}` : ''),
        h('div', { class: 'stack stack-2' }, owned.map((s) => this.skillRow(s))));
    }));
  }

  // €€ 1.4.3 Workflow mode €€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€

  renderWorkflowMode() {
    if (this.selectedStage) {
      const stage = this.catalogue.stages.find((s) => s.id === this.selectedStage);
      return this.renderSkillList(
        this.catalogue.skills.filter((s) => s.stages.includes(this.selectedStage)),
        () => { this.selectedStage = null; this.render(this.budgetState); },
        stage?.name);
    }
    return h('div', { class: 'stack stack-3' },
      h('div', { class: 'overline' }, 'The 11 delivery stages'),
      h('div', { class: 'grid-3' }, this.catalogue.stages.map((st) => h('button', {
        class: `card ${st.enabled ? 'card-selectable' : ''} stack stack-2`, type: 'button',
        style: `text-align:left;color:inherit${st.enabled ? '' : ';opacity:.6;cursor:not-allowed'}`,
        disabled: !st.enabled,
        onclick: () => { if (st.enabled) { this.selectedStage = st.id; this.render(this.budgetState); } },
      },
        h('div', { class: 'row' },
          h('span', { class: 'overline muted' }, String(st.ordinal).padStart(2, '0')),
          h('strong', { class: 'grow' }, st.name)),
        h('div', { class: 'caption secondary' }, st.purpose),
        h('div', { class: 'row wrap caption' },
          st.agentRoles.map((a) => Chip({ label: a.alias ? `${a.role} · ${a.alias}` : a.role }))),
        st.enabled
          ? h('div', { class: 'caption muted' }, `${st.skillCount} skill${st.skillCount === 1 ? '' : 's'} · Not started`)
          : h('div', { class: 'caption muted' }, 'Available in a later release'),
      ))));
  }

  renderSkillList(skills, onBack, heading = null) {
    return h('div', { class: 'stack stack-3' },
      h('div', { class: 'row' },
        Button({ label: ' Back', variant: 'ghost', size: 'sm', onClick: onBack }),
        heading && h('strong', {}, heading)),
      skills.length === 0
        ? EmptyState({ title: 'No skills here', message: 'No enabled skills for this selection.' })
        : h('div', { class: 'stack stack-2' }, skills.map((s) => this.skillRow(s))));
  }

  /** SkillRow — Title Case name, description, output chip, council indicator, write badge. */
  skillRow(s) {
    return h('button', {
      class: 'card card-selectable row row-3', type: 'button',
      style: 'text-align:left;color:inherit;width:100%',
      onclick: () => this.onOpenSkill(s.id),
    },
      h('div', { class: 'stack stack-1 grow' },
        h('div', { class: 'row wrap' },
          h('strong', {}, s.name),
          Chip({ label: s.outputType, tone: 'accent' }),
          // The council indicator and duration let a user understand cost and wait BEFORE
          // committing (FR-COST-001, mitigating the pilot's long unexplained waits).
          Chip({ label: s.councilIndicator }),
          Chip({ label: `~${Math.round(s.estimatedDurationSeconds / 60)} min` }),
          s.provisional && Chip({ label: 'provisional', tone: 'warning' })),
        h('div', { class: 'small secondary' }, s.description),
        h('div', { class: 'row wrap caption' },
          // FR-NAV-015: a WriteBadge on every writing skill — icon AND text, never colour alone.
          s.writeBadge && Chip({ label: s.writeBadge, tone: 'warning', glyph: '\u2191' }),
          s.requiresScorecard && Chip({ label: 'accuracy scoring available', glyph: '\u2713' }),
          s.requiresSandbox && Chip({ label: 'sandbox', glyph: '\u25a3' }),
          s.stages.map((sid) => Chip({ label: this.catalogue.stages.find((x) => x.id === sid)?.name ?? sid }))),
      ),
      h('span', { class: 'muted', 'aria-hidden': 'true' }, '→'),
    );
  }

  // €€ 3. Skill input form — gate G1 €€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€

  async openForm(skillId) {
    const skill = await api.skill(skillId);
    const values = {};
    const errors = {};
    let estimate = null;
    let estBlock = null;
    let estWarnings = [];
    let artifactOptions = {};

    // Resolve the choices for any artifact_ref field before rendering, so the picker is a
    // select over real prior artifacts rather than a free-text id.
    for (const f of skill.inputs) {
      if (f.type !== 'artifact_ref') continue;
      const res = await api.artifacts(f.acceptsArtifactKinds ?? [], f.acceptsSkills ?? []);
      artifactOptions[f.id] = res.artifacts;
      if (res.artifacts.length) values[f.id] = res.artifacts[0].candidateId;
    }
    for (const f of skill.inputs) if (f.default !== undefined) values[f.id] = f.default;

    // The single council writer whose model the user may choose (FR-MODEL — the Captain's model
    // stays fixed by policy and is never offered here). With one writer there is no peer review,
    // so the effective phase sequence drops review/compare.
    const writer = skill.council?.roster?.[0] ?? null;
    let selectedModel = writer?.defaultModel ?? null;
    const modelGroups = this.boot.modelPicker ?? [];
    const soloPhases = (skill.phases ?? []).filter((p) => p !== 'review' && p !== 'compare');

    // Optional G4 accuracy scorecard: offered only when the template actually has scorable
    // sections. Off by default — the presenter turns it on to show the accuracy instrument.
    const scorable = (skill.template?.sections ?? []).some((s) => s.scorable);
    let scorecardEnabled = false;

    const writerSelectionBody = () =>
      writer && selectedModel ? [{ writerProfileId: writer.id, logicalModel: selectedModel }] : undefined;

    const body = h('div', { class: 'stack stack-4' });
    const modal = Modal({
      title: `${skill.name} — provide inputs`,
      subtitle: `${skill.agentRole}${skill.agentAlias ? ` · ${skill.agentAlias}` : ''} · ${skill.councilIndicator}`,
      size: 'md', labelledBy: 'form-title', body,
      onClose: () => modal.remove(),
    });

    const refreshEstimate = debounce(async () => {
      try {
        const res = await api.estimate({ skillId, inputs: values, writerSelection: writerSelectionBody() });
        estimate = res.estimate; estBlock = res.block; estWarnings = res.warnings ?? [];
      } catch (err) {
        estimate = null; estBlock = { message: err.message };
      }
      draw();
    }, 250);

    const draw = () => {
      clear(body);

      mount(body, h('div', { class: 'stack stack-3' },
        skill.writeBadge && Banner({ tone: 'warning', glyph: '\u2191',
          message: `${skill.writeBadge}. Nothing is written until you approve the exact change at the publication gate.` }),
        skill.provisional && Banner({ tone: 'provisional',
          message: 'This skill produces a provisional assessment. It must be evaluated by qualified personnel before anyone acts on it.' }),
      ));

      // Rendered ENTIRELY from the declared schema — there is no per-skill form code
      // (FR-INPUT-001).
      for (const f of skill.inputs) {
        const id = `in-${f.id}`;
        let control;
        if (f.type === 'textarea') {
          control = h('textarea', { id, rows: '4', placeholder: f.placeholder ?? '',
            oninput: (e) => { values[f.id] = e.target.value; delete errors[f.id]; refreshEstimate(); } });
          control.value = values[f.id] ?? '';
        } else if (f.type === 'enum') {
          control = h('select', { id, onchange: (e) => { values[f.id] = e.target.value; refreshEstimate(); } },
            f.options.map((o) => h('option', { value: o.value, selected: values[f.id] === o.value }, o.label)));
        } else if (f.type === 'artifact_ref') {
          const opts = artifactOptions[f.id] ?? [];
          control = opts.length
            ? h('select', { id, onchange: (e) => { values[f.id] = e.target.value; refreshEstimate(); } },
                opts.map((a) => h('option', { value: a.candidateId, selected: values[f.id] === a.candidateId },
                  `${a.runTitle} · ${a.words} words · ${a.state}`)))
            : h('div', { class: 'banner banner-warning', id },
                'No published artifact of the required kind exists yet. Run the upstream skill first.');
        } else if (f.type === 'repo_ref') {
          control = h('select', { id, onchange: (e) => { values[f.id] = e.target.value; refreshEstimate(); } },
            h('option', { value: 'sample-repo', selected: true }, 'sample-repo (bundled)'));
          values[f.id] = 'sample-repo';
        } else {
          control = h('input', { type: f.type === 'url' ? 'url' : 'text', id, placeholder: f.placeholder ?? '',
            oninput: (e) => { values[f.id] = e.target.value; delete errors[f.id]; refreshEstimate(); } });
          control.value = values[f.id] ?? '';
        }
        mount(body, Field({ id, label: f.label, required: !!f.required, help: f.help, error: errors[f.id], control }));
      }

      // Model selection moved to the Configure step inside the generator, where the writer model
      // and the Captain model are chosen just before Generate.

      // Optional accuracy scorecard (G4). Off by default; the presenter can turn it on.
      if (scorable) {
        mount(body, h('div', { class: 'panel' },
          h('div', { class: 'section-bar' }, 'Accuracy scoring'),
          h('div', { class: 'panel-body' },
            h('label', { class: 'check-opt' },
              h('input', { type: 'checkbox', checked: scorecardEnabled,
                onchange: (e) => { scorecardEnabled = e.target.checked; } }),
              h('span', { class: 'stack stack-1' },
                h('span', {}, 'Score each section before publishing (G4 accuracy scorecard)'),
                h('span', { class: 'caption muted' },
                  'Optional. When on, publication is blocked until every section is scored by hand — the measurement of whether the agent helped.'))))));
      }

      // Context preview — what the run will actually see, including what it will NOT see.
      mount(body, h('details', {}, h('summary', {}, 'Context and prompt'),
        h('div', { class: 'stack stack-2', style: 'padding-top:var(--space-3)' },
          KV([
            ['Template', `${skill.template.title} v${skill.template.version}`],
            ['Sections', `${skill.template.sections.length} (${skill.template.sections.filter((s) => s.scorable).length} scorable)`],
            ['Rubric', skill.council.rubricDetail?.id ?? '—'],
            ['Phases', soloPhases.join(' → ')],
            ['Knowledge bases', null],
          ]),
          Banner({ tone: 'warning',
            message: 'No domain knowledge base is attached (spec assumption A-09 — not licensed for the PoC). Output is generic-model quality.' }),
        )));

      // CostEstimate — new in JARVIS. The pilot had no cost surface at all.
      mount(body, h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Estimated cost'),
        h('div', { class: 'panel-body stack stack-2' },
          !estimate ? h('div', { class: 'row' }, h('span', { class: 'spinner' }), h('span', { class: 'small' }, 'Estimating…'))
          : frag(
            h('div', { class: 'row wrap' },
              Chip({ label: `${estimate.premiumRequestsLow}–${estimate.premiumRequestsHigh} premium requests`, tone: 'accent' }),
              Chip({ label: `${estimate.estimatedTotalTokens.toLocaleString()} tokens` }),
              Chip({ label: `${estimate.writerCount} writer${estimate.writerCount === 1 ? '' : 's'}` }),
              Chip({ label: `${estimate.totalCalls} model calls` }),
              estimate.estimatedCostMinorUnits != null && Chip({
                label: `ˆ ${(estimate.estimatedCostMinorUnits / 100).toFixed(2)} ${estimate.currency}`,
                title: 'Indicative only — the unit of record is the premium request' })),
            h('div', { class: 'caption muted' },
              `Calls by phase: ` + estimate.perPhase.map((p) => `${p.phase} ${p.calls}`).join(', ') +
              `. Context measured at ${estimate.contextTokens.toLocaleString()} tokens.`),
            h('div', { class: 'row small' },
              h('span', { class: 'grow' }, `Budget remaining today`),
              h('span', {}, `${estimate.dailyRemaining} / ${estimate.dailyLimit} premium requests`)),
          ),
          estWarnings.map((w) => Banner({ tone: 'warning', message: w.message })),
          estBlock && Banner({ tone: 'danger', title: 'Cannot start this run', message: estBlock.message,
                               requirementId: estBlock.requirementId }),
        )));

      const canStart = !!estimate;
      mount(body, h('div', { class: 'row' },
        Button({
          label: 'Continue to configure',
          variant: 'primary', disabled: !canStart,
          title: canStart ? null : 'Fill the required fields first',
          onClick: async () => {
            try {
              // Two-step flow: create the run but do NOT start it. The generator opens at the
              // Configure gate, where models are chosen and Generate is pressed.
              const res = await api.createRun({ skillId, inputs: values, start: false,
                writerSelection: writerSelectionBody(),
                scorecardEnabled: scorable ? scorecardEnabled : undefined });
              modal.remove();
              this.onStartRun(res.run);
            } catch (err) {
              if (err.code === 'validation_failed' && err.detail?.fields) {
                for (const f of err.detail.fields) errors[f.path.replace('inputs.', '')] = f.message;
                draw();
                body.querySelector('[aria-invalid="true"]')?.focus();
              } else {
                body.prepend(Banner({ tone: 'danger', title: 'Could not start the run',
                                      message: err.message, requirementId: err.requirementId }));
                body.scrollIntoView({ block: 'start' });
              }
            }
          },
        }),
        Button({ label: 'Cancel', onClick: () => modal.remove() }),
        h('span', { class: 'caption muted right' }, 'Ctrl/Cmd + Enter to submit'),
      ));
    };

    draw();
    refreshEstimate();
    mount(document.body, modal);
    modal.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        modal.querySelector('.btn-primary:not(:disabled)')?.click();
      }
    });
    body.querySelector('input,textarea,select')?.focus();
  }

  renderRecent() {
    const runs = this.boot.recentRuns ?? [];
    if (runs.length === 0) {
      return EmptyState({ title: 'No runs yet', message: 'Pick a delivery stage above, or start from an agent.' });
    }
    return h('div', { class: 'stack stack-2' },
      h('div', { class: 'overline' }, 'Recent runs'),
      h('div', { class: 'stack stack-1' }, runs.slice(0, 5).map((r) => h('button', {
        class: 'session-item row', type: 'button', onclick: () => this.onOpenRun(r.id),
      },
        h('span', { class: `dot dot-${r.statusKind}`, 'aria-hidden': 'true' }),
        h('span', { class: 'grow stack stack-1' },
          h('span', { class: 'session-title' }, r.title),
          h('span', { class: 'caption muted' }, `${r.agentRole} · ${r.statusLabel}`)),
      ))));
  }
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
