#!/usr/bin/env node
// Standalone config validation (repo-scaffold §6.1). Used in CI and before every server start.
// Exit 0 = valid. Exit 1 = invalid, with an actionable report.

import { loadConfig, buildCatalogue } from '../server/config/loader.js';
import { ConfigError } from '../server/config/validator.js';

try {
  const config = loadConfig();
  const cat = buildCatalogue(config);

  console.log('Configuration valid.\n');
  console.log(`  config hash          ${config.configHash}`);
  console.log(`  stages               ${cat.stages.length} (${cat.stages.filter((s) => s.enabled).length} enabled)`);
  console.log(`  agents               ${cat.agents.length}`);
  console.log(`  skills               ${cat.skills.length}`);
  console.log(`  model entries        ${config.models.entries.length} across ${new Set(config.models.entries.map((e) => e.family)).size} families`);
  console.log(`  writer profiles      ${Object.values(config.writerRosters).flat().length}`);
  console.log(`  templates            ${config.templates.length}`);
  console.log(`  prompt files         ${Object.keys(config.prompts).length}`);
  console.log(`\n  budget  per-run ${config.budget.perRunPremiumRequests} PR · daily ${config.budget.perUserDailyPremiumRequests} PR · warn at ${config.budget.warnPercent}%`);
  console.log(`          per-run ${config.budget.perRunTokens.toLocaleString()} tokens · daily ${config.budget.perUserDailyTokens.toLocaleString()} tokens`);

  console.log('\n  skills by artifact kind:');
  const byKind = {};
  for (const s of cat.skills) (byKind[s.artifactKind] ??= []).push(s);
  for (const [kind, list] of Object.entries(byKind)) {
    console.log(`    ${kind.padEnd(17)} ${list.map((s) => s.name).join(', ')}`);
  }
  process.exit(0);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}`);
    console.error('The server will not start until these are resolved (CAP-ADMIN-01).\n');
    process.exit(1);
  }
  throw err;
}
