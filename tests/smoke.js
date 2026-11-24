// Throwaway smoke test: drive one document run end to end through the real HTTP surface.
// The named requirement tests live in tests/run-tests.js.

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
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log('--- health');
  const health = await api('GET', '/api/v1/health');
  log(health.status, health.json.status, health.json.checks?.map((c) => `${c.name}:${c.status}`).join(' '));

  log('\n--- bootstrap');
  const boot = await api('GET', '/api/v1/bootstrap');
  csrf = boot.json.csrfToken;
  log(boot.status, 'skills:', boot.json.catalogue.skills.length,
      '| actor:', boot.json.actor, '| transport:', boot.json.transport,
      '| budget remaining PR:', boot.json.budgetState.premiumRequests.remaining);

  log('\n--- skill detail (generate-prd)');
  const skill = await api('GET', '/api/v1/catalogue/skills/generate-prd');
  log(skill.status, skill.json.name, '| writers:', skill.json.council.roster.map((r) => `${r.displayName}=${r.defaultModelFamily}`).join(', '));
  log('   captain model (read-only):', skill.json.council.captain?.modelDisplayName,
      '| template sections:', skill.json.template.sections.length,
      '| scorable:', skill.json.template.sections.filter((s) => s.scorable).length);

  log('\n--- G1 estimate');
  const inputs = {
    ideaSource: 'Cryptographic cart-hash assurance for agentic intent flows',
    supportingMaterial: 'Merchants report disputes where the agent-submitted cart cannot be proven unchanged at authorisation.',
    epicUrl: 'MCSE-731',
  };
  const est = await api('POST', '/api/v1/runs/estimate', { skillId: 'generate-prd', inputs });
  log(est.status, 'allowed:', est.json.allowed,
      '| PR:', est.json.estimate.premiumRequests,
      `(${est.json.estimate.premiumRequestsLow}-${est.json.estimate.premiumRequestsHigh})`,
      '| calls:', JSON.stringify(est.json.estimate.calls),
      '| tokens:', est.json.estimate.estimatedTotalTokens);

  log('\n--- FR-COUNCIL-004: duplicate family must be refused by name');
  const dup = await api('POST', '/api/v1/runs', {
    skillId: 'generate-prd', inputs,
    writerSelection: [
      { writerProfileId: 'pm-writer-1', logicalModel: 'writer-a' },
      { writerProfileId: 'pm-writer-2', logicalModel: 'writer-e' },   // both anthropic
      { writerProfileId: 'pm-writer-3', logicalModel: 'writer-c' },
    ],
  });
  log(dup.status, dup.json.error?.code, '|', dup.json.error?.message);

  log('\n--- create run');
  const create = await api('POST', '/api/v1/runs', { skillId: 'generate-prd', inputs });
  if (create.status !== 201) { log('FAILED', create.status, JSON.stringify(create.json)); return; }
  const runId = create.json.run.id;
  log(create.status, runId, '|', create.json.run.title, '|', create.json.run.statusLabel);

  log('\n--- waiting for the council…');
  let run = null;
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    const r = await api('GET', `/api/v1/runs/${runId}`);
    run = r.json;
    if (['awaiting_human', 'failed', 'cancelled'].includes(run.run.state)) break;
    if (i % 4 === 0) log('   ', run.run.state, '-', run.run.statusLabel,
                         `| candidates ${run.candidates.length} | reviews ${run.reviews.length}/${run.reviewProgress.expected}`);
  }

  log('\n--- run state:', run.run.state, '-', run.run.statusLabel);
  log('    candidates:', run.candidates.length);
  for (const a of run.aggregates) {
    log(`      ${a.writerDisplayName.padEnd(13)} ${String(a.modelDisplayName).padEnd(18)} ` +
        `peer ${String(a.peerAverage).padStart(5)} self ${String(a.selfScore).padStart(3)} ` +
        `bias ${String(a.selfBias).padStart(5)} spread ${String(a.scoreSpread).padStart(3)} ` +
        `${a.contested ? 'CONTESTED ' + a.scoreRange : ''} | ${a.wordCount}w ${a.placeholderCount}ph ${a.citationCount}cit`);
  }
  log('    reviews:', run.reviews.length, 'expected:', run.reviewProgress.expected,
      '| self-flagged:', run.reviews.filter((r) => r.isSelf).length);
  log('    consensus strengths:', run.consensus.commonStrengths.length,
      '| concerns:', run.consensus.commonConcerns.length);
  if (run.consensus.commonConcerns[0]) {
    log('      e.g.', run.consensus.commonConcerns[0].evaluatorCount + ' evaluators:',
        run.consensus.commonConcerns[0].text.slice(0, 90));
  }
  log('    verdict winner:', run.verdict?.winnerCandidateId, '| mode:', run.verdict?.captainMode,
      '| suggestions:', run.verdict?.suggestions.length);
  for (const s of run.verdict?.suggestions ?? []) {
    log(`      [${s.sourceLabel}] ${s.text.slice(0, 95)}`);
  }
  log('    quality:', run.quality.map((q) => `${q.score}`).join('/'), '| threshold', run.qualityThreshold);
  log('    cost: PR', run.cost.total.premiumRequests, 'vs est', run.cost.estimate.premiumRequests,
      `(${run.cost.variancePercent}%)`, '| tokens', run.cost.total.totalTokens,
      '| band', run.cost.sizeBand);
  log('    byPhase:', JSON.stringify(run.cost.byPhase));
  log('    events:', run.events.length);

  log('\n--- G3 decision: pick base + 2 suggestions');
  const sugIds = (run.verdict?.suggestions ?? []).slice(0, 2).map((s) => s.id);
  const dec = await api('POST', `/api/v1/runs/${runId}/decision`, {
    action: 'accept', baseCandidateId: run.verdict.winnerCandidateId,
    appliedSuggestionIds: sugIds, note: 'Taking the risk section from the other draft.',
  });
  log(dec.status, dec.json.run?.state, '-', dec.json.run?.statusLabel);

  log('\n--- G4 scorecard');
  const card = await api('GET', `/api/v1/runs/${runId}/scorecard`);
  log(card.status, 'rows:', card.json.scorecard?.rows.length, 'complete:', card.json.scorecard?.complete);

  log('    attempt to publish before scoring (must be blocked):');
  const early = await api('POST', `/api/v1/runs/${runId}/proposals`, {});
  if (early.status === 201) {
    const ap = await api('POST', `/api/v1/proposals/${early.json.proposal.id}/approve`, {
      proposalVersion: early.json.proposal.version,
      operationFingerprint: early.json.proposal.operationFingerprint,
    });
    log('      ', ap.status, ap.json.error?.code, '|', ap.json.error?.message?.slice(0, 110));
  } else {
    log('      ', early.status, early.json.error?.code, '|', early.json.error?.message?.slice(0, 110));
  }

  const cardId = card.json.scorecard.id;
  log('    scoring', card.json.scorecard.rows.length, 'sections…');
  for (const row of card.json.scorecard.rows) {
    const r = await api('PUT', `/api/v1/scorecards/${cardId}/sections/${row.sectionId}`, {
      verdict: 'minor_rework', manualEffortHours: row.manualEffortHint ?? 3,
      reworkHours: Math.max(0.5, (row.manualEffortHint ?? 3) * 0.3),
      accuracyPercent: 72, findings: 'Needed a citation and a tightened scope sentence.',
    });
    if (r.status !== 200) log('      FAILED', row.sectionId, r.status, JSON.stringify(r.json).slice(0, 200));
  }
  log('    reject a client-computed aggregate (FR-API-030):');
  const cheat = await api('PUT', `/api/v1/scorecards/${cardId}/sections/${card.json.scorecard.rows[0].sectionId}`, {
    verdict: 'accurate', manualEffortHours: 2, reworkHours: 0, accuracyPercent: 100, effortSavedPercent: 999,
  });
  log('      ', cheat.status, cheat.json.error?.code, '|', cheat.json.error?.message?.slice(0, 90));

  const done = await api('POST', `/api/v1/scorecards/${cardId}/complete`, {});
  log('    complete:', done.status, '| accuracy', done.json.scorecard?.aggregateAccuracy,
      '| saving', done.json.scorecard?.aggregateEffortSavedPercent + '%',
      '| run', done.json.run?.state);

  log('\n--- G5 proposal + approval + publish');
  const targetBody = { space: 'alberta', title: 'Cryptographic Cart Hash Assurance MCSE-731 — PRD' };
  let prop = await api('POST', `/api/v1/runs/${runId}/proposals`, targetBody);

  // FR-GEN-005 blocks a candidate carrying an unresolved gap. The resolution is a HUMAN EDIT
  // (FR-REVIEW-004) — never a waiver of the gate.
  if (prop.status === 422 && prop.json.error?.code === 'placeholders_present') {
    log('    FR-GEN-005 blocked publication:',
        prop.json.error.detail.placeholders.map((p) => `${p.sectionHeading} ("${p.text}")`).join('; '));
    const final = (await api('GET', `/api/v1/runs/${runId}`)).json.candidates.slice(-1)[0];
    const fixed = final.body.replace(/- TBD \[UNKNOWN[^\]]*\]/g,
      '- Target release window: Q3, confirmed with the delivery lead on 2026-11-18.');
    const ed = await api('POST', `/api/v1/candidates/${final.id}/edit`, {
      body: fixed, summary: 'Supplied the missing target release window.',
    });
    log('    human edit (FR-REVIEW-004):', ed.status, ed.json.candidate?.id,
        '| origin', ed.json.candidate?.origin, '| placeholders now', ed.json.candidate?.placeholders.length);
    prop = await api('POST', `/api/v1/runs/${runId}/proposals`, targetBody);
  }
  if (prop.status !== 201) { log('   proposal FAILED', prop.status, JSON.stringify(prop.json).slice(0, 400)); return; }
  const P = prop.json.proposal;
  log(prop.status, P.id, 'v' + P.version, '|', P.validationStatus);
  log('    target:', JSON.stringify(P.targetSummaries[0]));
  log('    preflight:', P.preflight.map((c) => `${c.label}=${c.pass ? 'pass' : 'FAIL'}`).join(', '));

  log('    publish WITHOUT approval (must be refused):');
  const noAppr = await api('POST', `/api/v1/proposals/${P.id}/publish`, {});
  log('      ', noAppr.status, noAppr.json.error?.code, '|', noAppr.json.error?.message?.slice(0, 110));

  log('    approve with a WRONG fingerprint (must be refused):');
  const badFp = await api('POST', `/api/v1/proposals/${P.id}/approve`, {
    proposalVersion: P.version, operationFingerprint: 'sha256:deadbeefdeadbeef',
  });
  log('      ', badFp.status, badFp.json.error?.code, '|', badFp.json.error?.message?.slice(0, 110));

  const appr = await api('POST', `/api/v1/proposals/${P.id}/approve`, {
    proposalVersion: P.version, operationFingerprint: P.operationFingerprint,
    note: 'Reviewed every section against the supporting material.',
  });
  log('    approved:', appr.status, appr.json.approval?.id, '| actor', appr.json.approval?.actor);

  const pub = await api('POST', `/api/v1/proposals/${P.id}/publish`, { approvalId: appr.json.approval.id });
  log('    published:', pub.status, JSON.stringify(pub.json.summary),
      '|', pub.json.results?.[0]?.externalUrl, '| run', pub.json.run?.state);

  log('    reuse the consumed approval (must be refused):');
  const reuse = await api('POST', `/api/v1/proposals/${P.id}/publish`, { approvalId: appr.json.approval.id });
  log('      ', reuse.status, reuse.json.error?.code, '|', reuse.json.error?.message?.slice(0, 110));

  log('\n--- provenance');
  const prov = await api('GET', `/api/v1/runs/${runId}/provenance`);
  const pr = prov.json.provenance;
  log(prov.status, '| immutable:', pr?.immutable, '| prompt hashes:', pr?.promptHashes?.length,
      '| writers:', pr?.writers?.length, '| reviews:', pr?.reviews?.length,
      '| composition rows:', pr?.composition?.length);
  log('    approvedBy:', pr?.approvedBy, '| publishedTo:', JSON.stringify(pr?.publishedTo));

  log('\n--- admin usage');
  const usage = await api('GET', '/api/v1/admin/usage');
  log(usage.status, JSON.stringify(usage.json.totals));
  log('    byPhase:', usage.json.byPhase.map((p) => `${p.key}=${p.premiumRequests}`).join(' '));
  log('    byFamily:', usage.json.byModelFamily.map((p) => `${p.key}=${p.premiumRequests}`).join(' '));

  log('\n--- systems of record');
  const sor = await api('GET', '/api/v1/sor');
  log(sor.status, 'confluence:', sor.json.confluence.length, 'jira:', sor.json.jira.length, 'PRs:', sor.json.pullRequests.length);
  if (sor.json.confluence[0]) log('    ', sor.json.confluence[0].title, '| v' + sor.json.confluence[0].version);

  log('\nSMOKE TEST COMPLETE');
}

main().catch((e) => { console.error('SMOKE FAILED:', e); process.exit(1); });
