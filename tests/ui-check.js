// Drives the real UI in Edge over the DevTools Protocol to prove it runs without JS errors.
// Zero dependencies: Node 24 has a native WebSocket.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9222;
const BASE = 'http://127.0.0.1:7701';
const OUT = process.argv[2] ?? 'data/ui';

const profile = mkdtempSync(join(tmpdir(), 'jarvis-edge-'));
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Edge DevTools endpoint did not come up');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval threw');
    return r.result?.value;
  }
}

const log = (...a) => console.log(...a);

async function main() {
  const cdp = await Cdp.connect(await target());
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  const problems = [];
  const collect = () => {
    for (const e of cdp.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        problems.push('EXCEPTION: ' + (e.params.exceptionDetails?.exception?.description
          ?? e.params.exceptionDetails?.text ?? '').split('\n')[0]);
      }
      if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) {
        problems.push(`CONSOLE.${e.params.type}: ` +
          e.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 220));
      }
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'
          && !/status of 4\d\d/.test(e.params.entry.text ?? '')) {
        problems.push('LOG: ' + e.params.entry.text.slice(0, 220));
      }
      if (e.method === 'Network.loadingFailed') {
        problems.push(`NETWORK FAIL: ${e.params.errorText}`);
      }
      // A 4xx from a GATE is the product working, not a defect: every control here is a
      // refusal, and the browser logs each one as a failed resource load. Only 5xx and
      // transport failures indicate something broken.
      if (e.method === 'Log.entryAdded' && /status of 5\d\d/.test(e.params.entry.text ?? '')) {
        problems.push('SERVER ERROR: ' + e.params.entry.text.slice(0, 200));
      }
    }
    cdp.events.length = 0;
  };

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT}-${name}.png`, Buffer.from(r.data, 'base64'));
    log(`   screenshot -> ${OUT}-${name}.png`);
  };

  log('--- load landing');
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(2500);
  collect();

  const title = await cdp.eval(`document.querySelector('h1')?.textContent ?? '(none)'`);
  const stages = await cdp.eval(`document.querySelectorAll('.stage-chip').length`);
  log(`   hero="${title}" · stage chips=${stages}`);
  await shot('01-landing');
  log(`   FR-NAV-008 stage rail: ${stages === 11 ? 'all 11 present' : `ONLY ${stages} — FAIL`}`);

  log('--- Action mode (search)');
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Action mode').click()`);
  await sleep(400);
  await cdp.eval(`
    const i = document.getElementById('skill-search');
    i.value = 'pull request';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await sleep(500);
  const found = await cdp.eval(`document.querySelectorAll('#action-results .card-selectable').length`);
  log(`   search "pull request" -> ${found} skill(s)`);
  collect();
  await shot('02-action-mode');

  log('--- SDLC Workflow mode');
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='SDLC Workflow mode').click()`);
  await sleep(400);
  const stageCards = await cdp.eval(`document.querySelectorAll('.grid-3 .card').length`);
  log(`   stage cards: ${stageCards}`);
  collect();
  await shot('03-workflow-mode');

  log('--- Agent mode -> Product -> Generate PRD (opens the run page)');
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Agent mode').click()`);
  await sleep(300);
  await cdp.eval(`[...document.querySelectorAll('.card-selectable')].find(c=>c.textContent.includes('Product')).click()`);
  await sleep(400);
  await cdp.eval(`[...document.querySelectorAll('.card-selectable')].find(c=>c.textContent.includes('Generate PRD')).click()`);
  await sleep(1800);
  collect();

  const pageOpen = await cdp.eval(`!!document.querySelector('.run-page')`);
  const fields = await cdp.eval(`document.querySelectorAll('.run-page .field').length`);
  log(`   run page open=${pageOpen} · input fields=${fields}`);
  await shot('04-run-setup');

  log('--- fill inputs (reveals the models) + enable the optional scorecard');
  await cdp.eval(`
    const set = (id, v) => { const el = document.getElementById(id); if (!el) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('in-ideaSource', 'Cryptographic cart-hash assurance for agentic intent flows');
    set('in-supportingMaterial', 'Merchants report disputes where the agent-submitted cart cannot be proven unchanged at authorisation.');
    set('in-epicUrl', 'MCSE-731');
    const sc = document.querySelector('.run-page input[type=checkbox]');
    if (sc && !sc.checked) { sc.checked = true; sc.dispatchEvent(new Event('change', { bubbles: true })); }
  `);
  await sleep(1600);
  const models = await cdp.eval(`document.querySelectorAll('#rp-writer-model, #rp-captain-model').length`);
  const runBtn = await cdp.eval(`!![...document.querySelectorAll('.run-page .btn-primary')].find(b=>b.textContent.includes('Run Agent'))`);
  log(`   writer+captain selects=${models} · Run Agent button=${runBtn}`);
  await cdp.eval(`const w = document.getElementById('rp-writer-model'); if (w && w.options.length>1){ w.selectedIndex=Math.min(1,w.options.length-1); w.dispatchEvent(new Event('change',{bubbles:true})); }`);
  await sleep(800);
  await shot('05-run-configured');

  log('--- Run Agent');
  await cdp.eval(`[...document.querySelectorAll('.run-page .btn-primary')].find(b=>b.textContent.includes('Run Agent')).click()`);
  let done = false;
  for (let i = 0; i < 70; i++) {
    await sleep(1000);
    if (i === 2) await shot('06-running');
    done = await cdp.eval(`!![...document.querySelectorAll('.run-section .section-bar')].find(s=>s.textContent.trim().startsWith('Score'))`);
    if (done) break;
    const failed = await cdp.eval(`!![...document.querySelectorAll('.banner-danger')].find(b=>b.textContent.includes('failed'))`);
    if (failed) { log('   RUN FAILED'); break; }
  }
  collect();

  log('--- results: Score + Captain Review + Result preview');
  const scoreTile = await cdp.eval(`!!document.querySelector('.run-section .score-tile')`);
  const meters = await cdp.eval(`document.querySelectorAll('.run-section .meter').length`);
  const captain = await cdp.eval(`!![...document.querySelectorAll('.run-section .section-bar')].find(s=>s.textContent.includes("Captain's Review"))`);
  const resultDoc = await cdp.eval(`!!document.querySelector('.run-section .doc')`);
  log(`   score tile=${scoreTile} · rubric meters=${meters} · Captain's Review=${captain} · result preview=${resultDoc}`);
  await shot('07-results');

  log('--- Run Evaluation -> G4 scorecard');
  await cdp.eval(`[...document.querySelectorAll('.run-bar .btn')].find(b=>b.textContent.includes('Run Evaluation'))?.click()`);
  await sleep(3000);
  collect();
  const scRows = await cdp.eval(`document.querySelectorAll('.modal tbody tr').length`);
  log(`   scorecard rows=${scRows}`);
  await shot('08-g4-scorecard');
  if (scRows > 0) {
    await cdp.eval(`
      (async () => {
        for (const r of [...document.querySelectorAll('.modal tbody tr')]) {
          const nums = r.querySelectorAll('input[type=number]'); const sel = r.querySelector('select');
          if (nums.length < 3 || !sel) continue;
          nums[0].value='4'; nums[0].dispatchEvent(new Event('change',{bubbles:true})); await new Promise(x=>setTimeout(x,80));
          nums[1].value='1'; nums[1].dispatchEvent(new Event('change',{bubbles:true})); await new Promise(x=>setTimeout(x,80));
          nums[2].value='78'; nums[2].dispatchEvent(new Event('change',{bubbles:true})); await new Promise(x=>setTimeout(x,80));
          sel.value='minor_rework'; sel.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(x=>setTimeout(x,220));
        }
      })()
    `);
    await sleep(2500); collect();
    await cdp.eval(`[...document.querySelectorAll('.modal .btn-primary')].find(b=>b.textContent.includes('Continue to approval'))?.click()`);
    await sleep(2500); collect();
    await shot('09-g4-complete');
  }

  log('--- Mark as Reviewed -> G5 approval gate');
  await cdp.eval(`[...document.querySelectorAll('.run-bar .btn-primary')].find(b=>b.textContent.includes('Mark as Reviewed'))?.click()`);
  await sleep(3000);
  collect();
  // Resolve any placeholder block via the in-place editor (FR-GEN-005).
  const blockedByGap = await cdp.eval(`!![...document.querySelectorAll('.modal .btn')].find(b=>b.textContent.trim()==='Edit to resolve')`);
  if (blockedByGap) {
    log('   placeholder block -> resolving via the in-place editor');
    await cdp.eval(`[...document.querySelectorAll('.modal .btn')].find(b=>b.textContent.trim()==='Edit to resolve').click()`);
    await sleep(1000);
    await cdp.eval(`
      const tas=[...document.querySelectorAll('.modal textarea')]; const ta=tas[tas.length-1];
      ta.value = ta.value.replace(/- TBD \\[UNKNOWN[^\\]]*\\]/g, '- Target release window: Q3, confirmed with the delivery lead.');
      const s=document.getElementById('edit-summary'); if (s) s.value='Supplied the missing release window.';
    `);
    await cdp.eval(`[...document.querySelectorAll('.modal .btn-primary')].find(b=>b.textContent.includes('Save revision')).click()`);
    await sleep(2500); collect();
    await shot('10-after-edit');
  }
  const preflight = await cdp.eval(`[...document.querySelectorAll('.modal .row.small')].map(r=>r.textContent.replace(/\\s+/g,' ').trim()).filter(t=>t.length>8).slice(0,8)`);
  for (const p of preflight ?? []) log(`     ${p}`);
  await shot('11-g5-approval');

  log('--- approve and publish');
  const approveBtn = await cdp.eval(`!![...document.querySelectorAll('.modal .btn-primary')].find(b=>b.textContent.includes('Approve and publish'))`);
  if (approveBtn) {
    await cdp.eval(`[...document.querySelectorAll('.modal .btn-primary')].find(b=>b.textContent.includes('Approve and publish')).click()`);
    await sleep(3000); collect();
    const result = await cdp.eval(`[...document.querySelectorAll('.modal .banner')].map(b=>b.textContent.replace(/\\s+/g,' ').slice(0,180))[0] ?? '(none)'`);
    log(`   result: ${result}`);
    await shot('12-publish-result');
    await cdp.eval(`[...document.querySelectorAll('.modal .btn')].find(b=>b.textContent.trim()==='Done')?.click()`);
    await sleep(600);
  } else {
    log('   Approve not available -- a pre-flight check is blocking (the gate working).');
  }

  log('--- light theme');
  await cdp.eval(`document.documentElement.dataset.theme = 'light'`);
  await sleep(600);
  await shot('13-light-theme');
  await cdp.eval(`document.documentElement.dataset.theme = 'dark'`);

  log('--- admin console');
  await cdp.eval(`[...document.querySelectorAll('.rail .btn')].find(b=>b.textContent.trim()==='Admin console').click()`);
  await sleep(2200);
  collect();
  const recon = await cdp.eval(`
    [...document.querySelectorAll('.banner')].map(b=>b.textContent.replace(/\\s+/g,' ').trim()).find(t=>t.includes('reconcile')) ?? '(none)'
  `);
  log(`   reconciliation: ${recon}`);
  await shot('14-admin-console');

  collect();
  log('\n=== CONSOLE / NETWORK PROBLEMS ===');
  const unique = [...new Set(problems)];
  if (unique.length === 0) log('   none — the UI ran clean.');
  else for (const p of unique) log('   ' + p);

  cdp.ws.close();
  edge.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(unique.length ? 2 : 0);
}

main().catch((e) => {
  console.error('UI CHECK FAILED:', e.message);
  edge.kill();
  process.exit(1);
});
