// Settings, the read-only admin console (FR-ADMIN-001…008), run history, and the mock
// systems-of-record browser.
//
// The console is READ-ONLY in R1 (FR-ADMIN-007): every figure comes from the cost ledger and
// run records, and configuration changes are made in versioned files and apply on restart.

import { h, mount, frag, clear, Button, Chip, Badge, Banner, Modal, EmptyState, KV, ScoreTile,
         Progress, DocumentView, band, toast } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { relativeTime } from '../../lib/reducer.js';

/** A simple bar chart from tokens only — no chart library, no literal colours. */
function barChart(rows, { labelKey = 'key', valueKey = 'premiumRequests', max = null } = {}) {
  if (rows.length === 0) {
    // §13.2: an empty range says so — never a zero chart pretending to be data.
    return h('div', { class: 'caption muted' }, 'No runs in this period');
  }
  const peak = max ?? Math.max(...rows.map((r) => r[valueKey] ?? 0), 1);
  return h('div', { class: 'stack stack-2' }, rows.map((r) => h('div', { class: 'stack stack-1' },
    h('div', { class: 'row caption' },
      h('span', { class: 'grow' }, String(r[labelKey])),
      h('span', { class: 'num' }, String(r[valueKey]))),
    h('div', { class: 'meter-track' },
      h('div', { class: 'meter-fill', style: `width:${((r[valueKey] ?? 0) / peak) * 100}%` })))));
}

export async function openAdminConsole() {
  const [usage, runs, boot] = await Promise.all([api.adminUsage(), api.adminRuns(), api.bootstrap()]);
  let tab = 'overview';

  const body = h('div', { class: 'stack stack-4' });
  const modal = Modal({
    title: 'Admin console', labelledBy: 'admin-title',
    subtitle: 'Read-only. Every figure comes from the cost ledger — all tabs reconcile to one total.',
    body, onClose: () => modal.remove(),
  });

  const draw = () => {
    clear(body);
    const t = usage.totals;

    mount(body, h('div', { class: 'row wrap' },
      ['overview', 'runs', 'context strategy', 'size bands', 'estimate calculator', 'audit'].map((id) =>
        Button({ label: id.replace(/\b\w/g, (c) => c.toUpperCase()),
                 variant: tab === id ? 'primary' : 'ghost', size: 'sm',
                 onClick: () => { tab = id; draw(); } }))));

    if (usage.empty) {
      mount(body, Banner({ tone: 'info', message: 'No runs in this period.' }));
    }

    if (tab === 'overview') {
      mount(body, 
        h('div', { class: 'grid-4' },
          h('div', { class: 'card' }, ScoreTile({ value: t.runs, label: 'Runs', tone: '' })),
          h('div', { class: 'card' }, ScoreTile({ value: t.premiumRequests, label: 'Premium requests', tone: '' })),
          h('div', { class: 'card' }, ScoreTile({ value: t.averagePremiumRequestsPerRun, label: 'Average per run', tone: '' })),
          h('div', { class: 'card' }, ScoreTile({ value: t.published, label: 'Published artifacts', tone: '' })),
          h('div', { class: 'card' }, ScoreTile({ value: t.failedOrCancelled, label: 'Failed / cancelled', tone: '' })),
          h('div', { class: 'card' }, ScoreTile({ value: t.meanSectionAccuracy, label: 'Mean section accuracy', caption: 'from G4 scorecards' })),
          h('div', { class: 'card' }, ScoreTile({ value: t.qualityThresholdOverrides, label: 'Quality overrides', tone: '' })),
          h('div', { class: 'card' }, ScoreTile({ value: (t.totalTokens / 1000).toFixed(0) + 'k', label: 'Tokens', tone: '' })),
        ),
        h('div', { class: 'grid-2' },
          h('div', { class: 'panel' }, h('div', { class: 'section-bar' }, 'Premium requests by phase'),
            h('div', { class: 'panel-body' }, barChart(usage.byPhase))),
          h('div', { class: 'panel' }, h('div', { class: 'section-bar' }, 'By model family'),
            h('div', { class: 'panel-body' }, barChart(usage.byModelFamily))),
          h('div', { class: 'panel' }, h('div', { class: 'section-bar' }, 'By skill'),
            h('div', { class: 'panel-body' }, barChart(usage.bySkill))),
          h('div', { class: 'panel' }, h('div', { class: 'section-bar' }, 'By day'),
            h('div', { class: 'panel-body' }, barChart(usage.byDay))),
        ),
        // FR-ADMIN-002 made visible: the reconciliation is shown, not merely claimed.
        h('div', { class: 'panel' },
          h('div', { class: 'section-bar' }, 'Ledger reconciliation'),
          h('div', { class: 'panel-body stack stack-2' },
            h('div', { class: 'caption muted' },
              'Every grouping below is a different cut of the same cost ledger. They must agree.'),
            KV([
              ['Ledger total', `${t.premiumRequests} premium requests`],
              ['Sum by phase', sum(usage.byPhase)],
              ['Sum by family', sum(usage.byModelFamily)],
              ['Sum by skill', sum(usage.bySkill)],
            ]),
            reconciles(usage, t)
              ? Banner({ tone: 'success', message: 'All groupings reconcile to the ledger total.' })
              : Banner({ tone: 'danger', message: 'Groupings do not reconcile — the ledger and a projection disagree.' }),
          )),
        h('div', { class: 'panel' },
          h('div', { class: 'section-bar' }, 'Accuracy by skill'),
          h('div', { class: 'panel-body' },
            usage.accuracyBySkill.length === 0
              ? h('div', { class: 'caption muted' }, 'No scorecards completed yet.')
              : h('table', {},
                  h('thead', {}, h('tr', {}, h('th', {}, 'Skill'), h('th', { class: 'num' }, 'Scorecards'),
                    h('th', { class: 'num' }, 'Mean accuracy'), h('th', { class: 'num' }, 'Mean effort saved'))),
                  h('tbody', {}, usage.accuracyBySkill.map((a) => h('tr', {},
                    h('td', {}, a.skillId),
                    h('td', { class: 'num' }, String(a.scorecards)),
                    h('td', { class: `num ${band(a.meanAccuracy)}` }, `${a.meanAccuracy ?? '—'}%`),
                    h('td', { class: 'num' }, `${a.meanEffortSaved ?? '—'}%`)))))),
        ),
      );
    }

    if (tab === 'runs') {
      mount(body, h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Runs ledger'),
        h('div', { class: 'panel-body', style: 'overflow-x:auto' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, 'Run'), h('th', {}, 'Skill'), h('th', {}, 'Actor'), h('th', {}, 'State'),
              h('th', {}, 'Model families'), h('th', { class: 'num' }, 'Premium req.'),
              h('th', { class: 'num' }, 'Estimate'), h('th', { class: 'num' }, 'Variance'),
              h('th', {}, 'Band'), h('th', {}, 'Phases'))),
            h('tbody', {}, runs.rows.map((r) => h('tr', {},
              h('td', { class: 'small' }, r.title),
              h('td', { class: 'small' }, r.skillId),
              h('td', { class: 'small' }, r.actor),
              h('td', { class: 'small' }, frag(r.state, r.degraded && frag(' ', Chip({ label: 'degraded', tone: 'warning' })))),
              // FR-ADMIN-003: an unresolved model shows "unknown model" AS MEASURED.
              h('td', { class: 'small' }, r.modelFamilies.join(', ')),
              h('td', { class: 'num' }, String(r.premiumRequests)),
              h('td', { class: 'num muted' }, String(r.estimatePremiumRequests ?? '—')),
              h('td', { class: 'num' }, r.variancePercent == null ? '—' : `${r.variancePercent}%`),
              h('td', { class: 'small' }, r.sizeBand),
              h('td', { class: 'caption muted' },
                Object.entries(r.phaseBreakdown ?? {}).map(([k, v]) => `${k} ${v.premiumRequests}`).join(' · ')))))))));
    }

    if (tab === 'context strategy') {
      const cs = usage.contextStrategy;
      mount(body, 
        Banner({ tone: 'info', message: 'Comparison of runs by how much evidence the Captain was shown.' }),
        h('div', { class: 'grid-2' },
          ['full_context', 'retrieval_budgeted'].map((k) => h('div', { class: 'panel' },
            h('div', { class: 'section-bar' }, k.replace('_', ' ')),
            h('div', { class: 'panel-body stack stack-2' },
              // FR-ADMIN-005: each label carries an INLINE DEFINITION.
              h('div', { class: 'caption muted' }, cs.definitions[k]),
              KV([['Runs', cs[k].runs],
                  ['Mean premium requests', cs[k].meanPremiumRequests],
                  ['Mean section accuracy', cs[k].meanSectionAccuracy != null ? `${cs[k].meanSectionAccuracy}%` : null]]))))));
    }

    if (tab === 'size bands') {
      mount(body, h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Size bands'),
        h('div', { class: 'panel-body stack stack-3' },
          h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Band'), h('th', {}, 'Range'), h('th', { class: 'num' }, 'Runs'))),
            h('tbody', {}, usage.sizeBands.map((b) => h('tr', {},
              h('td', {}, b.label),
              h('td', { class: 'small mono' }, b.maxPremiumRequests === null ? '> previous' : `¤ ${b.maxPremiumRequests} premium requests`),
              h('td', { class: 'num' }, String(usage.sizeBandCounts[b.id] ?? 0)))))),
          // FR-ADMIN-006, verbatim.
          Banner({ tone: 'info',
            message: 'Bands classify runs for reporting only. They never choose models, writers or phases.' }))));
    }

    if (tab === 'estimate calculator') {
      const skills = boot.catalogue.skills;
      let skillId = skills[0].id;
      let out = null;
      const result = h('div', { class: 'stack stack-3' });
      const recalc = async () => {
        clear(result);
        mount(result, h('div', { class: 'row' }, h('span', { class: 'spinner' })));
        try {
          out = await api.adminEstimate({ skillId, contextChars: 4000 });
          clear(result);
          const e = out.estimate;
          mount(result, 
            h('div', { class: 'row wrap' },
              Chip({ label: `${e.premiumRequestsLow}–${e.premiumRequestsHigh} premium requests`, tone: 'accent' }),
              Chip({ label: `${e.estimatedTotalTokens.toLocaleString()} tokens` }),
              Chip({ label: `${e.totalCalls} calls` })),
            KV([['Per-run limit', e.perRunLimit], ['Daily limit', e.dailyLimit],
                ['Daily remaining', e.dailyRemaining]]),
            // FR-ADMIN-004: the multiplier reference, rendered FROM THE REGISTRY.
            h('div', { class: 'panel' },
              h('div', { class: 'section-bar' }, 'Multiplier reference'),
              h('div', { class: 'panel-body' },
                h('table', {},
                  h('thead', {}, h('tr', {}, h('th', {}, 'Model'), h('th', {}, 'Family'),
                    h('th', { class: 'num' }, 'Multiplier'), h('th', { class: 'num' }, 'Context'), h('th', {}, 'Status'))),
                  h('tbody', {}, out.multiplierReference.map((m) => h('tr', {},
                    h('td', {}, m.displayName), h('td', {}, m.family),
                    h('td', { class: 'num' }, String(m.multiplier)),
                    h('td', { class: 'num' }, m.contextWindow.toLocaleString()),
                    h('td', {}, m.status === 'deprecated' ? Chip({ label: 'deprecated', tone: 'warning' }) : m.status))))))),
          );
        } catch (err) { clear(result); mount(result, Banner({ tone: 'danger', message: err.message })); }
      };
      mount(body, 
        h('div', { class: 'field' },
          h('label', { for: 'calc-skill' }, 'Skill'),
          h('select', { id: 'calc-skill', onchange: (e) => { skillId = e.target.value; recalc(); } },
            skills.map((s) => h('option', { value: s.id }, `${s.name} (${s.councilIndicator})`)))),
        result);
      recalc();
    }

    if (tab === 'audit') {
      const host = h('div', {});
      mount(body, 
        Banner({ tone: 'info', message: 'Content-free audit events: no prompt text, no source content, no secrets, no personal data.' }),
        host);
      api.audit('?limit=200').then(({ events }) => {
        clear(host);
        mount(host, h('div', { class: 'panel' },
          h('div', { class: 'section-bar' }, 'Audit trail'),
          h('div', { class: 'panel-body', style: 'overflow-x:auto' },
            h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Category'), h('th', {}, 'Action'),
                h('th', {}, 'Outcome'), h('th', {}, 'Reason'), h('th', {}, 'Requirement'), h('th', {}, 'Actor'))),
              h('tbody', {}, events.map((e) => h('tr', {},
                h('td', { class: 'caption' }, new Date(e.createdAt).toLocaleTimeString()),
                h('td', { class: 'small' }, e.category),
                h('td', { class: 'small' }, e.action),
                h('td', {}, Chip({ label: e.outcome,
                  tone: e.outcome === 'allowed' ? 'success' : e.outcome === 'blocked' ? 'warning' : 'danger' })),
                h('td', { class: 'caption muted' }, e.reasonCode ?? '—'),
                h('td', { class: 'caption mono' }, e.requirementId ?? '—'),
                h('td', { class: 'small' }, e.actor))))))));
      });
    }
  };

  draw();
  mount(document.body, modal);
  return modal;
}

const sum = (rows) => Math.round(rows.reduce((a, r) => a + (r.premiumRequests ?? 0), 0) * 100) / 100;
const reconciles = (usage, t) =>
  [usage.byPhase, usage.byModelFamily, usage.bySkill].every((g) => Math.abs(sum(g) - t.premiumRequests) < 0.02);

/** Settings (§9). Read-only in the PoC; the source is versioned configuration. */
export async function openSettings({ boot, onThemeChange }) {
  const health = await api.health();
  const body = h('div', { class: 'stack stack-4' });
  const modal = Modal({ title: 'Settings', labelledBy: 'set-title', body,
                        onClose: () => modal.remove() });

  const section = (title, content) => h('div', { class: 'panel' },
    h('div', { class: 'section-bar' }, title), h('div', { class: 'panel-body' }, content));

  mount(body, 
    section('Appearance', h('div', { class: 'row' },
      h('span', { class: 'grow' }, 'Theme'),
      Button({ label: 'Dark', variant: document.documentElement.dataset.theme === 'dark' ? 'primary' : 'secondary',
               size: 'sm', onClick: () => onThemeChange('dark') }),
      Button({ label: 'Light', variant: document.documentElement.dataset.theme === 'light' ? 'primary' : 'secondary',
               size: 'sm', onClick: () => onThemeChange('light') }))),

    // FR-MODEL-002: the registry table — logical name → provider → canonical display name →
    // context window → multiplier → status. Read-only; the source is config.
    section('Models', h('div', { class: 'stack stack-2' },
      h('div', { class: 'caption muted' },
        `Transport: ${boot.transport} — ${boot.transportDescription}`),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Logical'), h('th', {}, 'Display name'), h('th', {}, 'Provider'),
          h('th', {}, 'Family'), h('th', { class: 'num' }, 'Context'), h('th', { class: 'num' }, 'Multiplier'),
          h('th', {}, 'Status'), h('th', {}, 'Reachable'))),
        h('tbody', {}, boot.models.map((m) => h('tr', {},
          h('td', { class: 'caption mono' }, m.logicalNames.join(', ') || '—'),
          h('td', {}, m.displayName),
          h('td', { class: 'small' }, m.provider),
          h('td', { class: 'small' }, m.family),
          h('td', { class: 'num' }, m.contextWindow.toLocaleString()),
          h('td', { class: 'num' }, String(m.multiplier)),
          h('td', {}, m.status === 'deprecated'
            ? Chip({ label: `deprecated → ${m.replacedBy ?? '?'}`, tone: 'warning' })
            : Chip({ label: m.status, tone: 'success' })),
          h('td', {}, m.reachableOnTransport ? '✓' : Chip({ label: 'not on this transport', tone: 'warning' })))))))),

    section('Budgets', h('div', { class: 'stack stack-3' },
      KV([
        ['Per-run premium requests', boot.budget.perRunPremiumRequests],
        ['Per-user daily premium requests', boot.budget.perUserDailyPremiumRequests],
        ['Warning threshold', `${boot.budget.warnPercent}%`],
        ['Per-run tokens', boot.budget.perRunTokens.toLocaleString()],
        ['Per-user daily tokens', boot.budget.perUserDailyTokens.toLocaleString()],
        ['Confirm above', `${boot.budget.confirmAbovePremiumRequests} premium requests`],
      ]),
      Banner({ tone: 'info',
        message: 'All budget values are mandatory configuration with no built-in defaults. The server refuses to start if any is unset.',
        requirementId: 'NFR-COST-002' }))),

    section('Knowledge bases', Banner({ tone: 'warning',
      message: 'No knowledge base is registered. The pilot\'s ~70% accuracy came substantially from domain corpora, not from prompts alone; without them output is generic-model quality (spec assumption A-09).' })),

    section('Config health', h('div', { class: 'stack stack-2' },
      h('div', { class: 'row' },
        Chip({ label: health.status, tone: health.status === 'ok' ? 'success' : 'warning' }),
        h('span', { class: 'caption mono' }, health.configHash)),
      h('div', { class: 'stack stack-1' }, health.checks.map((c) => h('div', { class: 'row small' },
        h('span', { style: `color:var(--status-${c.status === 'ok' ? 'success' : c.status === 'degraded' ? 'warning' : 'danger'})`,
                    'aria-hidden': 'true' }, c.status === 'ok' ? '✓' : '✕'),
        h('span', { class: 'grow' }, c.name),
        h('span', { class: 'muted caption' }, c.detail ?? c.status)))))),

    section('About', KV([
      ['Version', '0.1.0-poc'], ['Actor', boot.actor], ['Config hash', boot.configHash],
      ['Skills', boot.catalogue.skills.length], ['Agents', boot.catalogue.agents.length],
      ['Sandbox', boot.sandboxAvailable ? 'available' : 'unavailable'],
    ])),
  );

  mount(document.body, modal);
  return modal;
}

/** Run history (§8). */
export async function openHistory(onOpenRun) {
  const { runs } = await api.listRuns('?limit=200');
  const body = h('div', { class: 'stack stack-3' });
  const modal = Modal({ title: 'Run history', labelledBy: 'hist-title', body, onClose: () => modal.remove() });

  if (runs.length === 0) {
    mount(body, EmptyState({ title: 'No runs yet' }));
  } else {
    const head = h('tr', {},
      h('th', {}, 'Title'), h('th', {}, 'Agent'), h('th', {}, 'Stage'), h('th', {}, 'Status'),
      h('th', { class: 'num' }, 'Quality'), h('th', {}, 'Started'), h('th', {}, ''));

    const rows = runs.map((r) => h('tr', {},
      h('td', { class: 'small' }, r.title),
      h('td', { class: 'small' }, r.agentAlias ? `${r.agentRole} · ${r.agentAlias}` : r.agentRole),
      h('td', { class: 'small' }, r.stageName),
      h('td', {}, h('div', { class: 'row' },
        h('span', { class: `dot dot-${r.statusKind}`, 'aria-hidden': 'true' }),
        h('span', { class: 'caption' }, r.statusLabel))),
      h('td', { class: `num ${band(r.qualityScore)}` }, r.qualityScore ?? '—'),
      h('td', { class: 'caption muted' }, relativeTime(r.createdAt)),
      h('td', {}, Button({
        label: 'Open', size: 'sm', variant: 'ghost',
        onClick: () => { modal.remove(); onOpenRun(r.id); },
      }))));

    mount(body, h('div', { class: 'panel' },
      h('div', { class: 'section-bar' }, `${runs.length} runs`),
      h('div', { class: 'panel-body', style: 'overflow-x:auto' },
        h('table', {}, h('thead', {}, head), h('tbody', {}, rows)))));
  }

  mount(document.body, modal);
  return modal;
}

/** Mock systems-of-record browser — shows what G5 actually wrote. */
export async function openSor(focusUrl = null) {
  const sor = await api.sor();
  const body = h('div', { class: 'stack stack-4' });
  const modal = Modal({
    title: 'Systems of record', labelledBy: 'sor-title',
    subtitle: 'Local mock Confluence, Jira and Bitbucket — what the approval gate actually wrote.',
    body, onClose: () => modal.remove(),
  });

  const viewPage = async (id) => {
    const { page } = await api.sorPage(id);
    clear(body);
    mount(body, 
      h('div', { class: 'row' },
        Button({ label: ' All records', variant: 'ghost', size: 'sm', onClick: () => draw() }),
        Chip({ label: `Confluence · space ${page.space}` }),
        Chip({ label: `v${page.version}` }),
        h('span', { class: 'caption muted right' }, `updated by ${page.updated_by} ${relativeTime(page.updated_at)}`)),
      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, page.title),
        h('div', { class: 'panel-body' }, DocumentView(page.body))),
      // Demo affordance for the stale-approval path: change the page under an approved proposal.
      h('div', { class: 'row' },
        Button({ label: 'Simulate an external edit', variant: 'secondary',
          title: 'Bumps the page version so an existing approval becomes stale (RCR-STALE-001)',
          onClick: async () => { await api.sorTouch(id); toast('Page edited externally — any open approval for it is now stale.', 'warning', 8000); viewPage(id); } })),
    );
  };

  const draw = () => {
    clear(body);
    mount(body, 
      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, `Confluence pages (${sor.confluence.length})`),
        h('div', { class: 'panel-body' }, sor.confluence.length === 0
          ? h('div', { class: 'caption muted' }, 'Nothing published yet.')
          : h('table', {}, h('tbody', {}, sor.confluence.map((p) => h('tr', {},
              h('td', {}, h('strong', { class: 'small' }, p.title)),
              h('td', { class: 'caption muted' }, `space ${p.space} · v${p.version}`),
              h('td', { class: 'caption muted' }, relativeTime(p.updated_at)),
              h('td', {}, Button({ label: 'View', size: 'sm', variant: 'ghost', onClick: () => viewPage(p.id) })))))))),

      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, `Jira issues (${sor.jira.length})`),
        h('div', { class: 'panel-body' }, sor.jira.length === 0
          ? h('div', { class: 'caption muted' }, 'Nothing published yet.')
          : h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, 'Key'), h('th', {}, 'Summary'), h('th', {}, 'Assignee'), h('th', {}, 'Status'))),
              h('tbody', {}, sor.jira.map((i) => h('tr', {},
                h('td', { class: 'small mono' }, i.id),
                h('td', { class: 'small' }, i.summary),
                // FR-PUBLISH-007: an unowned work item is a defect. Every row here has an owner.
                h('td', { class: 'small' }, i.assignee ?? Chip({ label: 'unassigned', tone: 'danger' })),
                h('td', { class: 'caption' }, i.status))))))),

      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, `Pull requests (${sor.pullRequests.length})`),
        h('div', { class: 'panel-body' }, sor.pullRequests.length === 0
          ? h('div', { class: 'caption muted' }, 'Nothing proposed yet.')
          : h('div', { class: 'stack stack-2' }, sor.pullRequests.map((pr) => h('div', { class: 'sunken' },
              KV([['Title', pr.title], ['Repository', pr.repository],
                  ['Branch', `${pr.branch} → ${pr.base_branch}`],
                  ['Change', `${pr.files_changed} files, +${pr.lines_added} -${pr.lines_removed}`],
                  ['State', pr.state], ['Opened by', pr.created_by]]))))),
      ),

      Banner({ tone: 'info',
        message: 'These are local mock stores. The adapters implement the real publish contract — dry-run preview, ' +
                 'deterministic idempotency key, stale-check anchor and per-item results — so swapping in REST calls ' +
                 'touches only each adapter\'s apply function. The SCM adapter has no push capability at all.' }),
    );
  };

  if (focusUrl?.startsWith('/sor/confluence/')) viewPage(focusUrl.split('/').pop());
  else draw();
  mount(document.body, modal);
  return modal;
}
