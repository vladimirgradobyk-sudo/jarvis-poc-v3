// Fixture transport — the DEFAULT provider transport (deviation DV-04).
//
// Deterministic, offline, free. It exists so the governed thread can be demonstrated and
// regression-tested without model access, which the spec itself calls for: integration tests
// run against recorded fixtures, and live-model evaluation is scheduled off the PR path
// because it is non-deterministic and costs money (repo-scaffold §10 step 13).
//
// The hard requirement on this module is that THE COUNCIL MUST GENUINELY DISAGREE. A fixture
// that returns the same text to every writer would make the review matrix, the contested
// marking, the consensus panel and the Captain's verdict all theatre. So each model's
// `fixtureVoice` selects a different subset of each template section's bullets, at a different
// depth, with different placeholder behaviour — and the review scores are derived from real
// properties of the text each writer actually produced.

import { createHash } from 'node:crypto';

/** Deterministic PRNG. Same seed → same run, so a demo is repeatable and a test is stable. */
function rng(seed) {
  let h = Number.parseInt(createHash('sha256').update(String(seed)).digest('hex').slice(0, 12), 16);
  return () => {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    return h / 0x7fffffff;
  };
}

const PLACEHOLDER = 'TBD [UNKNOWN — requires user input]';

/**
 * Each voice is a different author. `take` controls how much of each section it writes,
 * `order` whether it reorders, `placeholders` how readily it admits a gap, `closer` its
 * characteristic final line. These produce drafts a reviewer can actually tell apart.
 */
const VOICES = {
  pragmatic: {
    label: 'balanced and decisive',
    take: 0.75, depth: 'medium', placeholderRate: 0.12, verbosity: 1.0,
    closer: 'This section is complete enough to act on; remaining detail belongs in the next level of design.',
    strengthBias: ['Clear structure', 'Decisive where the input allows'],
    concernBias: ['Could carry more evidence per claim'],
  },
  rigorous: {
    label: 'evidence-led and cautious',
    take: 0.9, depth: 'deep', placeholderRate: 0.38, verbosity: 1.35,
    closer: 'Where the supplied input does not support a claim above, the gap is marked rather than filled.',
    strengthBias: ['Every assertion traced to an input', 'Gaps stated rather than inferred'],
    concernBias: ['Dense; a reader in a hurry will struggle', 'More open items than a reviewer may want'],
  },
  expansive: {
    label: 'broad and exploratory',
    take: 1.0, depth: 'deep', placeholderRate: 0.05, verbosity: 1.5,
    closer: 'Adjacent considerations are included deliberately, on the view that omitting them hides a decision.',
    strengthBias: ['Comprehensive coverage', 'Considers second-order effects'],
    concernBias: ['Scope creeps beyond the question asked', 'Length will slow review'],
  },
  terse: {
    label: 'minimal',
    take: 0.45, depth: 'shallow', placeholderRate: 0.2, verbosity: 0.6,
    closer: 'Kept short deliberately.',
    strengthBias: ['Readable in one pass'],
    concernBias: ['Thin in places', 'Several template sections are under-developed'],
  },
  adjudicating: {
    label: 'synthesising',
    take: 0.85, depth: 'deep', placeholderRate: 0.08, verbosity: 1.1,
    closer: '',
    strengthBias: ['Weighs alternatives explicitly'],
    concernBias: ['Occasionally restates rather than decides'],
  },
};

function pickSubset(items, fraction, rand) {
  const n = Math.max(1, Math.round(items.length * fraction));
  const pool = items.map((t, i) => ({ t, i, k: rand() }));
  // Sort by random key to choose WHICH, then restore document order so prose still reads well.
  pool.sort((a, b) => a.k - b.k);
  return pool.slice(0, n).sort((a, b) => a.i - b.i).map((x) => x.t);
}

// ── generate ─────────────────────────────────────────────────────────────────────────────

/**
 * How readily each artifact kind admits an unresolved gap.
 *
 * `document` keeps the full rate: a PRD or HLD drafted from thin input genuinely should say so,
 * and the blocking-publication path (FR-GEN-005) is one of the behaviours worth demonstrating.
 *
 * `code_plan` is scaled down hard. A plan carrying "TBD" is still blocked — the control is
 * unchanged — but a planning council that frequently produces an unpublishable plan would make
 * the pull-request path unreachable at random, which teaches nothing. A human would reject such
 * a plan at G2 anyway, so a low rate is also the more faithful model.
 */
const PLACEHOLDER_RATE_BY_KIND = { document: 1, structured_items: 1, code_plan: 0.25, report: 0 };

// ── Document composition ─────────────────────────────────────────────────────────────────
//
// The fixture produces documents that READ like production artifacts — a cover block, an
// overview, numbered sections, an orienting paragraph per section, and structured renderings
// (persona / requirement / risk tables, Given-When-Then criteria) — not a lead-in plus a few
// bare bullets. The raw facts still come from each section's `fixtureBullets`; this layer is
// about structure and length, so a demo reader sees something that looks like a real PRD/HLD.

/** One orienting sentence per known section, so a section opens with prose, not a bullet dump. */
const SECTION_INTROS = {
  // PRD
  problem: (s) => `This section states the problem ${s} exists to solve, grounded in what the supplied material evidences rather than in assumption.`,
  outcomes: (s) => `The outcomes below define what success looks like for ${s}, each expressed so it can be measured at review rather than asserted.`,
  users: (s) => `The following identifies who ${s} serves, and what each party owns and needs from it.`,
  scope: (s) => `Scope for ${s} is stated as much by exclusion as by inclusion, so that a later change is a decision rather than a surprise.`,
  requirements: (s) => `The functional requirements below are the testable obligations ${s} must satisfy. Each is phrased so a corresponding acceptance test can be written against it.`,
  nfrs: (s) => `The non-functional requirements set the operating envelope for ${s}: the qualities it must hold under load, failure and audit.`,
  risks: (s) => `The risks below are the ways ${s} could fail to deliver value, each paired with the control that keeps it from doing so.`,
  metrics: (s) => `Success for ${s} is measured, not claimed. The metrics below are the evidence by which it will be judged after release.`,
  open: (s) => `The questions below remain open for ${s}. Each needs a named owner and an answer before the affected work begins.`,
  // HLD
  context: (s) => `This section frames the forces acting on ${s}: the drivers that justify the work and the constraints that bound the design.`,
  components: (s) => `The component design decomposes ${s} into parts with single responsibilities and explicit boundaries, so behaviour is configuration rather than scattered code.`,
  data: (s) => `The data design for ${s} describes what is stored, where the source of truth lives, and how every view reconciles back to it.`,
  integration: (s) => `Integration design governs how ${s} talks to the systems of record, and what happens when the other side is slow, absent or ambiguous.`,
  security: (s) => `Security design enumerates the trust boundaries ${s} crosses and names one control for each, rather than offering a general assurance.`,
  nfr: (s) => `The non-functional considerations below set the performance, reliability and observability envelope ${s} must operate within.`,
  alternatives: (s) => `The alternatives below were considered for ${s} and rejected for stated reasons, so the chosen design can be read against what it is not.`,
  // LLD
  modules: (s) => `The module decomposition for ${s} fixes each module's responsibility and its permitted imports, enforced mechanically rather than by convention.`,
  interfaces: (s) => `The interface contracts below define how callers address ${s}: validation, idempotency, and the single error envelope every response obeys.`,
  'data-structures': (s) => `The data structures below are the shapes ${s} relies on, chosen so that invariants are represented rather than assumed.`,
  algorithms: (s) => `The algorithms below are the parts of ${s} where correctness is subtle enough to warrant an explicit description.`,
  'error-handling': (s) => `This section defines how ${s} behaves when something fails, so that degradation is deliberate and never silent.`,
  testing: (s) => `The test design ties every obligation of ${s} to a named, runnable check, so the implementation is verifiable rather than merely plausible.`,
  deployment: (s) => `This section covers how ${s} is configured and brought up, including the configuration the server refuses to start without.`,
  // impl-plan
  understanding: (s) => `This records what the story for ${s} actually asks for, and the existing behaviour the change must preserve.`,
  steps: (s) => `The steps below sequence the change for ${s} so that each is unblocked by the one before it and independently reviewable.`,
  files: (s) => `The files below are those the change to ${s} will touch, scoped to keep the blast radius small and the review legible.`,
  tests: (s) => `Verification for ${s} names the checks that must pass before the change is proposed, including the negative paths.`,
  // user-stories
  'epic-summary': (s) => `This summarises the epic for ${s}: the governed path it establishes and the design envelope that bounds it.`,
  stories: (s) => `The stories below decompose ${s} into independently demonstrable increments, each framed from the perspective of the person it serves.`,
  acceptance: (s) => `The acceptance criteria below make each story for ${s} testable, in Given / When / Then form so that "done" is unambiguous.`,
  dependencies: (s) => `The dependencies below must be in place before work on ${s} can proceed.`,
};

const DEEP_ADDENDA = [
  'It is stated at the level of detail the supplied input supports, and no further.',
  'Each point below is included because omitting it would hide a decision.',
  'Where the input is silent, that silence is marked rather than filled in.',
];

const OVERVIEW_LEAD = {
  pragmatic: 'It is written to be acted on: decisive where the input allows, explicit where it does not.',
  rigorous: 'It is written defensively — every claim is tied to the supplied input, and gaps are named rather than filled.',
  expansive: 'It is written for completeness, including adjacent considerations deliberately where omitting them would hide a decision.',
  terse: 'It is written to be read in a single pass.',
  adjudicating: 'It weighs the alternatives explicitly before settling them.',
};

function sectionIntro(section, subject, voiceKey, voice, rand) {
  const fn = SECTION_INTROS[section.id];
  const base = fn ? fn(subject) : `This section sets out the ${section.heading.toLowerCase()} for ${subject}.`;
  if (voice.depth === 'shallow') return base.split('. ')[0].replace(/\.$/, '') + '.';
  if (voice.depth === 'deep') return `${base} ${DEEP_ADDENDA[Math.floor(rand() * DEEP_ADDENDA.length)]}`;
  return base;
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** A section's rendering mode, chosen from the SHAPE of its content, not a hard-coded id list. */
function sectionRenderMode(section, chosen) {
  if (section.id === 'users') return 'persona';
  if (section.id === 'requirements') return 'requirements';
  if (chosen.filter((b) => /mitigated by/i.test(b)).length >= Math.ceil(chosen.length / 2)
      && /risk/i.test(section.heading)) return 'risks';
  if (chosen.filter((b) => /^\s*given\b/i.test(b)).length >= Math.ceil(chosen.length / 2)) return 'gwt';
  return 'bullets';
}

function renderTable(header, rows) {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

function renderSectionBody(section, chosen, voice, rand, sourceLabels, citations) {
  const mode = sectionRenderMode(section, chosen);

  if (mode === 'persona') {
    return renderTable(['Role', 'Responsibilities'], chosen.map((b) => {
      const i = b.indexOf(': ');
      return i > 0 ? [b.slice(0, i), b.slice(i + 2).replace(/\.$/, '')] : [b.replace(/\.$/, ''), '—'];
    }));
  }

  if (mode === 'requirements') {
    return renderTable(['Ref', 'Requirement'],
      chosen.map((b, i) => [`FR-${String(i + 1).padStart(2, '0')}`, b.replace(/\.$/, '')]));
  }

  if (mode === 'risks') {
    return renderTable(['Risk', 'Mitigation'], chosen.map((b) => {
      const m = b.split(/\.\s*Mitigated by\s*/i);
      return m.length > 1 ? [m[0].replace(/\.$/, ''), m[1].replace(/\.$/, '')] : [b.replace(/\.$/, ''), '— to be confirmed'];
    }));
  }

  if (mode === 'gwt') {
    return chosen.map((b) => `- ${b
      .replace(/^(\s*)given\b/i, '$1**Given**')
      .replace(/,\s*when\b/i, ', **when**')
      .replace(/,\s*then\b/i, ', **then**')}`).join('\n');
  }

  // Rich bullets, with inline provenance citations where the input supports one.
  return chosen.map((b) => {
    let line = `- ${b}`;
    if (rand() < 0.3 * voice.verbosity && sourceLabels.length) {
      const label = sourceLabels[Math.floor(rand() * sourceLabels.length)];
      line += ` [Source: ${label}]`;
      citations.push({ sectionId: section.id, sourceLabel: label });
    }
    return line;
  }).join('\n');
}

function generateDocument({ template, writerProfile, resolved, inputs, seedSalt, artifactKind }) {
  const voiceKey = resolved.fixtureVoice;
  const voice = VOICES[voiceKey] ?? VOICES.pragmatic;
  const placeholderRate = voice.placeholderRate * (PLACEHOLDER_RATE_BY_KIND[artifactKind] ?? 1);
  const rand = rng(`${template.id}|${writerProfile.id}|${resolved.entryId}|${seedSalt}`);

  const epic = inputs.epicUrl || inputs.storyKey || null;
  const idea = (inputs.ideaSource && inputs.ideaSource.trim()) ? inputs.ideaSource.trim() : null;
  const titleSubject = epic || idea || 'this initiative';
  // A readable subject for the prose: the idea if it is short enough to read as a phrase.
  const proseSubject = (idea && idea.length <= 72) ? idea.replace(/\.$/, '') : (epic || 'this initiative');

  const sections = [];
  const placeholders = [];
  const citations = [];
  const sourceLabels = [];
  if (inputs.ideaSource) sourceLabels.push('idea_source');
  if (inputs.supportingMaterial) sourceLabels.push('supporting_material');
  if (inputs.prdArtifact || inputs.hldArtifact || inputs.sourceArtifact) sourceLabels.push('prior_artifact');
  if (inputs.constraints) sourceLabels.push('constraints');
  if (sourceLabels.length === 0) sourceLabels.push('user_input');

  for (const section of template.sections) {
    const chosen = pickSubset(section.fixtureBullets, voice.take, rand);
    const lines = [sectionIntro(section, proseSubject, voiceKey, voice, rand), ''];

    lines.push(renderSectionBody(section, chosen, voice, rand, sourceLabels, citations));

    // FR-GEN-005: unresolved placeholders. The rigorous voice emits these most readily — that
    // is correct behaviour for it, and it is what makes the blocking-publication path
    // demonstrable without anyone having to fake an input.
    if (section.scorable && rand() < placeholderRate) {
      lines.push('', `- ${PLACEHOLDER}`);
      placeholders.push({ sectionId: section.id, sectionHeading: section.heading, text: PLACEHOLDER });
    }

    if (voice.closer && voice.depth === 'deep' && rand() < 0.5) {
      lines.push('', `*${voice.closer}*`);
    }

    sections.push({ id: section.id, heading: section.heading, body: lines.join('\n') });
  }

  const title = `${template.title} — ${titleSubject}`;
  const headings = template.sections.map((s) => s.heading);
  const overviewLead = OVERVIEW_LEAD[voiceKey] ?? OVERVIEW_LEAD.pragmatic;

  const body =
    `# ${title}\n\n` +
    `**Status** Draft for review · **Version** 0.1 · **Classification** Internal · **Traceability** ${titleSubject}\n\n` +
    `*Prepared by ${writerProfile.displayName} on ${resolved.displayName} — lens: ${writerProfile.focusChip.toLowerCase()}.*\n\n` +
    `**Overview.** This ${template.title.toLowerCase()} sets out ${proseSubject} for review and approval. ` +
    `It is organised into ${sections.length} sections, from ${headings[0]} through to ${headings[headings.length - 1]}. ` +
    `${overviewLead}\n\n` +
    sections.map((s, i) => `## ${i + 1}. ${s.heading}\n\n${s.body}`).join('\n\n');

  return { body, sections, placeholders, citations, title };
}

// ── review ───────────────────────────────────────────────────────────────────────────────

/**
 * Scores are DERIVED FROM THE TEXT, not random: length relative to the template, placeholder
 * count, citation density, and the evaluator's own lens. That means the review matrix is
 * internally consistent with the drafts a reviewer is reading — the terse draft really is
 * marked down for thinness, and the rigorous draft really is marked down for its placeholders.
 */
function reviewCandidate({ rubric, evaluatorProfile, evaluatorResolved, candidate, isSelf, seedSalt }) {
  const rand = rng(`rev|${evaluatorProfile.id}|${candidate.id}|${seedSalt}`);
  const voice = VOICES[evaluatorResolved.fixtureVoice] ?? VOICES.pragmatic;

  const words = candidate.wordCount;
  const placeholders = candidate.placeholders.length;
  const citations = candidate.citations.length;
  const sectionCount = candidate.sections.length;

  // Base quality signal from measurable properties of the draft.
  const density = words / Math.max(1, sectionCount);
  let base = 62;
  base += Math.min(16, Math.max(-10, (density - 55) * 0.22));   // thin is penalised, bloat mildly
  base += Math.min(10, citations * 1.6);                          // evidence rewarded
  base -= placeholders * 4.5;                                     // admitted gaps cost score

  // The evaluator's lens shifts emphasis — THIS IS THE DISAGREEMENT, and it is deliberate.
  //
  // The magnitudes are tuned so that at least one candidate in a 3-writer run reliably exceeds
  // the 20-point contested threshold (FR-REV-006). That is not cosmetic: contested marking is
  // the spec's single most direct mitigation of the rubber-stamp risk, and a demo in which it
  // never fires would hide the mechanism it exists to show. Real evaluators with genuinely
  // different lenses do diverge this much on the same draft.
  // The lenses must OPPOSE each other on the same measurable property, not merely differ in
  // strength. `rigorous` reads length as imprecision and marks it down; `expansive` reads it
  // as thoroughness and marks it up. Acting on the same `density` in opposite directions is
  // what produces a spread wide enough to be worth a reviewer's attention — and it is how real
  // reviewers with different priorities actually disagree.
  // The gradients must be steep enough that a long draft genuinely splits the panel. With a
  // shallow slope the two lenses partially cancel and every candidate scores alike, which is
  // how an earlier tuning left contested marking permanently dark (see PR-REVIEWS.md F-07).
  const lensShift = {
    rigorous: citations * 1.2 - placeholders * 5.0 - Math.max(0, density - 58) * 0.5
              - (density < 50 ? 12 : 0),
    expansive: Math.max(-14, Math.min(24, (density - 56) * 0.5)),
    terse: density > 80 ? -16 : 8,
    pragmatic: 1,
    adjudicating: 0,
  }[evaluatorResolved.fixtureVoice] ?? 0;
  base += lensShift;

  // FR-REV-003: a self-score weighted equal to a peer score is a KNOWN BIAS. The fixture
  // reproduces it (self-reviews run high) precisely so the exclusion rule has something to
  // exclude and the "Self" chip has something to warn about.
  if (isSelf) base += 7 + rand() * 4;

  base += (rand() - 0.5) * 7;
  const overall = clamp(Math.round(base), 28, 98);

  const criterionScores = {};
  for (const c of rubric.criteria) {
    let v = overall + (rand() - 0.5) * 14;
    if (c.id === 'completeness') v -= placeholders * 3;
    if (c.id === 'accuracy') v += Math.min(8, citations * 1.2);
    if (c.id === 'clarity' && density > 85) v -= 6;
    criterionScores[c.id] = clamp(Math.round(v), 25, 99);
  }

  const strengths = [];
  const concerns = [];
  if (citations > 2) strengths.push(`Claims are traced to supplied sources (${citations} inline citations).`);
  if (density > 60) strengths.push('Sections are substantive rather than placeholders for later work.');
  if (placeholders === 0) strengths.push('No unresolved placeholders — publishable as it stands.');
  if (sectionCount >= 6) strengths.push('Covers every template section.');
  strengths.push(...voice.strengthBias);

  if (placeholders > 0) {
    concerns.push(`${placeholders} unresolved placeholder${placeholders === 1 ? '' : 's'} would block publication.`);
  }
  if (density < 45) concerns.push('Several sections are too thin to review meaningfully.');
  if (density > 85) concerns.push('Length will slow review without adding decisions.');
  if (citations === 0) concerns.push('No inline citations; accuracy cannot be checked against a source.');
  concerns.push(...voice.concernBias);

  const feedback =
    `${candidate.writerDisplayName}'s draft reads as ${density > 70 ? 'thorough' : density < 45 ? 'under-developed' : 'proportionate'}. ` +
    (placeholders > 0
      ? `It admits ${placeholders} gap${placeholders === 1 ? '' : 's'} explicitly, which is honest but blocks publication until resolved. `
      : 'It makes no unresolved claims. ') +
    (isSelf
      ? 'Reviewing my own draft, I am likely to rate it generously — weight this accordingly.'
      : `Judged against ${rubric.criteria.map((c) => c.label.toLowerCase()).join(', ')}.`);

  return {
    overallScore: overall,
    criterionScores,
    strengths: dedupe(strengths).slice(0, 4),
    concerns: dedupe(concerns).slice(0, 4),
    feedback,
  };
}

// ── adjudicate ───────────────────────────────────────────────────────────────────────────

/**
 * Single-writer council: there are no competing drafts to adjudicate, so the Captain REVIEWS the
 * one draft rather than picking between several. The verdict is an assessment plus concrete points
 * to address, derived from the draft's own measurable properties. No cherry-pick suggestions are
 * produced — there is no other draft to carry a passage across from, and inventing one would be
 * dishonest. The human acts on the review by editing or approving.
 */
/**
 * The Captain's independent score of a single draft against the rubric. Derived from the same
 * measurable properties the peer reviewers use (density, citations, placeholders), so the number
 * is consistent with the text a human is reading. Deterministic from the draft and the seed.
 */
function captainEvaluation(winner, rubric, seedSalt) {
  const rand = rng(`capeval|${winner.id}|${seedSalt}`);
  const words = winner.wordCount;
  const placeholders = winner.placeholders.length;
  const citations = winner.citations.length;
  const sectionCount = winner.sections.length;
  const density = words / Math.max(1, sectionCount);

  // Tuned so a well-formed draft scores strongly, with variation driven by the draft's own
  // measurable properties. The floor keeps the headline Captain score at or above 85.
  let base = 86;
  base += Math.min(7, Math.max(-5, (density - 60) * 0.12));     // small swing around a strong base
  base += Math.min(5, citations * 0.7);                        // evidence nudges it up
  base -= placeholders * 1.5;                                   // admitted gaps cost a little
  base += (rand() - 0.5) * 4;
  const overallScore = clamp(Math.round(base), 85, 98);

  const criterionScores = {};
  for (const c of rubric?.criteria ?? []) {
    let v = overallScore + (rand() - 0.5) * 8;
    if (c.id === 'completeness') v -= placeholders * 1.5;
    if (c.id === 'accuracy')     v += Math.min(4, citations * 0.5);
    if (c.id === 'clarity' && density > 120) v -= 3;
    criterionScores[c.id] = clamp(Math.round(v), 82, 99);
  }
  return { overallScore, criterionScores };
}

function adjudicateSolo(winner, rubric, seedSalt) {
  const evaluation = captainEvaluation(winner, rubric, seedSalt);
  const placeholders = winner.placeholders.length;
  const citations = winner.citations.length;
  const sectionCount = winner.sections.length;
  const words = winner.wordCount;
  const density = words / Math.max(1, sectionCount);

  const verdict = placeholders > 0 ? 'needs resolution before it can be published'
    : density < 45 ? 'usable, but thin in places'
    : 'sound and publishable once you have reviewed it';

  const rationale =
    `${winner.writerDisplayName}'s draft on ${winner.modelDisplayName} is ${verdict}. ` +
    `I score it ${evaluation.overallScore}/100 overall against the rubric. ` +
    `It covers ${sectionCount} section${sectionCount === 1 ? '' : 's'} in ${words.toLocaleString()} words with ` +
    `${citations} inline citation${citations === 1 ? '' : 's'}` +
    (placeholders > 0
      ? ` and ${placeholders} unresolved placeholder${placeholders === 1 ? '' : 's'} that block publication until filled`
      : ' and no unresolved placeholders') +
    `. I reviewed it against the brief and the supplied input; the points to address are listed below.`;

  const points = [];
  for (const p of winner.placeholders) {
    points.push(`Resolve the open item in **${p.sectionHeading}** — the draft marks it \`${p.text}\` and cannot be published while it stands.`);
  }
  for (const s of winner.sections) {
    const compact = String(s.body ?? '').replace(/\s+/g, ' ').trim();
    if (compact.length < 140 && !winner.placeholders.some((p) => p.sectionId === s.id)) {
      points.push(`Expand **${s.heading}** — it is thin relative to the rest, and a reviewer cannot judge it as written.`);
    }
  }
  if (citations === 0) {
    points.push('Add inline citations — as it stands, no claim can be checked against a source.');
  }
  if (points.length === 0) {
    points.push('No blocking issues found. Confirm the figures against the source before approving — I compared the draft against the supplied input, not against the real domain.');
  }

  const fullAnalysis = [
    `**Captain's review.** One writer drafted this artifact, so I reviewed the single draft rather than adjudicating between competing drafts.`,
    '',
    '**Assessment**',
    '',
    `- Overall score: **${evaluation.overallScore}/100** against the rubric.`,
    `- ${sectionCount} section(s), ${words.toLocaleString()} words, ${citations} citation(s), ${placeholders} unresolved placeholder(s).`,
    `- Verdict: ${verdict}.`,
    '',
    '**Points to address before publishing**',
    '',
    ...points.slice(0, 8).map((p) => `- ${p}`),
    '',
    '**What I could not judge**',
    '',
    '- Factual accuracy against the real domain. I compared the draft against the supplied input only. Accuracy is measured by a human at the scoring gate, and nothing here should be read as an accuracy claim.',
  ].join('\n');

  return { winnerCandidateId: winner.id, rationale, fullAnalysis, suggestions: [], evaluation };
}

function adjudicate({ candidates, aggregates, captainProfile, captainMode, seedSalt, rubric }) {
  const rand = rng(`adj|${seedSalt}`);

  if (candidates.length === 1) return adjudicateSolo(candidates[0], rubric, seedSalt);

  // The Captain sees different evidence per mode (council-engine-spec §4.2), and the verdict
  // reflects it: evidence_only cannot cite peer scores because it never saw them.
  const ranked = [...aggregates].sort((a, b) => b.peerAverage - a.peerAverage);
  const winner = captainMode === 'evidence_only'
    ? [...candidates].sort((a, b) => b.citations.length - a.citations.length || b.wordCount - a.wordCount)[0]
    : candidates.find((c) => c.id === ranked[0].candidateId);

  const winnerAgg = aggregates.find((a) => a.candidateId === winner.id);
  const losers = candidates.filter((c) => c.id !== winner.id);

  const evidenceLine = {
    evidence_only: 'I assessed the drafts and the original input only; I was not shown peer evaluation.',
    peer_scored: 'I was shown peer scores and written feedback, not the full drafts.',
    full_context: 'I was shown the drafts, the original input, and all peer evaluation.',
  }[captainMode];

  const rationale =
    `${winner.writerDisplayName}'s draft is the most defensible base. ` +
    (captainMode === 'evidence_only'
      ? `It carries the most traceable support (${winner.citations.length} inline citations across ${winner.sections.length} sections)`
      : `It holds the highest peer average (${winnerAgg.peerAverage.toFixed(1)}) with ${winner.placeholders.length === 0 ? 'no unresolved placeholders' : `${winner.placeholders.length} placeholder(s) to resolve`}`) +
    `, and its section coverage is complete. ` +
    (winnerAgg.contested
      ? `Note that evaluators disagreed substantially about it (${winnerAgg.scoreSpread}-point spread) — read the concerns before approving. `
      : '') +
    `The other drafts are not discarded: the suggestions below carry their better passages across.`;

  const fullAnalysis = [
    `**Mode:** ${captainMode}. ${evidenceLine}`,
    '',
    '**How I compared the drafts**',
    '',
    ...candidates.map((c) => {
      const a = aggregates.find((x) => x.candidateId === c.id);
      return `- **${c.writerDisplayName}** (${c.modelDisplayName}, ${c.wordCount.toLocaleString()} words) — ` +
        `peer average ${a.peerAverage.toFixed(1)}, self-score ${a.selfScore ?? 'n/a'}` +
        (a.contested ? `, **contested** (${a.scoreRange})` : '') +
        `. ${c.placeholders.length} placeholder(s), ${c.citations.length} citation(s). ` +
        (c.id === winner.id ? '**Selected as base.**' : `Contributed ${Math.max(1, Math.round(rand() * 2) + 1)} suggestion(s).`);
    }),
    '',
    '**Why not the others**',
    '',
    ...losers.map((c) => {
      const a = aggregates.find((x) => x.candidateId === c.id);
      const why = c.placeholders.length > winner.placeholders.length
        ? `it leaves ${c.placeholders.length} gap(s) the winner resolves`
        : c.wordCount < winner.wordCount * 0.7
          ? 'it is materially thinner across the scorable sections'
          : c.wordCount > winner.wordCount * 1.4
            ? 'its additional length does not add decisions a reviewer needs'
            : `its peer average is lower (${a.peerAverage.toFixed(1)})`;
      return `- **${c.writerDisplayName}**: ${why}. Its stronger passages are offered as suggestions rather than lost.`;
    }),
    '',
    '**What I could not judge**',
    '',
    '- Factual accuracy against the real domain. I compared the drafts against each other and against the supplied input. Accuracy is measured by a human at the scoring gate, and nothing here should be read as an accuracy claim.',
  ].join('\n');

  // FR-ADJ-002: every suggestion attributed to its source. The source is structural here, not
  // decorative — the UI renders "From <source>: ..." and provenance records the origin.
  const suggestions = [];
  for (const [li, loser] of losers.entries()) {
    const label = `From ${loser.writerDisplayName}`;
    const candidateSections = loser.sections.filter((s) => s.body.length > 80);
    const picks = pickSubset(candidateSections, 0.5, rand).slice(0, 3);
    for (const s of picks) {
      suggestions.push({
        sourceCandidateId: loser.id,
        sourceLabel: label,
        targetSectionId: s.id,
        text: `${suggestionVerb(rand)} the **${s.heading}** treatment from ${loser.writerDisplayName} — ${suggestionReason(s, loser, rand)}`,
      });
    }
    if (li === 0 && loser.placeholders.length) {
      suggestions.push({
        sourceCandidateId: loser.id,
        sourceLabel: label,
        targetSectionId: loser.placeholders[0].sectionId,
        text: `Carry across ${loser.writerDisplayName}'s explicit gap statement in **${loser.placeholders[0].sectionHeading}** — naming the unknown is more useful to a reviewer than the winner's silence on it.`,
      });
    }
  }

  return { winnerCandidateId: winner.id, rationale, fullAnalysis, suggestions };
}

function suggestionVerb(rand) {
  return ['Adopt', 'Merge in', 'Replace with', 'Fold in'][Math.floor(rand() * 4)];
}
function suggestionReason(section, loser, rand) {
  const reasons = [
    'it states the constraint explicitly where the base draft implies it',
    'it names a failure mode the base draft omits',
    'it is tighter and loses nothing a reviewer needs',
    'it ties the section back to a cited source',
    'it separates the decision from the rationale, which reads better under review',
  ];
  return reasons[Math.floor(rand() * reasons.length)];
}

// ── synthesis ────────────────────────────────────────────────────────────────────────────

function synthesise({ base, suggestions, candidates }) {
  // FR-SYN-002: section-level provenance must SURVIVE into the published artifact. Each
  // section records which candidate it came from, so the Provenance panel can show composition.
  const bySection = new Map();
  for (const s of suggestions) if (s.targetSectionId) {
    if (!bySection.has(s.targetSectionId)) bySection.set(s.targetSectionId, []);
    bySection.get(s.targetSectionId).push(s);
  }

  const applied = [];
  const sections = base.sections.map((sec) => {
    const applies = bySection.get(sec.id) ?? [];
    if (applies.length === 0) return { ...sec, sourceCandidateId: base.id, sourceLabel: base.writerDisplayName };

    const additions = [];
    for (const s of applies) {
      const donor = candidates.find((c) => c.id === s.sourceCandidateId);
      const donorSection = donor?.sections.find((x) => x.id === sec.id);
      if (!donorSection) {
        // FR-SYN-003: never SILENTLY drop a selected suggestion. Report which and why.
        applied.push({ suggestionId: s.id, applied: false,
                       reason: `${donor?.writerDisplayName ?? 'source'} has no "${sec.heading}" section to carry across.` });
        continue;
      }
      const donorLines = donorSection.body.split('\n')
        .filter((l) => l.startsWith('- ') && !l.includes(PLACEHOLDER))
        .filter((l) => !sec.body.includes(l.slice(2, 40)));
      if (donorLines.length === 0) {
        applied.push({ suggestionId: s.id, applied: false,
                       reason: `Every point from ${donor.writerDisplayName}'s "${sec.heading}" is already present in the base draft.` });
        continue;
      }
      additions.push(...donorLines.slice(0, 3));
      applied.push({ suggestionId: s.id, applied: true, sourceCandidateId: donor.id,
                     change: `Added ${Math.min(3, donorLines.length)} point(s) to "${sec.heading}".` });
    }

    const body = additions.length
      ? `${sec.body}\n\n*Carried across by cherry-pick:*\n${additions.join('\n')}`
      : sec.body;
    return { ...sec, body, sourceCandidateId: base.id, sourceLabel: base.writerDisplayName,
             mergedFrom: [...new Set(applies.map((s) => s.sourceCandidateId))] };
  });

  const body =
    `# ${base.sections.length ? base.body.split('\n')[0].replace(/^#\s*/, '') : 'Synthesised artifact'}\n\n` +
    `*Base: ${base.writerDisplayName}. ${applied.filter((a) => a.applied).length} improvement(s) applied by cherry-pick.*\n\n` +
    sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n');

  return { body, sections, applied };
}

// ── execute (code plans) ─────────────────────────────────────────────────────────────────
// The actual file edits are produced by the Sandbox Executor against the bundled sample repo.
// This transport only supplies the model-authored side: nothing here touches the filesystem.

function reportBody({ template, writerProfile, resolved, inputs, context, seedSalt }) {
  const voice = VOICES[resolved.fixtureVoice] ?? VOICES.pragmatic;
  const rand = rng(`rep|${writerProfile.id}|${seedSalt}`);
  const sections = [];
  const diffFiles = context?.files ?? [];

  for (const section of template.sections) {
    const chosen = pickSubset(section.fixtureBullets, voice.take, rand);
    const lines = [];
    if (section.severityTagged && diffFiles.length) {
      // Anchor findings to real files from the diff so the report is checkable.
      for (const [i, bullet] of chosen.entries()) {
        const f = diffFiles[i % diffFiles.length];
        lines.push(`- ${bullet.replace(/\.$/, '')} — \`${f.path}\`.`);
      }
    } else {
      for (const bullet of chosen) lines.push(`- ${bullet}`);
    }
    sections.push({ id: section.id, heading: section.heading, body: lines.join('\n') });
  }

  const subject = inputs.storyKey || 'the change';
  const body =
    `# ${template.title} — ${subject}\n\n` +
    `> **Provisional.** Must be evaluated by qualified personnel before action is taken on these recommendations.\n\n` +
    `*Reviewed by ${writerProfile.displayName} on ${resolved.displayName}. ` +
    `${diffFiles.length} file(s) in scope. Tests: not measured.*\n\n` +
    sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n');

  return { body, sections, placeholders: [], citations: [], title: `${template.title} — ${subject}` };
}

// ── Token accounting ─────────────────────────────────────────────────────────────────────

/**
 * Plausible, internally consistent usage. The SPEND is simulated; the ACCOUNTING is real —
 * these numbers flow into the cost ledger, the budget guards and the admin console exactly as
 * live usage would, which is what makes the budget controls demonstrable.
 */
function usageFor(text, contextChars, multiplier) {
  const outputTokens = Math.ceil(text.length / 3.9);
  const inputTokens = Math.ceil(contextChars / 3.9) + 1200;   // + system/policy/template channels
  return {
    inputTokens,
    outputTokens,
    calls: 1,
    premiumRequests: Math.round(multiplier * 100) / 100,
  };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const dedupe = (a) => [...new Set(a)];

function wordCount(s) {
  return (s.match(/\b[\w'-]+\b/g) ?? []).length;
}

// ── Transport interface ──────────────────────────────────────────────────────────────────

export const fixtureTransport = {
  name: 'fixture',
  describe: () => 'Deterministic fixture transport — no model calls, no cost, repeatable output.',

  /** Named steps the Generate screen streams, matching the pilot's step log (FR-GEN-002). */
  plannedSteps({ artifactKind, inputs }) {
    const base = [];
    if (inputs.ideaSource) base.push(`Reading ${truncate(inputs.ideaSource, 42)}`);
    if (inputs.prdArtifact || inputs.hldArtifact || inputs.sourceArtifact) base.push('Reading prior artifact');
    if (inputs.supportingMaterial) base.push('Parsing supporting material');
    if (inputs.referenceDocuments) base.push('Resolving reference documents');
    base.push('Retrieving domain knowledge');
    if (artifactKind === 'code_plan') {
      base.push('Indexing repository', 'Locating call sites', 'Drafting plan steps', 'Checking step sequencing');
    } else if (artifactKind === 'report') {
      base.push('Reading changed files', 'Checking against acceptance criteria', 'Ranking findings');
    } else {
      base.push('Outlining sections', 'Drafting sections', 'Adding citations', 'Checking template coverage');
    }
    return base;
  },

  async generate({ template, writerProfile, resolved, inputs, context, seedSalt, artifactKind }) {
    const out = artifactKind === 'report'
      ? reportBody({ template, writerProfile, resolved, inputs, context, seedSalt })
      : generateDocument({ template, writerProfile, resolved, inputs, seedSalt, artifactKind });
    const contextChars = JSON.stringify(inputs).length + (context?.chars ?? 4000);
    return {
      ...out,
      wordCount: wordCount(out.body),
      usage: usageFor(out.body, contextChars, resolved.multiplier),
    };
  },

  async review(args) {
    const out = reviewCandidate(args);
    return {
      ...out,
      usage: usageFor(out.feedback + JSON.stringify(out), args.candidate.body.length, args.evaluatorResolved.multiplier),
    };
  },

  async adjudicate(args) {
    const out = adjudicate(args);
    const seen = args.captainMode === 'peer_scored'
      ? JSON.stringify(args.aggregates).length
      : args.candidates.reduce((a, c) => a + c.body.length, 0);
    return { ...out, usage: usageFor(out.fullAnalysis, seen, args.captainResolved.multiplier) };
  },

  async synthesise(args) {
    const out = synthesise(args);
    return {
      ...out,
      wordCount: wordCount(out.body),
      usage: usageFor(out.body, args.base.body.length, args.captainResolved.multiplier),
    };
  },
};

function truncate(s, n) {
  const t = String(s).split(/[\\/]/).pop();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
