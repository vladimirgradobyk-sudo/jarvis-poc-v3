// Config validator (CAP-ADMIN-01, FR-ARCH-SYS-042).
//
// Rules from repo-scaffold §6.1:
//   1. The server REFUSES TO START on invalid config. No degraded-mode startup.
//   2. Errors are actionable: file, path, offending value, and what was expected.
//   3. Unsafe defaults are REJECTED, not warned about.
//   4. Cross-file referential integrity: every reference must resolve.
//   5. Duplicate IDs anywhere are fatal.

export class ConfigError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ConfigError';
    this.detail = detail;
  }
}

/** Collects every problem rather than failing on the first, so one run fixes the whole file. */
class Problems {
  constructor() {
    this.items = [];
  }
  add(path, message) {
    this.items.push({ path, message });
  }
  throwIfAny() {
    if (this.items.length === 0) return;
    const lines = this.items.map((p) => `  • ${p.path}\n      ${p.message}`).join('\n');
    throw new ConfigError(
      `Configuration failed to load: ${this.items.length} problem${this.items.length === 1 ? '' : 's'} found. ` +
        `No agents are available until these are fixed.\n\n${lines}\n`,
      { problems: this.items }
    );
  }
}

function requirePositiveNumber(p, path, value) {
  if (value === null || value === undefined) {
    p.add(path, 'MANDATORY and unset. NFR-COST-002 / DEC-19: budget values have no built-in default — the server refuses to start rather than run uncapped.');
    return false;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    p.add(path, `Expected a positive number, got ${JSON.stringify(value)}.`);
    return false;
  }
  return true;
}

function assertUniqueIds(p, label, items, idKey = 'id') {
  const seen = new Map();
  for (const [i, item] of items.entries()) {
    const id = item?.[idKey];
    if (!id) {
      p.add(`${label}[${i}].${idKey}`, 'Missing id. Every configured entity needs a stable id.');
      continue;
    }
    if (seen.has(id)) {
      p.add(`${label}[${i}].${idKey}`, `Duplicate id "${id}" (first seen at index ${seen.get(id)}). Duplicate IDs are fatal.`);
    }
    seen.set(id, i);
  }
}

export function validateConfig(config) {
  const p = new Problems();

  // ── Budget (NFR-COST-002 / FR-ARCH-SYS-042) ────────────────────────────────────────────
  const b = config.budget ?? {};
  requirePositiveNumber(p, 'budget.perRunPremiumRequests', b.perRunPremiumRequests);
  requirePositiveNumber(p, 'budget.perUserDailyPremiumRequests', b.perUserDailyPremiumRequests);
  requirePositiveNumber(p, 'budget.warnPercent', b.warnPercent);
  requirePositiveNumber(p, 'budget.perRunTokens', b.perRunTokens);
  requirePositiveNumber(p, 'budget.perUserDailyTokens', b.perUserDailyTokens);

  if (typeof b.warnPercent === 'number' && (b.warnPercent <= 0 || b.warnPercent >= 100)) {
    p.add('budget.warnPercent', `Expected a percentage strictly between 0 and 100, got ${b.warnPercent}.`);
  }
  if (
    typeof b.perRunPremiumRequests === 'number' &&
    typeof b.perUserDailyPremiumRequests === 'number' &&
    b.perRunPremiumRequests > b.perUserDailyPremiumRequests
  ) {
    p.add(
      'budget.perRunPremiumRequests',
      `Per-run cap (${b.perRunPremiumRequests}) exceeds the daily cap (${b.perUserDailyPremiumRequests}). ` +
        'A single run could never complete. Lower the per-run cap or raise the daily cap.'
    );
  }

  // ── Model registry (FR-MODEL-001..005, AM-01) ──────────────────────────────────────────
  const entries = config.models?.entries ?? [];
  const logicals = config.models?.logicalModels ?? [];
  assertUniqueIds(p, 'models.entries', entries);
  assertUniqueIds(p, 'models.logicalModels', logicals);

  const entryById = new Map(entries.map((e) => [e.id, e]));

  // FR-MODEL-003: ONE canonical display name per model, everywhere. The pilot showed the same
  // model as "Opus 4.5", "CLAUDE-OPUS-4-5" and "claude-opus-4-5" in a single flow.
  const byDisplayName = new Map();
  for (const e of entries) {
    if (!e.displayName) {
      p.add(`models.entries[${e.id}].displayName`, 'Missing canonical display name (FR-MODEL-003).');
      continue;
    }
    if (byDisplayName.has(e.displayName)) {
      p.add(
        `models.entries[${e.id}].displayName`,
        `Display name "${e.displayName}" is already used by "${byDisplayName.get(e.displayName)}". ` +
          'FR-MODEL-003 requires exactly one canonical display name per model.'
      );
    }
    byDisplayName.set(e.displayName, e.id);
    if (!e.family) p.add(`models.entries[${e.id}].family`, 'Missing family. AM-01: family drives council distinctness.');
    if (typeof e.premiumRequestMultiplier !== 'number' || e.premiumRequestMultiplier <= 0) {
      p.add(
        `models.entries[${e.id}].premiumRequestMultiplier`,
        `Expected a positive number, got ${JSON.stringify(e.premiumRequestMultiplier)}. Cost cannot be estimated without it (NFR-COST-001).`
      );
    }
    if (e.status === 'deprecated' && !e.replacedBy) {
      p.add(`models.entries[${e.id}].replacedBy`, 'A deprecated model must name an alternative (FR-MODEL-004).');
    }
  }

  for (const lm of logicals) {
    if (!entryById.has(lm.defaultEntryId)) {
      p.add(
        `models.logicalModels[${lm.id}].defaultEntryId`,
        `"${lm.defaultEntryId}" does not resolve to any registry entry. Logical → registry → resolved must hold (FR-MODEL-001).`
      );
    }
  }

  // ── Stages, agents ─────────────────────────────────────────────────────────────────────
  assertUniqueIds(p, 'stages', config.stages ?? []);
  assertUniqueIds(p, 'agents', config.agents ?? []);
  const stageIds = new Set((config.stages ?? []).map((s) => s.id));
  const agentIds = new Set((config.agents ?? []).map((a) => a.id));
  const lifecycleIds = new Set((config.lifecycleSummary ?? []).map((l) => l.id));

  for (const st of config.stages ?? []) {
    if (!lifecycleIds.has(st.lifecycleGroup)) {
      p.add(`stages[${st.id}].lifecycleGroup`, `"${st.lifecycleGroup}" is not in lifecycleSummary. The 11→7 mapping must be total (design-system §8.1).`);
    }
    for (const a of st.agents ?? []) {
      if (!agentIds.has(a)) p.add(`stages[${st.id}].agents`, `Agent "${a}" does not exist.`);
    }
  }

  for (const a of config.agents ?? []) {
    // FR-NAV-011: every agent and sub-agent needs a human-authored Title Case label. A missing
    // label is a validation error, NOT a fallback to the raw ID.
    if (!a.role) p.add(`agents[${a.id}].role`, 'Missing role. The professional role is the primary label and is always displayed (design-system §9).');
    assertUniqueIds(p, `agents[${a.id}].subAgents`, a.subAgents ?? []);
    for (const s of a.subAgents ?? []) {
      if (!s.role) p.add(`agents[${a.id}].subAgents[${s.id}].role`, 'Missing role label (FR-NAV-011).');
    }
  }

  // ── Rubrics, templates, captains ───────────────────────────────────────────────────────
  assertUniqueIds(p, 'rubrics', config.rubrics ?? []);
  assertUniqueIds(p, 'templates', config.templates ?? []);
  assertUniqueIds(p, 'captains', config.captains ?? []);
  const rubricIds = new Set((config.rubrics ?? []).map((r) => r.id));
  const templateIds = new Set((config.templates ?? []).map((t) => t.id));
  const captainIds = new Set((config.captains ?? []).map((c) => c.id));
  const modeIds = new Set((config.captainModes ?? []).map((m) => m.id));

  for (const t of config.templates ?? []) {
    assertUniqueIds(p, `templates[${t.id}].sections`, t.sections ?? []);
    if (!(t.sections ?? []).some((s) => s.scorable)) {
      p.add(`templates[${t.id}].sections`, 'No scorable section. The G4 scorecard would have zero rows, making FR-SCORE-001 unenforceable.');
    }
    for (const s of t.sections ?? []) {
      if (!s.heading) p.add(`templates[${t.id}].sections[${s.id}].heading`, 'Missing heading.');
      if (!Array.isArray(s.fixtureBullets) || s.fixtureBullets.length < 2) {
        p.add(
          `templates[${t.id}].sections[${s.id}].fixtureBullets`,
          'Needs at least 2 entries. The fixture transport selects a voice-specific subset; with fewer than 2, every writer produces identical text and the council cannot disagree.'
        );
      }
    }
  }

  for (const c of config.captains ?? []) {
    if (!modeIds.has(c.defaultMode)) p.add(`captains[${c.id}].defaultMode`, `"${c.defaultMode}" is not a known captain mode.`);
    const lm = logicals.find((l) => l.id === c.defaultModel);
    if (!lm) p.add(`captains[${c.id}].defaultModel`, `"${c.defaultModel}" is not a logical model.`);
    else if (!lm.policyFixed) {
      p.add(
        `captains[${c.id}].defaultModel`,
        `"${c.defaultModel}" is not marked policyFixed. DEC-15 / AM-10: the Captain model is fixed by policy and not user-selectable.`
      );
    }
  }

  // ── Writer rosters ─────────────────────────────────────────────────────────────────────
  const profileById = new Map();
  for (const [file, roster] of Object.entries(config.writerRosters ?? {})) {
    assertUniqueIds(p, `writerRosters.${file}`, roster ?? []);
    for (const prof of roster ?? []) {
      if (profileById.has(prof.id)) {
        p.add(`writerRosters.${file}[${prof.id}]`, `Writer profile id "${prof.id}" is also defined in another roster file. Profile IDs are global.`);
      }
      profileById.set(prof.id, prof);
      if (!logicals.find((l) => l.id === prof.defaultModel)) {
        p.add(`writerRosters.${file}[${prof.id}].defaultModel`, `"${prof.defaultModel}" is not a logical model.`);
      }
      for (const f of ['displayName', 'focusChip', 'looksFor', 'roleDescription', 'promptRef']) {
        if (!prof[f]) p.add(`writerRosters.${file}[${prof.id}].${f}`, 'Required field is missing.');
      }
    }
  }

  // ── Skills ─────────────────────────────────────────────────────────────────────────────
  assertUniqueIds(p, 'skills', config.skills ?? []);
  const VALID_PHASES = ['configure', 'generate', 'review', 'compare', 'adjudicate', 'execute', 'publish'];
  const VALID_KINDS = ['document', 'code_plan', 'report', 'structured_items'];
  const VALID_TARGETS = ['confluence_page', 'jira_issue', 'pull_request'];

  for (const s of config.skills ?? []) {
    const at = (f) => `skills[${s.id}].${f}`;
    if (!s.name) p.add(at('name'), 'Missing Title Case display name (FR-NAV-011).');
    if (!agentIds.has(s.agent)) p.add(at('agent'), `Agent "${s.agent}" does not exist.`);
    else {
      const agent = config.agents.find((a) => a.id === s.agent);
      if (s.subAgent && !agent.subAgents.find((x) => x.id === s.subAgent)) {
        p.add(at('subAgent'), `Sub-agent "${s.subAgent}" is not declared on agent "${s.agent}".`);
      }
    }
    for (const st of s.stages ?? []) if (!stageIds.has(st)) p.add(at('stages'), `Stage "${st}" does not exist.`);
    if (!templateIds.has(s.template)) p.add(at('template'), `Template "${s.template}" does not exist.`);
    for (const t of s.publishTargets ?? []) {
      if (!VALID_TARGETS.includes(t)) p.add(at('publishTargets'), `Unknown publish target "${t}". Expected one of ${VALID_TARGETS.join(', ')}.`);
    }
    if (!s.promptRef) p.add(at('promptRef'), 'Missing prompt reference.');
    else if (!/\.v\d+\.md$/.test(s.promptRef)) {
      p.add(at('promptRef'), `"${s.promptRef}" must name an explicit version (e.g. foo.v1.md). Config references a specific version, never "latest" (repo-scaffold §6.3).`);
    }

    const c = s.council ?? {};
    if (!VALID_KINDS.includes(c.artifactKind)) p.add(at('council.artifactKind'), `Expected one of ${VALID_KINDS.join(', ')}, got ${JSON.stringify(c.artifactKind)}.`);
    if (!rubricIds.has(c.rubric)) p.add(at('council.rubric'), `Rubric "${c.rubric}" does not exist.`);

    // Phase rules: must start 'configure', end 'publish', be known and in canonical order.
    const phases = c.phases ?? [];
    if (phases[0] !== 'configure') p.add(at('council.phases'), `Must start with "configure", got ${JSON.stringify(phases[0])}.`);
    if (phases[phases.length - 1] !== 'publish') p.add(at('council.phases'), `Must end with "publish", got ${JSON.stringify(phases[phases.length - 1])}.`);
    let lastIdx = -1;
    for (const ph of phases) {
      const idx = VALID_PHASES.indexOf(ph);
      if (idx === -1) { p.add(at('council.phases'), `Unknown phase "${ph}".`); continue; }
      if (idx <= lastIdx) p.add(at('council.phases'), `Phase "${ph}" is out of canonical order. Expected subsequence of: ${VALID_PHASES.join(' → ')}.`);
      lastIdx = idx;
    }

    // Unsafe defaults are REJECTED (repo-scaffold §6.1 rule 3).
    if (phases.includes('adjudicate') && !c.captain) {
      p.add(at('council.captain'), 'Phases include "adjudicate" but no captain is configured. A council that adjudicates without a Captain cannot produce a verdict.');
    }
    if (c.captain && !captainIds.has(c.captain)) p.add(at('council.captain'), `Captain "${c.captain}" does not exist.`);
    if (phases.includes('execute') && c.artifactKind !== 'code_plan') {
      p.add(at('council.phases'), 'Only artifactKind "code_plan" may declare the "execute" phase (council-engine-spec §3).');
    }
    if (phases.includes('execute') && !s.requiresSandbox) {
      p.add(at('requiresSandbox'), 'A skill with an "execute" phase must declare requiresSandbox: true (AD-SANDBOX).');
    }

    const w = c.writers ?? {};
    if (!Number.isInteger(w.min) || w.min < 1) p.add(at('council.writers.min'), `Expected an integer ≥ 1, got ${JSON.stringify(w.min)}.`);
    if (!Number.isInteger(w.max) || w.max > 5) p.add(at('council.writers.max'), `Expected an integer ≤ 5 (MVP cap), got ${JSON.stringify(w.max)}.`);
    if (!Number.isInteger(w.default) || w.default < w.min || w.default > w.max) {
      p.add(at('council.writers.default'), `Default ${JSON.stringify(w.default)} must lie between min (${w.min}) and max (${w.max}).`);
    }
    if (w.max > 1 && w.requireDistinctModels !== true) {
      p.add(
        at('council.writers.requireDistinctModels'),
        'Must be true for a multi-writer council. A council of identical model families is a bug, not a configuration (council-engine-spec §1): correlated errors defeat the entire review mechanism.'
      );
    }
    const roster = w.roster ?? [];
    if (roster.length < w.default) {
      p.add(at('council.writers.roster'), `Roster has ${roster.length} entries but default writer count is ${w.default}. The roster must hold at least the configured count.`);
    }
    for (const id of roster) if (!profileById.has(id)) p.add(at('council.writers.roster'), `Writer profile "${id}" does not exist in any roster file.`);

    // Distinct FAMILIES must be achievable at the default writer count, or the council can never start.
    if (w.requireDistinctModels && roster.length) {
      const fams = new Set();
      for (const id of roster) {
        const prof = profileById.get(id);
        const lm = logicals.find((l) => l.id === prof?.defaultModel);
        const entry = entryById.get(lm?.defaultEntryId);
        if (entry?.family) fams.add(entry.family);
      }
      if (fams.size < Math.min(w.default, roster.length)) {
        p.add(
          at('council.writers.roster'),
          `Roster resolves to only ${fams.size} distinct model famil${fams.size === 1 ? 'y' : 'ies'} (${[...fams].join(', ')}) but ${w.default} distinct writers are required. ` +
            'The council could never start. Assign different default models.'
        );
      }
    }

    if (s.requiresScorecard) {
      const tpl = (config.templates ?? []).find((t) => t.id === s.template);
      if (tpl && !(tpl.sections ?? []).some((x) => x.scorable)) {
        p.add(at('requiresScorecard'), `Skill requires a scorecard but template "${s.template}" has no scorable sections.`);
      }
    }
  }

  if ((config.skills ?? []).length === 0) {
    p.add('skills', 'No skills configured. The launcher would have nothing to offer.');
  }

  p.throwIfAny();
  return config;
}
