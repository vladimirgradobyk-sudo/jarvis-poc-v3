#!/usr/bin/env node
// Enforces the module import rules from repo-scaffold.md §4 — "by CI, not by good intentions".
//
// The rule that matters most: adding an agent family must require zero changes under
// server/council/. These rules are what make that true rather than hoped for.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** layer → forbidden import path fragments, with the reason. */
const RULES = [
  { layer: 'server/persistence', forbid: ['/council/', '/providers/', '/integrations/', '/api/'],
    why: 'the store must not depend on what writes to it' },
  { layer: 'server/providers', forbid: ['/council/', '/integrations/', '/persistence/', '/api/'],
    why: 'a transport knows nothing about orchestration or publication' },
  { layer: 'server/council', forbid: ['/integrations/', '/api/'],
    why: 'publication goes through the API layer, never from the engine' },
  { layer: 'server/sandbox', forbid: ['/council/', '/integrations/', '/providers/'],
    why: 'the sandbox is reachable only downward' },
  { layer: 'server/integrations', forbid: ['/council/', '/providers/'],
    why: 'adapters must not import the engine' },
  { layer: 'server/security', forbid: ['/council/', '/providers/', '/integrations/', '/api/'],
    why: 'guards are leaves' },
  { layer: 'server/config', forbid: ['/council/', '/providers/', '/integrations/', '/api/', '/persistence/'],
    why: 'configuration loads before anything else exists' },
  { layer: 'web/components', forbid: ['/features/', 'lib/api'],
    why: 'components take props and emit callbacks; they do not fetch and do not read stores' },
];

function walk(dir) {
  const out = [];
  if (!safeStat(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
function safeStat(p) { try { return statSync(p); } catch { return null; } }

const rel = (p) => relative(ROOT, p).split(sep).join('/');
const violations = [];

for (const rule of RULES) {
  for (const file of walk(join(ROOT, rule.layer))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      for (const bad of rule.forbid) {
        if (!spec.includes(bad)) continue;
        // A sibling import within the same layer is not a crossing.
        if (rel(file).startsWith(rule.layer) && spec.startsWith('./')) continue;
        const line = src.slice(0, m.index).split('\n').length;
        violations.push({ file: rel(file), line, spec, rule: rule.layer, bad, why: rule.why });
      }
    }
  }
}

// Sibling-adapter isolation: an adapter may not import another adapter.
for (const file of walk(join(ROOT, 'server', 'integrations'))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+['"](\.\/[^'"]+)['"]/gm)) {
    if (/adapter/i.test(m[1])) {
      violations.push({ file: rel(file), line: src.slice(0, m.index).split('\n').length,
                        spec: m[1], rule: 'server/integrations', bad: 'sibling adapter',
                        why: 'adapters must not import each other' });
    }
  }
}

console.log('\nModule boundary checks\n');
for (const rule of RULES) {
  const n = violations.filter((v) => v.rule === rule.layer).length;
  console.log(`${n === 0 ? '  ok  ' : ' FAIL '} ${rule.layer.padEnd(22)} ${n === 0 ? '' : n + ' violation(s)'}`);
}

if (violations.length === 0) {
  console.log(`\n${RULES.length} boundaries clean.\n`);
  process.exit(0);
}

console.log('\nViolations:\n');
for (const v of violations) {
  console.log(`  ${v.file}:${v.line}`);
  console.log(`    imports "${v.spec}"  —  ${v.rule} may not import ${v.bad}`);
  console.log(`    ${v.why}\n`);
}
process.exit(1);
