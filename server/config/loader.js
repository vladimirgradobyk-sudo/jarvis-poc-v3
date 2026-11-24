// Config Loader (WP-01 / CAP-ADMIN-01).
// Reads the per-file configuration sources, merges them deterministically, validates, and
// computes a config hash. The server REFUSES TO START on invalid configuration — there is no
// degraded-mode startup (repo-scaffold §6.1 rule 1).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateConfig, ConfigError } from './validator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONFIG_ROOT = join(HERE, '..', '..', 'config');
export const PROJECT_ROOT = join(HERE, '..', '..');

function readJson(path) {
  try {
    // Strip a UTF-8 BOM: Notepad, VS Code's "UTF-8 with BOM" and PowerShell's `Set-Content
    // -Encoding utf8` all add one, and JSON.parse rejects it. Config files are hand-edited, so
    // tolerating this is correctness, not laxity.
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new ConfigError(
      `Could not read or parse ${path}: ${err.message}. Fix the file — the server will not start without it.`,
      { path }
    );
  }
}

/** Strip `_`-prefixed documentation keys so they never reach the API surface or the config hash. */
function stripNotes(value) {
  if (Array.isArray(value)) return value.map(stripNotes);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('_')) continue;
      out[k] = stripNotes(v);
    }
    return out;
  }
  return value;
}

function listSkillFiles() {
  const skillsDir = join(CONFIG_ROOT, 'skills');
  const files = [];
  if (!existsSync(skillsDir)) return files;
  // Deterministic ordering: agent directory, then skill file name (repo-scaffold §6.2).
  for (const agentDir of readdirSync(skillsDir).sort()) {
    const dir = join(skillsDir, agentDir);
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.json')) files.push(join(dir, f));
    }
  }
  return files;
}

/**
 * Prompt files are immutable and versioned. The loader records the resolved path AND a content
 * checksum so provenance can prove which text produced an artifact (repo-scaffold §6.3).
 */
function loadPrompt(ref) {
  const path = join(CONFIG_ROOT, 'prompts', ref);
  if (!existsSync(path)) {
    throw new ConfigError(
      `Prompt file not found: ${ref}. Expected at config/prompts/${ref}. A config reference must resolve.`,
      { promptRef: ref }
    );
  }
  const content = readFileSync(path, 'utf8');
  return {
    ref,
    checksum: 'sha256:' + createHash('sha256').update(content).digest('hex').slice(0, 16),
    content,
  };
}

export function loadConfig() {
  const budget = stripNotes(readJson(join(CONFIG_ROOT, 'budget.json')));
  const registry = stripNotes(readJson(join(CONFIG_ROOT, 'models', 'registry.json')));
  const stageDoc = stripNotes(readJson(join(CONFIG_ROOT, 'stages', 'stages.json')));
  const agentDoc = stripNotes(readJson(join(CONFIG_ROOT, 'agents', 'agents.json')));
  const rubricDoc = stripNotes(readJson(join(CONFIG_ROOT, 'rubrics', 'rubrics.json')));
  const templateDoc = stripNotes(readJson(join(CONFIG_ROOT, 'templates', 'templates.json')));
  const captainDoc = stripNotes(readJson(join(CONFIG_ROOT, 'councils', 'captains', 'captains.json')));

  const writerRosters = {};
  const writersDir = join(CONFIG_ROOT, 'councils', 'writers');
  for (const f of readdirSync(writersDir).sort()) {
    if (!f.endsWith('.json')) continue;
    const key = f.replace(/\.json$/, '');
    writerRosters[key] = stripNotes(readJson(join(writersDir, f))).profiles;
  }

  const skills = listSkillFiles().map((p) => stripNotes(readJson(p)));

  const config = {
    budget,
    models: registry,
    lifecycleSummary: stageDoc.lifecycleSummary,
    stages: stageDoc.stages,
    agents: agentDoc.agents,
    rubrics: rubricDoc.rubrics,
    qualityThresholdDefaults: rubricDoc.qualityThreshold,
    templates: templateDoc.templates,
    captains: captainDoc.profiles,
    captainModes: captainDoc.modes,
    writerRosters,
    skills,
  };

  // Throws ConfigError with an actionable message. Never returns a partially valid config.
  validateConfig(config);

  // Resolve prompts after validation so a missing prompt is reported as a config error, not a crash.
  config.prompts = {};
  const refs = new Set();
  for (const roster of Object.values(writerRosters)) for (const p of roster) refs.add(p.promptRef);
  for (const c of config.captains) refs.add(c.promptRef);
  for (const s of config.skills) refs.add(s.promptRef);
  refs.add('policy/product-policy.v1.md');
  for (const ref of [...refs].sort()) config.prompts[ref] = loadPrompt(ref);

  config.configHash =
    'sha256:' +
    createHash('sha256')
      .update(JSON.stringify(config, Object.keys(config).sort()))
      .digest('hex')
      .slice(0, 16);

  return config;
}

/** Flattened view the catalogue API serves. Built once at boot (FR-ARCH-SYS-040). */
export function buildCatalogue(config) {
  const skillsByAgent = new Map();
  for (const s of config.skills) {
    if (!skillsByAgent.has(s.agent)) skillsByAgent.set(s.agent, []);
    skillsByAgent.get(s.agent).push(s);
  }

  const agents = config.agents.map((a) => {
    const owned = skillsByAgent.get(a.id) ?? [];
    return {
      ...a,
      // FR-NAV-010: every AgentCard presents an IDENTICAL manifest shape. A card may never
      // substitute an inline skill list for a count.
      manifest: {
        skillCount: owned.length,
        subAgentCount: a.subAgents.length,
        label: `${owned.length} skill${owned.length === 1 ? '' : 's'} across ${a.subAgents.length} sub-agent${a.subAgents.length === 1 ? '' : 's'}`,
      },
      skillPreview: owned.slice(0, 3).map((s) => s.name),
      skillPreviewMore: Math.max(0, owned.length - 3),
      skillIds: owned.map((s) => s.id),
    };
  });

  const stages = config.stages.map((st) => {
    const stageSkills = config.skills.filter((s) => s.stages.includes(st.id));
    return {
      ...st,
      skillCount: stageSkills.length,
      enabled: stageSkills.length > 0,
      agentRoles: st.agents
        .map((id) => config.agents.find((a) => a.id === id))
        .filter(Boolean)
        .map((a) => ({ id: a.id, role: a.role, alias: a.alias })),
    };
  });

  return {
    version: '0.1.0-poc',
    configHash: config.configHash,
    lifecycleSummary: config.lifecycleSummary,
    stages,
    agents,
    skills: config.skills.map((s) => summariseSkill(s, config)),
    captainModes: config.captainModes,
    budget: config.budget,
  };
}

/** The shape Action mode's searchable catalogue needs (FR-NAV-014/015). */
export function summariseSkill(skill, config) {
  const agent = config.agents.find((a) => a.id === skill.agent);
  const sub = agent?.subAgents.find((s) => s.id === skill.subAgent) ?? null;
  const writers = skill.council.writers;
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    agentId: skill.agent,
    agentRole: agent?.role ?? skill.agent,
    agentAlias: agent?.alias ?? null,
    subAgentRole: sub?.role ?? null,
    subAgentAlias: sub?.alias ?? null,
    stages: skill.stages,
    outputType: skill.outputType,
    artifactKind: skill.council.artifactKind,
    phases: skill.council.phases,
    uiLabels: skill.uiLabels ?? {},
    // FR-NAV-015: derived from the manifest's declared targets. Icon + text, never colour alone.
    writeTargets: skill.publishTargets,
    writeBadge: writeBadgeFor(skill.publishTargets),
    councilIndicator: writers.default > 1 ? `${writers.default} writers` : 'Single pass',
    estimatedDurationSeconds: skill.estimatedDurationSeconds,
    requiresScorecard: skill.requiresScorecard,
    requiresSandbox: !!skill.requiresSandbox,
    provisional: !!skill.provisional,
    synonyms: skill.synonyms ?? [],
    status: skill.status,
    qualityThreshold: skill.council.qualityThreshold ?? config.qualityThresholdDefaults.default,
  };
}

const TARGET_SYSTEM_NAMES = {
  confluence_page: 'Confluence',
  jira_issue: 'Jira',
  pull_request: 'Bitbucket',
};

export function writeBadgeFor(targets) {
  if (!targets || targets.length === 0) return null;
  const systems = [...new Set(targets.map((t) => TARGET_SYSTEM_NAMES[t] ?? t))];
  return `Writes to ${systems.join(' and ')} · approval required`;
}
