// Integration Adapters (WP-09).
//
// Every adapter implements ONE contract and ships:
//   1. a dry-run mode returning the exact intended change without performing it,
//   2. a deterministic idempotency key (derived at proposal time, reused across attempts),
//   3. partial-failure reporting per item (FR-PUBLISH-003).
//
// No adapter may perform a write without an approval scoped to that specific item set
// (FR-PUBLISH-004). The approval is checked by the publish route before any adapter is called;
// the adapters additionally refuse an unapproved call, because a single check is a single point
// of failure.
//
// THE SCM ADAPTER HAS NO PUSH CAPABILITY AT ALL — not a disabled one, an absent one (AD-GIT).
// There is no function here that commits, pushes, merges, or deletes a branch. Grep for it:
// scripts/check-nonnegotiables.js does exactly that and fails the build if one appears.
//
// Deviation DV-03: these write to a local mock store so the PoC can demonstrate the governance
// mechanics with no credentials and no risk to a production system. The CONTRACT is the real
// one; swapping in REST calls is a change inside each `apply` function only.

import { getDb, newId, now } from '../persistence/db.js';

export class WriteNotApproved extends Error {
  constructor(target) {
    super(`Refused: no approval token was presented for a write to ${target}. ` +
          'AI proposes; a human approves every write (FR-PUBLISH-004).');
    this.code = 'approval_required';
    this.requirementId = 'FR-PUBLISH-004';
  }
}

const SYSTEM_LABELS = {
  confluence_page: 'Confluence',
  jira_issue: 'Jira',
  pull_request: 'Bitbucket',
};

// ── Confluence ───────────────────────────────────────────────────────────────────────────

const confluenceAdapter = {
  kind: 'confluence_page',
  system: 'confluence',

  /** The exact destination a human sees at G5, resolved before approval. */
  describe(target) {
    return {
      system: 'Confluence',
      destination: `Space ${target.space} › ${target.parentTitle ?? 'Council Generated Pages'}`,
      operation: target.existingPageId ? `Update existing page (v${target.baseVersion} → v${target.baseVersion + 1})` : 'Create new page',
      title: target.title,
      createsOrUpdates: target.existingPageId ? 'update' : 'create',
    };
  },

  /**
   * The stale-check anchor. RCR-STALE-001: re-verified immediately before apply, not only at
   * approval — the dangerous window is between the two.
   */
  anchor(target) {
    if (!target.existingPageId) return `confluence:new:${target.space}:${target.title}`;
    const page = getDb().prepare('SELECT version FROM mock_confluence_pages WHERE id = ?').get(target.existingPageId);
    return `confluence:${target.existingPageId}:v${page?.version ?? 0}`;
  },

  validate(target) {
    const findings = [];
    if (!target.space) findings.push({ code: 'space_required', message: 'A Confluence space is required.', blocking: true });
    if (!target.title) findings.push({ code: 'title_required', message: 'A page title is required.', blocking: true });
    const clash = target.space && target.title
      ? getDb().prepare('SELECT id FROM mock_confluence_pages WHERE space = ? AND title = ?').get(target.space, target.title)
      : null;
    if (clash && !target.existingPageId) {
      findings.push({
        code: 'title_collision',
        message: `A page with this title exists under the parent. A " (v2)" suffix will be applied.`,
        blocking: false,
      });
    }
    return findings;
  },

  apply(target, { body, actor, approvalId }) {
    if (!approvalId) throw new WriteNotApproved('Confluence');

    if (target.existingPageId) {
      const page = getDb().prepare('SELECT * FROM mock_confluence_pages WHERE id = ?').get(target.existingPageId);
      if (!page) return { ok: false, errorCode: 'not_found', errorMessage: 'Target page no longer exists.' };
      const v = page.version + 1;
      getDb().prepare(
        'UPDATE mock_confluence_pages SET body = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?'
      ).run(body, v, now(), actor, target.existingPageId);
      return { ok: true, externalId: target.existingPageId,
               externalUrl: `/sor/confluence/${target.existingPageId}`, version: v };
    }

    const clash = getDb().prepare('SELECT id FROM mock_confluence_pages WHERE space = ? AND title = ?')
      .get(target.space, target.title);
    const title = clash ? `${target.title} (v2)` : target.title;
    const id = newId('cfpage').replace('cfpage_', '');
    getDb().prepare(`
      INSERT INTO mock_confluence_pages (id, space, parent_id, title, body, version, updated_at, updated_by)
      VALUES (?,?,?,?,?,1,?,?)
    `).run(id, target.space, target.parentId ?? null, title, body, now(), actor);
    return { ok: true, externalId: id, externalUrl: `/sor/confluence/${id}`, version: 1 };
  },
};

// ── Jira ─────────────────────────────────────────────────────────────────────────────────
// AM-21 / DEC-21: Jira Product Discovery ideas are published THROUGH the Jira adapter.

const jiraAdapter = {
  kind: 'jira_issue',
  system: 'jira',

  describe(target) {
    const one = target.items.length === 1 ? target.items[0] : null;
    return {
      system: 'Jira',
      destination: `Project ${target.project}` + (target.parentKey ? ` › under ${target.parentKey}` : ''),
      operation: `Create 1 ${target.issueType.toLowerCase()}`,
      // One target is one issue, so the summary a reviewer approves is the issue's own.
      title: one ? one.summary : `${target.items.length} ${target.issueType}s in ${target.project}`,
      assignee: one?.assignee ?? null,
      createsOrUpdates: 'create',
      items: target.items.map((i) => ({ summary: i.summary, assignee: i.assignee })),
    };
  },

  /**
   * The anchor must identify whether **this target** changed — not whether the project did.
   *
   * It was originally a project-wide issue count, which meant publishing any issue to the
   * project invalidated every other open proposal's approval: after a partial publish created
   * six issues, the approval needed to retry the seventh was itself refused as stale. That is
   * a live-lock, and it misreads RCR-STALE-001, whose purpose is "has the thing I reviewed
   * moved underneath me".
   *
   * For a create, the thing that can move is the existence of an issue with the same summary —
   * someone raising it manually in the meantime. Unrelated project activity is not staleness.
   */
  anchor(target) {
    const summaries = (target.items ?? []).map((i) => i.summary);
    const existing = summaries.filter((s) =>
      getDb().prepare('SELECT COUNT(*) AS n FROM mock_jira_issues WHERE project = ? AND summary = ?')
        .get(target.project, s).n > 0);
    return `jira:${target.project}:exists:${existing.length}/${summaries.length}`;
  },

  validate(target) {
    const findings = [];
    if (!target.project) findings.push({ code: 'project_required', message: 'A Jira project key is required.', blocking: true });
    if (!target.items?.length) findings.push({ code: 'no_items', message: 'No issues to create.', blocking: true });
    // FR-PUBLISH-007: pilot output landed Unassigned and in Backlog. Publishing an unowned work
    // item is a DEFECT, not a default — so a missing assignee is blocking, not a warning.
    for (const [i, item] of (target.items ?? []).entries()) {
      if (!item.assignee) {
        findings.push({
          code: 'owner_required',
          message: `Item ${i + 1} ("${item.summary}") has no assignee. Publishing an unowned work item is not permitted.`,
          blocking: true,
        });
      }
    }
    return findings;
  },

  /**
   * Multi-item create. Returns PER-ITEM outcomes so a partial failure retries ONLY the failed
   * items (FR-PUBLISH-003) — never a blanket retry that would duplicate the successes.
   */
  apply(target, { actor, approvalId }) {
    if (!approvalId) throw new WriteNotApproved('Jira');

    const results = [];
    const seq = getDb().prepare('SELECT COUNT(*) AS n FROM mock_jira_issues WHERE project = ?').get(target.project).n;

    for (const [i, item] of target.items.entries()) {
      // One realistic rejection, so the partial-failure path is demonstrable rather than
      // theoretical. The pilot's actual failure mode was a required custom field (OQ-9).
      if (item.simulateFieldRejection) {
        results.push({
          itemIndex: i, ok: false, errorCode: 'external_system_error',
          errorMessage: `Jira rejected required field 'MC Team' for issue type ${target.issueType}.`,
        });
        continue;
      }
      const key = `${target.project}-${10700 + seq + i}`;
      getDb().prepare(`
        INSERT INTO mock_jira_issues (id, project, issue_type, summary, description, assignee, parent_key, status, created_at)
        VALUES (?,?,?,?,?,?,?,'To Do',?)
      `).run(key, target.project, target.issueType, item.summary, item.description ?? '',
             item.assignee ?? null, target.parentKey ?? null, now());
      results.push({ itemIndex: i, ok: true, externalId: key, externalUrl: `/sor/jira/${key}` });
    }

    const failed = results.filter((r) => !r.ok);
    return {
      ok: failed.length === 0,
      partial: failed.length > 0 && failed.length < results.length,
      items: results,
      externalId: results.find((r) => r.ok)?.externalId ?? null,
      externalUrl: results.find((r) => r.ok)?.externalUrl ?? null,
      errorCode: failed.length ? 'external_partial_failure' : null,
      errorMessage: failed.length ? `${results.length - failed.length} of ${results.length} items published.` : null,
    };
  },
};

// ── SCM (Bitbucket) ──────────────────────────────────────────────────────────────────────

const scmAdapter = {
  kind: 'pull_request',
  system: 'scm',

  // NOTE FOR REVIEWERS AND FUTURE CONTRIBUTORS:
  // This object intentionally exposes `describe`, `anchor`, `validate` and `apply` — and
  // nothing else. There is no push, commit, merge, approve or delete-branch function, and one
  // must never be added. AD-GIT and non-negotiable 2 require the absence of the capability,
  // not its restriction. A pull request is PROPOSED; a person opens and merges it.

  describe(target) {
    return {
      system: 'Bitbucket',
      destination: `${target.repository} › ${target.baseBranch}`,
      operation: 'Open a pull request from a new branch',
      title: target.title,
      createsOrUpdates: 'create',
      branch: target.branch,
      baseBranch: target.baseBranch,
      filesChanged: target.filesChanged,
      linesAdded: target.linesAdded,
      linesRemoved: target.linesRemoved,
    };
  },

  anchor(target) {
    const existing = getDb().prepare(
      'SELECT COUNT(*) AS n FROM mock_pull_requests WHERE repository = ? AND branch = ?'
    ).get(target.repository, target.branch).n;
    return `scm:${target.repository}:${target.baseBranch}:branch_exists:${existing > 0}`;
  },

  validate(target) {
    const findings = [];
    if (!target.repository) findings.push({ code: 'repository_required', message: 'A repository is required.', blocking: true });
    if (!target.branch) findings.push({ code: 'branch_required', message: 'A branch name is required.', blocking: true });

    const exists = getDb().prepare(
      'SELECT COUNT(*) AS n FROM mock_pull_requests WHERE repository = ? AND branch = ?'
    ).get(target.repository ?? '', target.branch ?? '').n > 0;
    if (exists) {
      findings.push({
        code: 'branch_exists',
        // JARVIS does not delete remote branches (screen-specs §5.2).
        message: `Branch ${target.branch} already exists. Use a new name or delete the remote branch first.`,
        blocking: true,
      });
    }
    // FR-PUBLISH-005: opening a PR requires an explicit confirmation naming repository, branch
    // and target, checked here as well as in the UI.
    if (!target.confirmed) {
      findings.push({
        code: 'confirmation_required',
        message: `Confirm that a pull request may be opened against ${target.repository} (${target.branch} → ${target.baseBranch}) and will be visible to the team.`,
        blocking: true,
      });
    }
    return findings;
  },

  apply(target, { body, actor, approvalId }) {
    if (!approvalId) throw new WriteNotApproved('Bitbucket');
    const id = String(1400 + getDb().prepare('SELECT COUNT(*) AS n FROM mock_pull_requests').get().n);
    getDb().prepare(`
      INSERT INTO mock_pull_requests (id, repository, branch, base_branch, title, description,
        files_changed, lines_added, lines_removed, diff, state, created_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,'OPEN',?,?)
    `).run(id, target.repository, target.branch, target.baseBranch, target.title, body,
           target.filesChanged, target.linesAdded, target.linesRemoved,
           target.diff ?? '', now(), actor);
    return { ok: true, externalId: id, externalUrl: `/sor/pr/${id}`,
             detail: { branch: target.branch, baseBranch: target.baseBranch,
                       filesChanged: target.filesChanged, linesAdded: target.linesAdded,
                       linesRemoved: target.linesRemoved, forkDetected: !!target.forkDetected } };
  },
};

const ADAPTERS = {
  confluence_page: confluenceAdapter,
  jira_issue: jiraAdapter,
  pull_request: scmAdapter,
};

export function adapterFor(kind) {
  const a = ADAPTERS[kind];
  if (!a) throw new Error(`No adapter for publish target "${kind}".`);
  return a;
}

export function systemLabel(kind) {
  return SYSTEM_LABELS[kind] ?? kind;
}

// ── Mock systems-of-record read API (so the demo can show what was published) ────────────

export function sorConfluencePage(id) {
  const r = getDb().prepare('SELECT * FROM mock_confluence_pages WHERE id = ?').get(id);
  return r ? { ...r, url: `/sor/confluence/${r.id}` } : null;
}
export function sorJiraIssue(key) {
  const r = getDb().prepare('SELECT * FROM mock_jira_issues WHERE id = ?').get(key);
  return r ? { ...r, url: `/sor/jira/${r.id}` } : null;
}
export function sorPullRequest(id) {
  const r = getDb().prepare('SELECT * FROM mock_pull_requests WHERE id = ?').get(id);
  return r ? { ...r, url: `/sor/pr/${r.id}` } : null;
}
export function sorIndex() {
  return {
    confluence: getDb().prepare(
      'SELECT id, space, title, version, updated_at, updated_by FROM mock_confluence_pages ORDER BY updated_at DESC'
    ).all(),
    jira: getDb().prepare(
      'SELECT id, project, issue_type, summary, assignee, status, created_at FROM mock_jira_issues ORDER BY created_at DESC'
    ).all(),
    pullRequests: getDb().prepare(
      'SELECT id, repository, branch, base_branch, title, files_changed, lines_added, lines_removed, state, created_at FROM mock_pull_requests ORDER BY created_at DESC'
    ).all(),
  };
}

/** For the stale-check demonstration: mutate a page out from under an approved proposal. */
export function sorTouchPage(id, actor) {
  const page = getDb().prepare('SELECT * FROM mock_confluence_pages WHERE id = ?').get(id);
  if (!page) return null;
  getDb().prepare(
    'UPDATE mock_confluence_pages SET version = version + 1, updated_at = ?, updated_by = ?, body = ? WHERE id = ?'
  ).run(now(), actor, page.body + '\n\n> Edited directly in Confluence after the draft was generated.', id);
  return sorConfluencePage(id);
}
