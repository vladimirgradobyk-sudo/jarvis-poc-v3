// Application shell: nav rail, session list, stage rail, and the routing between gates.
//
// The shell owns navigation and nothing else. It does not orchestrate a run — that is the
// server's job — and it does not compute a status string, because lib/reducer.js is the single
// place one is produced.

import { h, mount, frag, clear, Button, Chip, Banner, EmptyState, toast } from './components/ui.js';
import { api, setCsrf } from './lib/api.js';
import { RunStream } from './lib/stream.js';
import { relativeTime } from './lib/reducer.js';
import { Launcher } from './features/navigation/launcher.js';
import { RunPage } from './features/run/run-page.js';
import { CouncilModal } from './features/council/council.js';
import { ScorecardGate, ApprovalGate, openProvenance } from './features/review/gates.js';
import { openAdminConsole, openSettings, openHistory, openSor } from './features/admin/admin.js';

class App {
  constructor() {
    this.boot = null;
    this.stream = new RunStream();
    this.runs = [];
    this.activeRunId = null;
    this.openModal = null;
    this.currentPage = null;
    this.railCollapsed = false;
  }

  async start() {
    const root = document.getElementById('root');
    clear(root);
    mount(root, h('div', { class: 'row', style: 'padding:var(--space-8);justify-content:center' },
      h('span', { class: 'spinner' }), h('span', {}, 'Loading JARVIS…')));

    try {
      this.boot = await api.bootstrap();
    } catch (err) {
      clear(root);
      mount(root, h('div', { class: 'content' }, Banner({
        tone: 'danger', title: 'Could not reach the JARVIS server',
        message: `${err.message} Start it with: node server/index.js`,
      })));
      return;
    }

    setCsrf(this.boot.csrfToken);
    this.runs = this.boot.recentRuns ?? [];
    this.budgetState = this.boot.budgetState;

    this.launcher = new Launcher({
      boot: this.boot,
      onStartRun: (run) => this.onRunCreated(run),
      onOpenRun: (id) => this.openRun(id),
      onOpenSkill: (id) => this.openSkill(id),
    });

    this.theme = localStorage.getItem('jarvis-theme') ?? 'dark';
    document.documentElement.dataset.theme = this.theme;

    clear(root);
    mount(root, this.shell());
    this.renderMain();

    this.stream.connect();
    this.stream.onEvent((ev) => this.onStreamEvent(ev));

    window.addEventListener('jarvis:view-sor', (e) => openSor(e.detail?.url));

    // `/` focuses the Action-mode search (screen-specs §1.4.2).
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        const search = document.getElementById('skill-search');
        if (search) { e.preventDefault(); search.focus(); }
      }
    });
  }

  shell() {
    this.railEl = h('nav', { class: 'rail', 'aria-label': 'Navigation' });
    this.mainEl = h('main', { class: 'main' });
    const wrap = h('div', { class: 'shell' }, this.railEl, this.mainEl);
    this.renderRail();
    return wrap;
  }

  // €€ 1.2 Nav rail and session list €€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€

  renderRail() {
    clear(this.railEl);
    mount(this.railEl, 
      h('div', { class: 'rail-head stack stack-1' },
        h('div', { class: 'wordmark' }, h('span', { class: 'j' }, 'JARVIS')),
        h('div', { class: 'rail-version' }, 'v0.1.0-poc · AI Delivery Lifecycle Assistant')),

      Button({ label: '+ New run', variant: 'primary', size: 'lg', block: true,
               onClick: () => this.showDashboard() }),

      // Budget is visible in the shell, not buried in settings: the pilot's central design
      // decision was driven by a cost its UI never showed (FR-COST-004).
      this.renderBudgetWidget(),

      h('div', { class: 'overline' }, 'Recent runs'),
      h('div', { class: 'stack stack-1 grow', style: 'overflow-y:auto' },
        this.runs.length === 0
          ? h('div', { class: 'caption muted' }, 'No runs yet')
          : this.runs.slice(0, 15).map((r) => this.sessionItem(r))),

      h('div', { class: 'rail-foot' },
        Button({ label: 'Systems of record', variant: 'ghost', size: 'sm', block: true, onClick: () => openSor() }),
        Button({ label: 'Run history', variant: 'ghost', size: 'sm', block: true,
                 onClick: () => openHistory((id) => this.openRun(id)) }),
        Button({ label: 'Admin console', variant: 'ghost', size: 'sm', block: true, onClick: () => openAdminConsole() }),
        Button({ label: 'Settings', variant: 'ghost', size: 'sm', block: true,
                 onClick: () => openSettings({ boot: this.boot, onThemeChange: (t) => this.setTheme(t) }) }),
        Button({ label: this.theme === 'dark' ? 'Light theme' : 'Dark theme', variant: 'ghost', size: 'sm', block: true,
                 onClick: () => this.setTheme(this.theme === 'dark' ? 'light' : 'dark') })),
    );
  }

  renderBudgetWidget() {
    const b = this.budgetState;
    if (!b) return null;
    const pct = b.premiumRequests.percent;
    const tone = b.exhausted ? 'danger' : b.warning ? 'warn' : '';
    return h('div', { class: 'stack stack-1', style: 'padding:var(--space-2) 0' },
      h('div', { class: 'row caption' },
        h('span', { class: 'grow overline' }, 'Today'),
        h('span', {}, `${b.premiumRequests.consumed} / ${b.premiumRequests.limit}`)),
      h('div', { class: `progress ${tone}` }, h('div', { style: `width:${Math.min(100, pct)}%` })),
      h('div', { class: 'caption muted' },
        `${b.premiumRequests.remaining} premium requests left · ${(b.tokens.consumed / 1000).toFixed(0)}k tokens`),
      b.exhausted && Chip({ label: 'Budget exhausted', tone: 'danger', glyph: '!' }));
  }

  /**
   * SessionListItem (§1.2). FR-NAV-007: the title is generated server-side, is human-readable,
   * and never exposes a prompt, agent ID or template fragment. The pilot rendered every row as
   * literally "New Chat".
   */
  sessionItem(r) {
    return h('button', {
      class: `session-item${r.id === this.activeRunId ? ' active' : ''}`, type: 'button',
      onclick: () => this.openRun(r.id),
    },
      h('span', { class: 'row' },
        h('span', { class: `dot dot-${r.statusKind}`, 'aria-hidden': 'true' }),
        h('span', { class: 'grow', style: 'min-width:0' },
          h('span', { class: 'session-title' }, r.title),
          h('span', { class: 'caption muted' },
            `${r.agentRole} · ${relativeTime(r.createdAt)}`)),
        r.degraded && Chip({ label: '!', tone: 'warning', title: r.degradedReason ?? 'Degraded' })),
      h('span', { class: 'visually-hidden' }, r.statusLabel),
      h('span', { class: 'caption', style: 'color:var(--text-muted)' }, r.statusLabel));
  }

  setTheme(t) {
    this.theme = t;
    document.documentElement.dataset.theme = t;
    localStorage.setItem('jarvis-theme', t);
    this.renderRail();
    toast(`${t === 'dark' ? 'Dark' : 'Light'} theme — both themes meet AA contrast.`, 'success', 2500);
  }

  // €€ Main €€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€

  renderMain() {
    clear(this.mainEl);
    mount(this.mainEl, 
      h('header', { class: 'topbar' },
        h('div', { class: 'row grow' },
          h('span', { class: 'caption muted' }, 'JARVIS'),
          h('span', { class: 'caption muted' }, '\u203a'),
          h('span', { class: 'caption' }, 'Start a run')),
        Chip({ label: `${this.boot.transport} transport`, title: this.boot.transportDescription }),
        Chip({ label: this.boot.actor, title: 'Actor — the OS-authenticated user, stamped on every decision and approval' }),
      ),
      h('div', { class: 'content', id: 'main-content' },
        this.launcher.render(this.budgetState)),
    );
  }

  // The delivery-stage rail now lives in the launcher hero
  // (web/features/navigation/launcher.js), so it is visible on the landing rather than docked
  // at the foot of the page.

  // €€ Run lifecycle €€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€

  async onRunCreated(run) {
    await this.refreshRuns();
    this.openRun(run.id);
  }

  async refreshRuns() {
    const [{ runs }, budget] = await Promise.all([api.listRuns('?limit=20'), api.budget()]);
    this.runs = runs;
    this.budgetState = budget;
    this.boot.recentRuns = runs;
    this.boot.budgetState = budget;
    this.renderRail();
  }

  /** New run for a skill — opens the dedicated run page (setup → run → results), not a popup. */
  openSkill(skillId) {
    this.activeRunId = null;
    return this.openCurrentPage(new RunPage({
      skillId, boot: this.boot, stream: this.stream,
      onBack: () => this.showDashboard(),
      onChanged: () => this.refreshRuns(),
    }));
  }

  /** Reopen an existing run on the same dedicated page, at whatever phase it is in. */
  openRun(runId) {
    this.activeRunId = runId;
    this.renderRail();
    return this.openCurrentPage(new RunPage({
      runId, boot: this.boot, stream: this.stream,
      onBack: () => this.showDashboard(),
      onChanged: () => this.refreshRuns(),
    }));
  }

  async openCurrentPage(page) {
    this.openModal?.close?.(); this.openModal = null;
    this.currentPage?.destroy?.();
    this.currentPage = page;
    let content = this.mainEl.querySelector('.content');
    if (!content) { this.renderMain(); content = this.mainEl.querySelector('.content'); }
    await page.mountInto(content);
    document.getElementById('main-content')?.scrollIntoView({ block: 'start' });
  }

  showDashboard() {
    this.currentPage?.destroy?.();
    this.currentPage = null;
    this.activeRunId = null;
    this.renderMain();
    this.renderRail();
  }

  async afterDecision(runId) {
    await this.refreshRuns();
    const data = await api.run(runId);
    if (data.run.state === 'scoring') {
      this.openModal?.close?.();
      return this.openScorecard(runId);
    }
    if (data.run.state === 'approved') {
      this.openModal?.close?.();
      return this.openApproval(runId, data);
    }
  }

  async openScorecard(runId) {
    const gate = new ScorecardGate({ runId, onComplete: () => this.openApproval(runId) });
    this.openModal = { close: () => {} };
    await gate.open();
  }

  async openApproval(runId, data = null) {
    const run = data ?? await api.run(runId);
    const overrides = {};
    if (run.skill.writeTargets.includes('confluence_page')) {
      overrides.space = 'alberta';
      overrides.title = `${run.template.title} — ${run.run.epicRef ?? run.run.title}`;
    }
    if (run.skill.writeTargets.includes('jira_issue')) {
      overrides.assignee = run.run.inputs.assignee ?? this.boot.actor;
      // Demonstrates the partial-failure + retry-only-failures path (FR-PUBLISH-003).
      overrides.simulatePartialFailure = true;
    }
    const gate = new ApprovalGate({ runId, onPublished: () => this.refreshRuns() });
    this.openModal = { close: () => {} };
    await gate.open(overrides);
  }

  async openPublished(runId, data) {
    const final = data.candidates.slice(-1)[0];
    const { Modal } = await import('./components/ui.js');
    const body = h('div', { class: 'stack stack-4' },
      Banner({ tone: 'success', title: 'Published',
               message: 'This run is complete and its provenance is sealed.' }),
      h('div', { class: 'row wrap' },
        Button({ label: 'View provenance', variant: 'secondary', onClick: () => openProvenance(runId) }),
        Button({ label: 'Systems of record', variant: 'secondary', onClick: () => openSor() })),
      final && h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Published artifact',
          h('span', { class: 'count' }, `${final.wordCount.toLocaleString()} words`)),
        h('div', { class: 'panel-body' },
          (await import('./components/ui.js')).DocumentView(final.body))),
    );
    const modal = Modal({ title: data.run.title, subtitle: data.run.statusLabel, body,
                          onClose: () => modal.remove(), labelledBy: 'pub-title' });
    mount(document.body, modal);
    this.openModal = { close: () => modal.remove() };
  }

  onStreamEvent(ev) {
    // Long waits are survivable: a run continues if the user navigates away, the session list
    // shows live status, and a toast fires on completion (design-system §7.4).
    if (ev.type === 'run.phase' && ['published', 'failed'].includes(ev.payload?.to)) {
      this.refreshRuns();
    }
    if (['writer.settled', 'verdict.ready', 'run.failed', 'publish.result'].includes(ev.type)) {
      this.refreshRuns();
    }
    if (ev.type === 'verdict.ready' && ev.payload.runId !== this.activeRunId) {
      toast('A council run is ready for your decision.', 'warning', 8000);
    }
  }
}

new App().start();
