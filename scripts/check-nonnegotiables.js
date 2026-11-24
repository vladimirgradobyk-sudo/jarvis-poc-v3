#!/usr/bin/env node
// Mechanises the non-negotiables that would otherwise be asserted in review.
//
// Each check corresponds to a specification rule that the pilot broke. A rule enforced only by
// review discipline is a rule that will be broken again, so these run in CI.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checks = [];

function walk(dir, exts = ['.js']) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'data', '.git'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

const rel = (p) => relative(ROOT, p).split(sep).join('/');
const lines = (p) => readFileSync(p, 'utf8').split('\n');

/** Lines that are pure comments are exempt: the rules are about CODE, not about prose. */
function codeLines(path) {
  let inBlock = false;
  return lines(path).map((text, i) => {
    const t = text.trim();
    let isComment = false;
    if (inBlock) { isComment = true; if (t.includes('*/')) inBlock = false; }
    else if (t.startsWith('/*')) { isComment = true; if (!t.includes('*/')) inBlock = true; }
    else if (t.startsWith('//') || t.startsWith('*')) isComment = true;
    return { n: i + 1, text, isComment };
  }).filter((l) => !l.isComment);
}

function check(name, requirement, fn) {
  const found = [];
  fn((file, line, detail) => found.push({ file, line, detail }));
  checks.push({ name, requirement, violations: found.length });
  if (found.length) {
    failures.push({ name, requirement, found });
  }
}

const serverFiles = walk(join(ROOT, 'server'));
const webFiles = walk(join(ROOT, 'web'));

// ── 1. No hard-coded model identifier in application code (FR-MODEL-005, BRISK-008) ────────
check('No hard-coded model identifier', 'FR-MODEL-005', (report) => {
  const MODEL_RE = /\b(claude-[a-z0-9.-]*\d|gpt-[0-9][a-z0-9.-]*|gemini-[a-z0-9.-]*\d|us\.anthropic\.[a-z0-9.-]+|anthropic\.claude[a-z0-9.-]*)\b/i;
  for (const f of [...serverFiles, ...webFiles]) {
    // The registry is the ONE place a model identifier may be resolved; the Bedrock transport
    // may name the wire format constant it must send.
    if (rel(f).endsWith('providers/registry.js')) continue;
    for (const l of codeLines(f)) {
      const m = MODEL_RE.exec(l.text);
      // `bedrock-2023-05-31` is an API version string, not a model.
      if (m && !l.text.includes('bedrock-2023-05-31')) report(rel(f), l.n, m[0]);
    }
  }
});

// ── 2. No literal colour outside tokens.css (design-system contract) ───────────────────────
check('No literal colour outside tokens.css', 'design-system §2', (report) => {
  const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
  const RGB_RE = /\brgba?\(\s*\d/;
  for (const f of [...walk(join(ROOT, 'web'), ['.js', '.css'])]) {
    if (rel(f).endsWith('web/styles/tokens.css')) continue;
    for (const l of codeLines(f)) {
      if (HEX_RE.test(l.text)) report(rel(f), l.n, HEX_RE.exec(l.text)[0]);
      else if (RGB_RE.test(l.text)) report(rel(f), l.n, 'rgb()/rgba()');
    }
  }
});

// ── 3. Path resolution in exactly one module (NFR-SEC-002) ─────────────────────────────────
check('Path resolution confined to path-guard.js', 'NFR-SEC-002', (report) => {
  for (const f of serverFiles) {
    if (rel(f).endsWith('security/path-guard.js')) continue;
    // The config loader, env and bootstrap resolve fixed, non-user-supplied paths at startup.
    if (/server\/(config\/loader|env|index)\.js$/.test(rel(f))) continue;
    if (/persistence\/db\.js$/.test(rel(f))) continue;

    const src = readFileSync(f, 'utf8');
    // Only a file that actually imports from node:path can resolve a filesystem path. This
    // avoids flagging unrelated methods that happen to be named `resolve` — the model
    // registry's logical→concrete resolution being the obvious one.
    const pathImport = /from\s+['"]node:path['"]/.test(src);
    if (!pathImport) continue;

    for (const l of codeLines(f)) {
      if (/(^|[^.\w])resolve\s*\(|\bpath\.resolve\s*\(|\bjoin\s*\([^)]*\b(req|body|inputs|params|target|candidate)\b/.test(l.text)
          && !/resolveWithin/.test(l.text)) {
        report(rel(f), l.n, l.text.trim().slice(0, 70));
      }
    }
  }
});

// ── 4. The SCM adapter has NO push capability at all (AD-GIT, non-negotiable 2) ────────────
check('SCM adapter has no git-write capability', 'AD-GIT', (report) => {
  const f = join(ROOT, 'server', 'integrations', 'index.js');
  // A git-write CAPABILITY would appear as an object method or a declared function — never as
  // `array.push(...)`, so a leading dot disqualifies the match.
  const GIT_WRITE = /(?:^|[^.\w])(push|commit|merge|forcePush|deleteBranch|rebase|cherryPick)\s*[:(]|(?:function|async)\s+(push|commit|merge)\b/;
  for (const l of codeLines(f)) {
    const m = GIT_WRITE.exec(l.text);
    if (m) report(rel(f), l.n, `${(m[1] ?? m[2])} — ${l.text.trim().slice(0, 56)}`);
  }
  // There must be no child-process execution anywhere in the integrations layer either.
  for (const l of codeLines(f)) {
    if (/child_process|execSync|spawnSync|\bexec\(/.test(l.text)) {
      report(rel(f), l.n, 'process execution in an adapter');
    }
  }
});

// ── 5. No agent-specific branching in the engine (FR-ARCH-SYS-003, AD-COUNCIL) ─────────────
check('Engine contains no skill-specific branching', 'FR-ARCH-SYS-003', (report) => {
  for (const f of walk(join(ROOT, 'server', 'council'))) {
    for (const l of codeLines(f)) {
      // `skill.id === 'x'`, `skillId === "x"`, or a switch on a skill id.
      if (/skill(Id)?\s*(===|==|\.id\s*===)\s*['"]/.test(l.text)) {
        report(rel(f), l.n, l.text.trim().slice(0, 70));
      }
      // Naming a concrete skill or artifact title in engine code.
      if (/\b(generate-prd|generate-hld|generate-lld|implement-story|review-pull-request|generate-user-stories)\b/.test(l.text)) {
        report(rel(f), l.n, 'engine names a concrete skill');
      }
    }
  }
});

// ── 6. Adapters do not import each other or the engine (repo-scaffold §4) ──────────────────
check('Adapters import neither each other nor the engine', 'repo-scaffold §4', (report) => {
  for (const f of walk(join(ROOT, 'server', 'integrations'))) {
    for (const l of codeLines(f)) {
      if (/^\s*import .*from\s+['"].*\/(council|providers)\//.test(l.text)) {
        report(rel(f), l.n, l.text.trim().slice(0, 70));
      }
    }
  }
});

// ── 7. Budget values are never defaulted in code (NFR-COST-002, FR-ARCH-SYS-042) ───────────
check('Budget values are never defaulted in code', 'NFR-COST-002', (report) => {
  const BUDGET_KEYS = /(perRunPremiumRequests|perUserDailyPremiumRequests|perRunTokens|perUserDailyTokens|warnPercent)/;
  for (const f of serverFiles) {
    for (const l of codeLines(f)) {
      if (!BUDGET_KEYS.test(l.text)) continue;
      // A `??` or `||` fallback on a budget key would silently reinstate a default.
      if (/(\?\?|\|\|)\s*\d/.test(l.text)) report(rel(f), l.n, l.text.trim().slice(0, 70));
    }
  }
});

// ── 8. No auto-approval flag anywhere (non-negotiable 3) ───────────────────────────────────
check('No auto-approval flag', 'non-negotiable 3', (report) => {
  const AUTO = /--yolo|autoApprove|auto_approve|skipApproval|--dangerously|bypassApproval|forceApprove/i;
  for (const f of [...serverFiles, ...webFiles]) {
    for (const l of codeLines(f)) {
      if (AUTO.test(l.text)) report(rel(f), l.n, AUTO.exec(l.text)[0]);
    }
  }
});

// ── 9. Client components neither fetch nor read stores (repo-scaffold §4) ──────────────────
check('Components do not fetch', 'repo-scaffold §4', (report) => {
  for (const f of walk(join(ROOT, 'web', 'components'))) {
    for (const l of codeLines(f)) {
      if (/\bfetch\s*\(|from\s+['"].*lib\/api/.test(l.text)) report(rel(f), l.n, l.text.trim().slice(0, 70));
    }
  }
});

// ── 10. `0/0` is never produced as a test counter (FR-EXE-003) ─────────────────────────────
check('No 0/0 test counter default', 'FR-EXE-003', (report) => {
  for (const f of [...serverFiles, ...webFiles]) {
    for (const l of codeLines(f)) {
      if (/testsPassed\s*[:=]\s*0\b|['"]0\/0['"]/.test(l.text)) report(rel(f), l.n, l.text.trim().slice(0, 70));
    }
  }
});

// ── Report ─────────────────────────────────────────────────────────────────────────────────

console.log('\nNon-negotiable checks\n');
for (const c of checks) {
  const mark = c.violations === 0 ? '  ok  ' : ' FAIL ';
  console.log(`${mark} ${c.name.padEnd(48)} ${c.requirement.padEnd(22)} ${c.violations === 0 ? '' : c.violations + ' violation(s)'}`);
}

if (failures.length === 0) {
  console.log(`\n${checks.length} checks passed.\n`);
  process.exit(0);
}

console.log('\nViolations:\n');
for (const f of failures) {
  console.log(`  ${f.name}  (${f.requirement})`);
  for (const v of f.found.slice(0, 12)) console.log(`    ${v.file}:${v.line}  ${v.detail}`);
  if (f.found.length > 12) console.log(`    … and ${f.found.length - 12} more`);
  console.log('');
}
process.exit(1);
