// Smoke test 2: the other three artifact kinds — structured_items (Jira + partial failure),
// code_plan (G2 → sandbox → PR proposal), and report (the SOLO path, engine AC 2).

const BASE = 'http://127.0.0.1:7701';
let csrf = null;

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, json };
}
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(runId, states, max = 120) {
  for (let i = 0; i < max; i++) {
    await sleep(400);
    const r = await api('GET', `/api/v1/runs/${runId}`);
    if (states.includes(r.json.run.state)) return r.json;
  }
  const r = await api('GET', `/api/v1/runs/${runId}`);
  log('   TIMED OUT in state', r.json.run.state);
  return r.json;
}

async function scoreAll(runId) {
  const card = await api('GET', `/api/v1/runs/${runId}/scorecard`);
  if (card.status !== 200) return null;
  const id = card.json.scorecard.id;
  for (const row of card.json.scorecard.rows) {
    await api('PUT', `/api/v1/scorecards/${id}/sections/${row.sectionId}`, {
      verdict: 'minor_rework', manualEffortHours: row.manualEffortHint ?? 3,
      reworkHours: Math.max(0.5, (row.manualEffortHint ?? 3) * 0.25),
      accuracyPercent: 78, findings: 'Tightened wording; added a missing citation.',
    });
  }
  const done = await api('POST', `/api/v1/scorecards/${id}/complete`, {});
  return done.json.scorecard;
}

async function main() {
  csrf = (await api('GET', '/api/v1/bootstrap')).json.csrfToken;

  // ───────────────────────────────────────────────────────────────── structured_items
  log('=== GENERATE USER STORIES (structured_items → Jira)');
  const prdArtifacts = await api('GET', '/api/v1/artifacts?kinds=document');
  const src = prdArtifacts.json.artifacts[0];
  log('  source artifact:', src?.runTitle, src?.candidateId);

  const us = await api('POST', '/api/v1/runs', {
    skillId: 'generate-user-stories',
    inputs: {
      epicUrl: 'MCSE-731', sourceArtifact: src.candidateId,
      jiraProject: 'G1206', assignee: 'e180113', storyCount: '5-8',
    },
  });
  log(' create:', us.status, us.json.run?.title, '| phases:', us.json.run?.phases.join('→'));
  if (us.status !== 201) { log(JSON.stringify(us.json)); return; }

  let r = await waitFor(us.json.run.id, ['awaiting_human', 'failed']);
  log(' state:', r.run.state, '| candidates', r.candidates.length, '| reviews', r.reviews.length,
      '| contested:', r.aggregates.filter((a) => a.contested).map((a) => `${a.writerDisplayName} ${a.scoreRange}`).join(', ') || 'none');
  for (const a of r.aggregates) {
    log(`   ${a.writerDisplayName.padEnd(13)} peer ${String(a.peerAverage).padStart(5)} self ${String(a.selfScore).padStart(3)} spread ${String(a.scoreSpread).padStart(3)} ${a.contested ? 'CONTESTED' : ''}`);
  }

  await api('POST', `/api/v1/runs/${us.json.run.id}/decision`, {
    action: 'accept', baseCandidateId: r.verdict.winnerCandidateId,
    appliedSuggestionIds: r.verdict.suggestions.slice(0, 1).map((s) => s.id),
  });
  const card = await scoreAll(us.json.run.id);
  log(' G4:', card ? `accuracy ${card.aggregateAccuracy} saving ${card.aggregateEffortSavedPercent}%` : 'no scorecard');

  // structured_items carries the full placeholder rate. FR-GEN-005 would block the proposal
  // before the ownership and partial-failure paths below could be reached, and the resolution
  // is a recorded human edit (FR-REVIEW-004).
  {
    const d = (await api('GET', `/api/v1/runs/${us.json.run.id}`)).json;
    const ranked = [...d.candidates].reverse();
    const target = ranked.find((c) => c.origin === 'human_edit')
                ?? ranked.find((c) => c.origin === 'synthesis')
                ?? ranked.find((c) => c.placeholders.length > 0)
                ?? ranked[0];
    if (target.placeholders.length > 0) {
      const ed = await api('POST', `/api/v1/candidates/${target.id}/edit`, {
        body: target.body.replace(/- TBD \[UNKNOWN[^\]]*\]/g, '- Confirmed with the product owner.'),
        summary: 'Resolved the open question.',
      });
      log(` human edit (FR-REVIEW-004): ${ed.status} | placeholders now ${ed.json.candidate?.placeholders.length}`);
    }
  }

  log('\n  FR-PUBLISH-007: a missing assignee must BLOCK (no unowned work items)');
  const noOwner = await api('POST', `/api/v1/runs/${us.json.run.id}/proposals`, { assignee: null });
  log('   proposal validationStatus:', noOwner.json.proposal?.validationStatus,
      '|', noOwner.json.proposal?.validationFindings?.[0]?.message?.slice(0, 95));
  const blockedAppr = await api('POST', `/api/v1/proposals/${noOwner.json.proposal.id}/approve`, {
    proposalVersion: noOwner.json.proposal.version,
    operationFingerprint: noOwner.json.proposal.operationFingerprint,
  });
  log('   approve:', blockedAppr.status, blockedAppr.json.error?.code, '|', blockedAppr.json.error?.message?.slice(0, 95));

  log('\n  FR-PUBLISH-003: partial failure, then retry ONLY the failed item');
  const jp = await api('POST', `/api/v1/runs/${us.json.run.id}/proposals`, {
    assignee: 'e180113', simulatePartialFailure: true,
  });
  const JP = jp.json.proposal;
  log('   proposal:', JP.id, 'v' + JP.version, '|', JSON.stringify(JP.targetSummaries[0]).slice(0, 150));
  const ja = await api('POST', `/api/v1/proposals/${JP.id}/approve`, {
    proposalVersion: JP.version, operationFingerprint: JP.operationFingerprint,
  });
  log('   approved:', ja.status);
  const jpub = await api('POST', `/api/v1/proposals/${JP.id}/publish`, { approvalId: ja.json.approval.id });
  log('   publish:', jpub.status, JSON.stringify(jpub.json.summary), '| retryable targets:', JSON.stringify(jpub.json.retryable));
  const items = jpub.json.results?.[0]?.items;
  log('   per-item:', items ? items.map((i) => i.ok ? i.externalId : `FAIL(${i.errorMessage?.slice(0, 40)})`).join(' ') : 'n/a');

  const sorAfter = await api('GET', '/api/v1/sor');
  log('   jira issues created:', sorAfter.json.jira.length,
      '| assignees:', [...new Set(sorAfter.json.jira.map((i) => i.assignee))].join(','));

  // ───────────────────────────────────────────────────────────────── code_plan
  log('\n=== IMPLEMENT STORY (code_plan → sandbox → PR proposal)');
  const imp = await api('POST', '/api/v1/runs', {
    skillId: 'implement-story',
    inputs: {
      storyKey: 'G1206-10586',
      storyDescription: 'As an acquirer, I want the assurance level carried through intent registration, so that disputes can be adjudicated. AC: unknown levels are rejected, not defaulted.',
      repositoryUrl: 'sample-repo', baseBranch: 'dev', epicUrl: 'MCSE-731',
    },
  });
  log(' create:', imp.status, imp.json.run?.title, '| phases:', imp.json.run?.phases.join('→'));
  if (imp.status !== 201) { log(JSON.stringify(imp.json)); return; }

  let ir = await waitFor(imp.json.run.id, ['awaiting_human', 'failed']);
  log(' G2 state:', ir.run.state, '| plans', ir.candidates.length, '| reviews', ir.reviews.length,
      '| rubric criteria:', Object.keys(ir.reviews[0]?.criterionScores ?? {}).join(','));
  log(' verdict:', ir.verdict?.winnerCandidateId, '| suggestions', ir.verdict?.suggestions.length);

  log(' choosing a plan (G2) — synthesis is DISABLED for code plans, so the chosen plan executes verbatim');
  const idec = await api('POST', `/api/v1/runs/${imp.json.run.id}/decision`, {
    action: 'accept', baseCandidateId: ir.verdict.winnerCandidateId, appliedSuggestionIds: [],
  });
  log('  decision:', idec.status, idec.json.run?.state);

  ir = await waitFor(imp.json.run.id, ['approved', 'scoring', 'failed']);
  const ex = ir.execution;
  log(' execution:', ex?.status, '| runtime', ex?.sandboxRuntime,
      '| files', ex?.filesChanged, `+${ex?.linesAdded} -${ex?.linesRemoved}`);
  log('  branch:', ex?.branchName, '→', ex?.baseBranch);
  log('  FR-EXE-003 tests:', ex?.testsMeasured ? `${ex.testsPassed}/${ex.testsTotal}` : 'NOT MEASURED (correct — no JVM in sandbox)');
  log('  secret findings:', ex?.secretFindings.length);
  log('  changed files:');
  for (const f of ex?.files ?? []) log(`    ${f.op === 'add' ? 'A' : 'M'}  ${f.path}  +${f.linesAdded} -${f.linesRemoved}`);

  // FR-GEN-005 may block the chosen plan if it admits a gap. The resolution is a HUMAN EDIT
  // (FR-REVIEW-004), not a waiver — exercise that path when it fires.
  let probe = await api('POST', `/api/v1/runs/${imp.json.run.id}/proposals`, { confirmed: true });
  if (probe.status === 422 && probe.json.error?.code === 'placeholders_present') {
    log('\n  FR-GEN-005 blocked the plan:', probe.json.error.detail.placeholders.map((p) => p.sectionHeading).join(', '));
    const chosen = ir.candidates.find((c) => c.id === ir.verdict.winnerCandidateId);
    const fixed = chosen.body.replace(/- TBD \[UNKNOWN[^\]]*\]/g,
      '- Verified manually against the existing service tests before raising the PR.');
    const ed = await api('POST', `/api/v1/candidates/${chosen.id}/edit`, {
      body: fixed, summary: 'Resolved the open verification question.',
    });
    log('   human edit (FR-REVIEW-004):', ed.status, ed.json.candidate?.id,
        '| origin', ed.json.candidate?.origin, '| derivedFrom', ed.json.candidate?.derivedFrom,
        '| placeholders now', ed.json.candidate?.placeholders.length);
  }

  log('\n  FR-PUBLISH-005: PR requires an explicit confirmation naming repo/branch/target');
  const prNoConf = await api('POST', `/api/v1/runs/${imp.json.run.id}/proposals`, { confirmed: false });
  log('   validation:', prNoConf.json.proposal?.validationStatus, '|',
      prNoConf.json.proposal?.validationFindings?.find((f) => f.code === 'confirmation_required')?.message?.slice(0, 110));
  const prBlocked = await api('POST', `/api/v1/proposals/${prNoConf.json.proposal.id}/approve`, {
    proposalVersion: prNoConf.json.proposal.version,
    operationFingerprint: prNoConf.json.proposal.operationFingerprint,
  });
  log('   approve:', prBlocked.status, prBlocked.json.error?.code);

  const prProp = await api('POST', `/api/v1/runs/${imp.json.run.id}/proposals`, { confirmed: true });
  const PR = prProp.json.proposal;
  log('   confirmed proposal:', PR.id, '|', JSON.stringify(PR.targetSummaries[0]).slice(0, 190));
  const pra = await api('POST', `/api/v1/proposals/${PR.id}/approve`, {
    proposalVersion: PR.version, operationFingerprint: PR.operationFingerprint,
    note: 'Reviewed the diff; the contract change is additive.',
  });
  const prpub = await api('POST', `/api/v1/proposals/${PR.id}/publish`, { approvalId: pra.json.approval.id });
  log('   PR proposed:', prpub.status, prpub.json.results?.[0]?.externalUrl,
      '| detail:', JSON.stringify(prpub.json.results?.[0]?.detail ?? {}).slice(0, 160));

  // ───────────────────────────────────────────────────────────────── report (SOLO)
  log('\n=== REVIEW PULL REQUEST (report — SOLO path, engine acceptance criterion 2)');
  const planArtifacts = await api('GET', '/api/v1/artifacts?kinds=code_plan');
  const plan = planArtifacts.json.artifacts[0];
  const rev = await api('POST', '/api/v1/runs', {
    skillId: 'review-pull-request',
    inputs: { proposalRef: plan?.candidateId ?? 'none', storyKey: 'G1206-10586', focus: 'correctness' },
  });
  log(' create:', rev.status, rev.json.run?.title, '| phases:', rev.json.run?.phases.join('→'),
      '| writers:', rev.json.run?.writerSelection.length);
  if (rev.status !== 201) { log(JSON.stringify(rev.json)); return; }

  const rr = await waitFor(rev.json.run.id, ['awaiting_human', 'approved', 'scoring', 'failed']);
  log(' state:', rr.run.state, '| candidates', rr.candidates.length,
      '| reviews', rr.reviews.length, '(expected 0 — no review phase)',
      '| verdict', rr.verdict ? 'present' : 'none (no captain)');
  log(' report excerpt:');
  for (const line of (rr.candidates[0]?.body ?? '').split('\n').slice(0, 10)) log('   ', line);

  log('\n=== BUDGET + ADMIN');
  const b = await api('GET', '/api/v1/budget');
  log(' daily PR:', b.json.premiumRequests.consumed, '/', b.json.premiumRequests.limit,
      `(${b.json.premiumRequests.percent}%)`, '| warning:', b.json.warning, '| exhausted:', b.json.exhausted);
  log(' daily tokens:', b.json.tokens.consumed.toLocaleString(), '/', b.json.tokens.limit.toLocaleString(),
      `(${b.json.tokens.percent}%)`);
  const adminRuns = await api('GET', '/api/v1/admin/runs');
  log(' ledger rows:', adminRuns.json.rows.length);
  for (const row of adminRuns.json.rows) {
    log(`   ${row.title.slice(0, 38).padEnd(39)} ${String(row.state).padEnd(10)} PR ${String(row.premiumRequests).padStart(6)} ` +
        `est ${String(row.estimatePremiumRequests ?? '-').padStart(6)} var ${String(row.variancePercent ?? '-').padStart(7)}% ${row.sizeBand} ${row.modelFamilies.join('/')}`);
  }
  const usage = await api('GET', '/api/v1/admin/usage');
  log(' totals:', JSON.stringify(usage.json.totals));
  log(' reconciliation: byPhase sum =',
      Math.round(usage.json.byPhase.reduce((a, p) => a + p.premiumRequests, 0) * 100) / 100,
      '| byFamily sum =', Math.round(usage.json.byModelFamily.reduce((a, p) => a + p.premiumRequests, 0) * 100) / 100,
      '| bySkill sum =', Math.round(usage.json.bySkill.reduce((a, p) => a + p.premiumRequests, 0) * 100) / 100,
      '| ledger total =', usage.json.totals.premiumRequests);

  const sor = await api('GET', '/api/v1/sor');
  log('\n systems of record: confluence', sor.json.confluence.length,
      '| jira', sor.json.jira.length, '| PRs', sor.json.pullRequests.length);

  log('\nSMOKE TEST 2 COMPLETE');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
