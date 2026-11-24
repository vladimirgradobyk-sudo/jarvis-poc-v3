// Gate G4 (section scorecard), gate G5 (approval), publish result, provenance.

import { h, mount, frag, clear, Button, Chip, Badge, Banner, Modal, Field, EmptyState, KV,
         ScoreTile, Progress, DocumentView, band, toast } from '../../components/ui.js';
import { api } from '../../lib/api.js';

const VERDICTS = [
  { value: 'accurate',     label: 'Accurate' },
  { value: 'minor_rework', label: 'Minor rework' },
  { value: 'major_rework', label: 'Major rework' },
  { value: 'unusable',     label: 'Unusable' },
];

/**
 * Gate G4 — the section scorecard. THE ACCURACY INSTRUMENT.
 *
 * This productises the pilot architect's hand-maintained 25-row Confluence table, which is the
 * only place quality was ever actually measured. It is DELIBERATELY EFFORTFUL so reviewers
 * cannot skim: FR-SCORE-006 forbids auto-fill, inference and apply-to-all, and the server
 * refuses to complete the scorecard while any row is unscored (FR-SCORE-001).
 */
export class ScorecardGate {
  constructor({ runId, onComplete }) {
    this.runId = runId;
    this.onComplete = onComplete;
    this.card = null;
    this.artifact = null;
  }

  async open() {
    const [cardRes, run] = await Promise.all([api.scorecard(this.runId), api.run(this.runId)]);
    this.card = cardRes.scorecard;
    this.artifact = run.candidates.find((c) => c.id === this.card.candidateId) ?? run.candidates.slice(-1)[0];
    this.body = h('div', { class: 'stack stack-4' });
    this.modal = Modal({
      title: `Review and score — ${run.skill.name}`,
      subtitle: 'Score each section before publishing. This is how we measure whether the agent is actually helping.',
      body: this.body, onClose: () => this.modal.remove(), labelledBy: 'score-title',
    });
    mount(document.body, this.modal);
    this.draw();
    return this.modal;
  }

  async refresh() {
    this.card = (await api.scorecard(this.runId)).scorecard;
    this.draw();
  }

  draw() {
    clear(this.body);
    const c = this.card;
    const remaining = c.totalRows - c.scoredRows;

    mount(this.body, 
      h('div', { class: 'row wrap' },
        Chip({ label: `${c.scoredRows} / ${c.totalRows} sections scored`,
               tone: c.complete ? 'success' : 'warning' }),
        c.aggregateAccuracy != null && Chip({ label: `accuracy ${c.aggregateAccuracy}%` }),
        c.aggregateEffortSavedPercent != null && Chip({ label: `saving ${c.aggregateEffortSavedPercent}%`, tone: 'accent' }),
        c.status === 'complete' && Badge({ label: 'Complete' })),
      Progress({ value: c.scoredRows, max: c.totalRows, tone: c.complete ? '' : 'warn' }),

      c.complete && c.aggregateAccuracy != null && c.aggregateAccuracy < 50 && Banner({
        tone: 'warning',
        message: `This artifact scored ${c.aggregateAccuracy}%. Consider regenerating rather than correcting by hand.` }),

      Banner({ tone: 'info',
        message: 'Nothing here is auto-filled, inferred, or copied across rows. The effort is the point — ' +
                 'it is the only measurement of whether the agent helped, and a skimmed scorecard measures nothing.',
        requirementId: 'FR-SCORE-006' }),

      // One row per scorable template section, in template order.
      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Section scorecard'),
        h('div', { class: 'panel-body', style: 'overflow-x:auto' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, '#'), h('th', {}, 'Section'),
              h('th', { class: 'num' }, 'Manual effort (hrs)'),
              h('th', {}, 'Agent output quality'),
              h('th', { class: 'num' }, 'Rework (hrs)'),
              h('th', { class: 'num' }, 'Accuracy %'),
              h('th', { class: 'num' }, 'Saving'),
              h('th', {}, ''))),
            h('tbody', {}, c.rows.map((r, i) => this.row(r, i))))),
      ),

      h('div', { class: 'row' },
        Button({
          label: 'Continue to approval',
          variant: 'primary',
          // Disabled AND the server refuses — the control is not merely a UI affordance.
          disabled: !c.complete || c.status === 'complete',
          title: c.complete ? null : `${remaining} section${remaining === 1 ? '' : 's'} remaining`,
          onClick: async () => {
            try {
              const res = await api.completeScorecard(c.id);
              toast(`Scorecard complete — accuracy ${res.scorecard.aggregateAccuracy}%, saving ${res.scorecard.aggregateEffortSavedPercent}%.`, 'success');
              this.modal.remove();
              this.onComplete?.(res.run);
            } catch (err) {
              this.body.prepend(Banner({ tone: 'danger', message: err.message, requirementId: err.requirementId }));
            }
          },
        }),
        !c.complete && h('span', { class: 'small muted' },
          `${remaining} section${remaining === 1 ? '' : 's'} remaining`),
        Button({ label: 'Close', onClick: () => this.modal.remove() }),
      ),
    );
  }

  row(r, i) {
    const scored = r.scored;
    const manual = h('input', { type: 'number', min: '0', step: '0.5', value: r.manualEffortHours ?? '',
                                'aria-label': `Manual effort for ${r.heading}`, disabled: this.card.status === 'complete' });
    const rework = h('input', { type: 'number', min: '0', step: '0.5', value: r.reworkHours ?? '',
                                'aria-label': `Rework for ${r.heading}`, disabled: this.card.status === 'complete' });
    const accuracy = h('input', { type: 'number', min: '0', max: '100', step: '1', value: r.accuracyPercent ?? '',
                                  'aria-label': `Accuracy for ${r.heading}`, disabled: this.card.status === 'complete' });
    const verdict = h('select', { 'aria-label': `Quality for ${r.heading}`, disabled: this.card.status === 'complete' },
      h('option', { value: '' }, 'Select…'),
      VERDICTS.map((v) => h('option', { value: v.value, selected: r.verdict === v.value }, v.label)));
    const findings = h('input', { type: 'text', value: r.findings ?? '', placeholder: 'What needed correcting?',
                                  'aria-label': `Findings for ${r.heading}`, disabled: this.card.status === 'complete' });

    const save = async () => {
      if (!verdict.value || manual.value === '' || rework.value === '' || accuracy.value === '') return;
      try {
        await api.scoreSection(this.card.id, r.sectionId, {
          verdict: verdict.value,
          manualEffortHours: Number(manual.value),
          reworkHours: Number(rework.value),
          accuracyPercent: Number(accuracy.value),
          findings: findings.value || null,
        });
        await this.refresh();
      } catch (err) {
        toast(err.message, 'danger', 8000);
      }
    };
    for (const el of [manual, rework, accuracy, findings]) el.addEventListener('change', save);
    verdict.addEventListener('change', save);

    return h('tr', { style: scored ? '' : 'background:var(--banner-warning-bg)' },
      h('td', { class: 'num muted' }, String(i + 1)),
      h('td', {}, h('div', { class: 'stack stack-1' },
        h('strong', {}, r.heading),
        // The hint is help text, never a pre-filled value.
        r.manualEffortHint != null && h('span', { class: 'caption muted' }, `typical: ${r.manualEffortHint}h`),
        findings)),
      h('td', { class: 'num' }, manual),
      h('td', {}, verdict),
      h('td', { class: 'num' }, rework),
      h('td', { class: 'num' }, accuracy),
      // Computed server-side and echoed back — the client never calculates it (FR-API-030).
      h('td', { class: `num ${band(r.effortSavedPercent)}` },
        r.effortSavedPercent == null ? '—' : `${r.effortSavedPercent}%`),
      h('td', {}, scored ? h('span', { class: 'chip chip-success' }, '✓ scored') : h('span', { class: 'caption muted' }, 'unscored')),
    );
  }
}

/**
 * Gate G5 — the approval gate. The mandatory human decision before ANY external write.
 *
 * The approval binds to the exact proposal version AND operation fingerprint, so you cannot
 * approve something other than what you were shown (FR-API-040). Focus lands on the summary,
 * never on the approve button (screen-specs §6.2).
 */
export class ApprovalGate {
  constructor({ runId, onPublished }) {
    this.runId = runId;
    this.onPublished = onPublished;
    this.proposal = null;
    this.approval = null;
    this.results = null;
    this.confirmed = false;
    this.note = '';
  }

  async open(targetOverrides = {}) {
    this.run = await api.run(this.runId);
    this.targetOverrides = targetOverrides;
    this.body = h('div', { class: 'stack stack-4' });
    this.modal = Modal({
      title: 'Approve publication', labelledBy: 'g5-title',
      subtitle: 'Nothing is written until you approve this exact version.',
      body: this.body, onClose: () => this.modal.remove(),
    });
    mount(document.body, this.modal);
    await this.createProposal();
    return this.modal;
  }

  async createProposal() {
    clear(this.body);
    mount(this.body, h('div', { class: 'row' }, h('span', { class: 'spinner' }), h('span', {}, 'Building the proposal…')));
    const needsPr = this.run.skill.writeTargets.includes('pull_request');
    try {
      const res = await api.createProposal(this.runId, {
        ...this.targetOverrides,
        // FR-PUBLISH-005: a PR needs the explicit confirmation, which is collected below and
        // then re-sent as part of the target — so the fingerprint covers it.
        confirmed: needsPr ? this.confirmed : undefined,
      });
      this.proposal = res.proposal;
      this.draw();
    } catch (err) {
      clear(this.body);
      mount(this.body, 
        Banner({ tone: 'danger', title: 'Publication is blocked', message: err.message,
                 requirementId: err.requirementId }),
        err.detail?.placeholders && h('div', { class: 'panel' },
          h('div', { class: 'section-bar' }, 'Unresolved placeholders'),
          h('div', { class: 'panel-body' },
            h('ul', {}, err.detail.placeholders.map((p) =>
              h('li', { class: 'small' }, h('strong', {}, p.sectionHeading), `: "${p.text}"`))))),
        err.detail?.findings && h('ul', {},
          err.detail.findings.map((f) => h('li', { class: 'small' }, f.message))),
        // The remedy is offered WHERE THE BLOCK APPEARS. FR-GEN-005 refuses to publish a draft
        // that admits a gap, and FR-REVIEW-004 makes a recorded human edit the resolution — so
        // a dead-end banner would leave the reviewer with nowhere to go. The gate is not waived.
        err.code === 'placeholders_present' && h('div', { class: 'caption muted' },
          'Supply the missing values. Your revision is recorded as a new version with provenance; ' +
          'the original is never altered, and publication stays blocked until no gap remains.'),
        h('div', { class: 'row' },
          err.code === 'placeholders_present' && Button({
            label: 'Edit to resolve', variant: 'primary', onClick: () => this.openEditor() }),
          Button({ label: 'Close', onClick: () => this.modal.remove() })),
      );
    }
  }

  /** In-place editor for a blocked artifact, so G5 is a gate rather than a wall. */
  async openEditor() {
    const run = await api.run(this.runId);
    const ranked = [...run.candidates].reverse();
    const target = ranked.find((c) => c.origin === 'human_edit')
                ?? ranked.find((c) => c.origin === 'synthesis')
                ?? ranked.find((c) => c.placeholders.length > 0)
                ?? ranked[0];

    const ta = h('textarea', { rows: '20', style: 'font:var(--text-mono-small)' });
    ta.value = target.body;
    const summary = h('input', { type: 'text', id: 'edit-summary',
                                 placeholder: 'What did you change, and why?' });

    const editor = Modal({
      title: 'Edit before publishing', size: 'md', labelledBy: 'g5edit-title',
      subtitle: `Resolve every TBD [UNKNOWN ...] marker in ${target.writerDisplayName}.`,
      body: h('div', { class: 'stack stack-3' },
        Banner({ tone: 'info',
                 message: 'The edit is attributed to you in provenance, and the original draft is kept.' }),
        h('div', { class: 'field' }, h('label', { for: 'edit-summary' }, 'Change summary'), summary),
        ta),
      footer: frag(
        Button({ label: 'Save revision', variant: 'primary', onClick: async () => {
          try {
            await api.editCandidate(target.id, { body: ta.value, summary: summary.value || 'Human revision.' });
            toast('Revision saved. Rebuilding the proposal.', 'success');
            editor.remove();
            await this.createProposal();
          } catch (e) { toast(e.message, 'danger', 9000); }
        } }),
        Button({ label: 'Cancel', onClick: () => editor.remove() }),
      ),
      onClose: () => editor.remove(),
    });
    document.body.append(editor);
    ta.focus();
  }

  draw() {
    clear(this.body);
    const p = this.proposal;
    const needsPr = p.targets.some((t) => t.kind === 'pull_request');
    const blockers = p.preflight.filter((c) => !c.pass);

    // PublishTargetSummary — exactly what will happen, per target.
    mount(this.body, 
      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, `What will be written`,
          h('span', { class: 'count' }, `${p.targets.length} target${p.targets.length === 1 ? '' : 's'}`)),
        h('div', { class: 'panel-body stack stack-3' },
          p.targetSummaries.slice(0, 12).map((t) => h('div', { class: 'sunken' },
            KV([
              ['System', t.system],
              ['Destination', t.destination],
              ['Operation', t.operation],
              ['Title', t.title],
              t.assignee !== undefined ? ['Assignee', t.assignee] : null,
              t.branch ? ['Branch', `${t.branch} → ${t.baseBranch}`] : null,
              t.filesChanged ? ['Change', `${t.filesChanged} files, +${t.linesAdded} -${t.linesRemoved}`] : null,
            ].filter(Boolean)))),
          p.targets.length > 12 && h('div', { class: 'caption muted' },
            `+${p.targets.length - 12} more target(s) of the same shape.`),
        ),
      ),

      // Pre-flight checks, each pass/fail WITH A REASON.
      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Pre-flight checks'),
        h('div', { class: 'panel-body stack stack-2' },
          p.preflight.map((c) => h('div', { class: 'row small' },
            h('span', { style: `color:var(--status-${c.pass ? 'success' : 'danger'})`, 'aria-hidden': 'true' },
              c.pass ? '✓' : '✕'),
            h('span', { class: 'grow' }, c.label),
            h('span', { class: 'muted' }, c.message),
            h('span', { class: 'visually-hidden' }, c.pass ? 'passed' : 'failed'))),
        ),
      ),

      p.validationFindings.length > 0 && frag(p.validationFindings.map((f) => Banner({
        tone: f.blocking ? 'danger' : 'warning', message: f.message }))),

      p.status === 'stale' && Banner({
        tone: 'danger', title: 'The target changed since this draft was generated',
        message: 'Review the current version before approving. The approval would otherwise authorise a write against a target you have not seen.',
        requirementId: 'RCR-STALE-001',
        actions: [Button({ label: 'Rebuild proposal', size: 'sm', variant: 'primary',
                           onClick: () => this.createProposal() })] }),

      // FR-PUBLISH-005: opening a PR requires a confirmation that NAMES repository, branch and
      // target branch, and states the PR will be visible to the team.
      needsPr && h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Confirmation required'),
        h('div', { class: 'panel-body' },
          h('label', { class: 'check-opt' },
            h('input', { type: 'checkbox', checked: this.confirmed,
              onchange: (e) => { this.confirmed = e.target.checked; this.createProposal(); } }),
            h('span', {}, `I confirm a pull request may be opened against ` +
              `${p.targets[0].repository} (${p.targets[0].branch} → ${p.targets[0].baseBranch}), ` +
              `and that it will be visible to the team.`)))),

      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Your approval'),
        h('div', { class: 'panel-body stack stack-3' },
          Field({ id: 'appr-note', label: 'Review note',
                  help: 'Recorded in the audit trail against your name. What did you check?',
                  control: h('input', { type: 'text', id: 'appr-note',
                    placeholder: 'e.g. Reviewed sections 4–7 against the source material',
                    oninput: (e) => { this.note = e.target.value; } }) }),
          KV([['Proposal', `${p.id} v${p.version}`],
              ['Fingerprint', p.operationFingerprint],
              ['Approver', this.run.run.createdBy]]),
          h('div', { class: 'caption muted' },
            'Your approval is bound to this version and fingerprint, and is single-use. ' +
            'If the draft or the target changes, the approval becomes void.'),
          h('div', { class: 'row wrap' },
            Button({ label: 'Approve and publish', variant: 'primary', disabled: blockers.length > 0,
                     title: blockers.length ? `Blocked: ${blockers[0].label}` : null,
                     onClick: () => this.approveAndPublish() }),
            Button({ label: 'Reject', variant: 'danger', onClick: () => this.reject() }),
            Button({ label: 'Re-check target', variant: 'secondary', onClick: async () => {
              const r = await api.revalidate(p.id);
              this.proposal = { ...this.proposal, status: r.proposal.status };
              if (r.stale) toast('The target changed — the proposal is now stale.', 'warning', 8000);
              else toast('Target is unchanged.', 'success');
              this.draw();
            } }),
            Button({ label: 'Cancel', variant: 'ghost', onClick: () => this.modal.remove() })),
        ),
      ),
    );

    // Focus lands on the SUMMARY, never on the approve button (§6.2 keyboard note).
    this.body.querySelector('.panel')?.setAttribute('tabindex', '-1');
    this.body.querySelector('.panel')?.focus();
  }

  async approveAndPublish() {
    const p = this.proposal;
    try {
      const appr = await api.approve(p.id, {
        proposalVersion: p.version,
        operationFingerprint: p.operationFingerprint,
        note: this.note || null,
      });
      this.approval = appr.approval;
      const res = await api.publish(p.id, { approvalId: appr.approval.id });
      this.results = res;
      this.drawResults(res);
      this.onPublished?.(res.run);
    } catch (err) {
      this.body.prepend(Banner({ tone: 'danger', title: 'Not published', message: err.message,
                                 requirementId: err.requirementId }));
      this.body.scrollIntoView({ block: 'start' });
    }
  }

  async reject() {
    await api.reject(this.proposal.id, { note: this.note || 'Rejected at the approval gate.' });
    toast('Proposal rejected. Nothing was written.', 'info');
    this.modal.remove();
  }

  /** Publish result — reports precisely what succeeded and what did not (§6.3). */
  drawResults(res) {
    clear(this.body);
    const { results, summary } = res;
    const failed = results.filter((r) => !r.ok);

    mount(this.body, 
      Banner({
        tone: failed.length === 0 ? 'success' : 'warning',
        title: `${summary.succeeded} of ${summary.total} items published.`,
        message: failed.length === 0
          ? 'Every target was written. The run is published and its provenance is sealed.'
          : `${failed.length} item(s) failed. Only the failures can be retried — the successes are not re-sent.`,
      }),

      h('div', { class: 'panel' },
        h('div', { class: 'section-bar' }, 'Publish result'),
        h('div', { class: 'panel-body' },
          h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Target'), h('th', {}, 'Result'), h('th', {}, ''))),
            h('tbody', {}, results.map((r) => {
              const t = this.proposal.targetSummaries[r.targetIndex];
              return h('tr', {},
                h('td', { style: `color:var(--status-${r.ok ? 'success' : 'danger'})`, 'aria-hidden': 'true' },
                  r.ok ? '✓' : '✕'),
                h('td', {}, h('div', { class: 'stack stack-1' },
                  h('strong', { class: 'small' }, t?.title ?? `Target ${r.targetIndex}`),
                  h('span', { class: 'caption muted' }, `${t?.system} · ${t?.operation}`))),
                h('td', { class: 'small' }, r.ok
                  ? frag(h('a', { href: r.externalUrl, target: '_blank' }, r.externalId),
                         r.replayed && frag(' ', Chip({ label: 'replayed', title: 'Idempotent replay — no second write was performed' })))
                  : h('span', { style: 'color:var(--status-danger)' }, r.errorMessage)),
                h('td', {}, r.ok && Button({ label: 'View', size: 'sm', variant: 'ghost',
                  onClick: () => window.dispatchEvent(new CustomEvent('jarvis:view-sor', { detail: { url: r.externalUrl } })) })));
            })))),
      ),

      failed.length > 0 && h('div', { class: 'row' },
        Button({
          label: `Retry ${failed.length} failed item${failed.length === 1 ? '' : 's'}`,
          variant: 'primary',
          onClick: async () => {
            // A fresh approval is required: the previous one was consumed on use.
            try {
              const appr = await api.approve(this.proposal.id, {
                proposalVersion: this.proposal.version,
                operationFingerprint: this.proposal.operationFingerprint,
                note: 'Retry of failed items.',
              });
              const r2 = await api.publish(this.proposal.id, {
                approvalId: appr.approval.id,
                targetIndexes: failed.map((f) => f.targetIndex),
              });
              this.drawResults(r2);
            } catch (err) { toast(err.message, 'danger', 9000); }
          },
        }),
        h('span', { class: 'caption muted' },
          'Retrying reuses each target’s original idempotency key, so a successful item can never be created twice.')),

      h('div', { class: 'row' },
        Button({ label: 'View provenance', variant: 'secondary',
                 onClick: () => openProvenance(this.runId) }),
        Button({ label: 'Done', variant: 'ghost', onClick: () => this.modal.remove() })),
    );
  }
}

/** Provenance panel — how an artifact came to exist (§6.4). */
export async function openProvenance(runId) {
  let rec;
  try { rec = (await api.provenance(runId)).provenance; }
  catch { toast('No provenance record exists for this run yet.', 'warning'); return; }

  const body = h('div', { class: 'stack stack-4' });
  const modal = Modal({
    title: 'Provenance', labelledBy: 'prov-title',
    subtitle: rec.immutable ? 'Immutable — sealed on approval' : 'Draft — not yet sealed',
    body, onClose: () => modal.remove(),
  });

  const section = (title, content) => h('div', { class: 'panel' },
    h('div', { class: 'section-bar' }, title), h('div', { class: 'panel-body' }, content));

  mount(body, 
    rec.immutable && Banner({ tone: 'success', message: 'This record is immutable (FR-PROV-003). Publication facts were appended after approval.' }),

    section('Run', KV([
      ['Run', rec.runId], ['Skill', rec.skillId], ['Agent', rec.agentId], ['Stage', rec.stageId],
      ['Template', `${rec.templateId} v${rec.templateVersion}`],
      ['Config hash', rec.configHash], ['Transport', rec.transport],
    ])),

    section('Prompts', h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Role'), h('th', {}, 'File'), h('th', {}, 'Checksum'))),
      h('tbody', {}, (rec.promptHashes ?? []).map((p) => h('tr', {},
        h('td', { class: 'small' }, p.role), h('td', { class: 'small mono' }, p.ref),
        h('td', { class: 'small mono' }, p.hash)))))),

    section('Writers', h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Writer'), h('th', {}, 'Model'), h('th', {}, 'Family'),
                                 h('th', { class: 'num' }, 'Words'), h('th', { class: 'num' }, 'Premium req.'))),
      h('tbody', {}, (rec.writers ?? []).map((w) => h('tr', {},
        h('td', { class: 'small' }, w.displayName),
        // FR-MODEL-003: the canonical display name, identical to every other surface.
        h('td', { class: 'small' }, w.modelDisplayName),
        h('td', { class: 'small' }, w.family),
        h('td', { class: 'num' }, w.words ?? '—'),
        h('td', { class: 'num' }, w.premiumRequests ?? '—')))))),

    section('Reviews', h('div', { class: 'stack stack-2' },
      h('div', { class: 'row wrap caption' },
        Chip({ label: `${(rec.reviews ?? []).length} reviews` }),
        Chip({ label: `${(rec.reviews ?? []).filter((r) => r.isSelf).length} self-reviews flagged` }),
        Chip({ label: `Captain mode: ${rec.captainMode ?? '—'}` })),
      rec.verdict && KV([['Winner', rec.verdict.winnerCandidateId],
                         ['Captain model', rec.verdict.modelDisplayName],
                         ['Captain score', rec.verdict.evaluation != null
                           ? `${rec.verdict.evaluation.overallScore}/100` : null]]))),

    (rec.appliedSuggestions ?? []).length > 0 && section('Composition',
      h('div', { class: 'stack stack-2' },
        h('div', { class: 'caption muted' }, 'Cherry-picked improvements, with their origin.'),
        h('ul', {}, rec.appliedSuggestions.map((s) => h('li', { class: 'small' },
          `${s.sourceLabel ?? 'source'} → ${s.targetSectionId ?? 'artifact'}`))))),

    (rec.humanEdits ?? []).length > 0 && section('Human edits',
      h('ul', {}, rec.humanEdits.map((e) => h('li', { class: 'small' },
        `${e.actor} · ${new Date(e.at).toLocaleString()} — ${e.summary}`)))),

    section('Human decisions', h('ul', {},
      (rec.humanDecisions ?? []).map((d) => h('li', { class: 'small' },
        `${d.gate} ${d.action} by ${d.actor} at ${new Date(d.at).toLocaleString()}${d.note ? ` — "${d.note}"` : ''}`)))),

    section('Accuracy (G4)', KV([
      ['Aggregate accuracy', rec.aggregateAccuracy != null ? `${rec.aggregateAccuracy}%` : null],
      ['Effort saved', rec.aggregateEffortSavedPercent != null ? `${rec.aggregateEffortSavedPercent}%` : null],
      ['Scored by', rec.scoredBy],
    ])),

    section('Context', h('div', { class: 'stack stack-2' },
      KV([['Knowledge bases', (rec.knowledgeBases ?? []).length ? rec.knowledgeBases.join(', ') : null]]),
      // DegradedSourceBanner — names the unreachable source and the substitute used (FR-UX-006).
      (rec.degradedSources ?? []).map((d) => Banner({ tone: 'warning',
        message: `${d.source} could not be used. ${d.reason}` })))),

    section('Cost', KV([
      ['Premium requests', rec.cost?.premiumRequests], ['Tokens', rec.cost?.totalTokens?.toLocaleString()],
      ['Estimate', rec.cost?.estimate], ['Variance', rec.cost?.variancePercent != null ? `${rec.cost.variancePercent}%` : null],
    ])),

    section('Approval and publication', KV([
      ['Approved by', rec.approvedBy], ['Approved at', rec.approvedAt && new Date(rec.approvedAt).toLocaleString()],
      ['Published to', (rec.publishedTo ?? []).map((p) => `${p.system} ${p.externalId}`).join(', ') || null],
    ])),
  );

  mount(document.body, modal);
  return modal;
}
