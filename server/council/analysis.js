// Review analysis: aggregates, contested detection, consensus, placeholder scanning, quality
// score. All DETERMINISTIC (architecture-overview §7) — the model produces critique text, this
// module produces the numbers a reviewer acts on.

/** FR-REV-006: an evaluator spread above 20 points marks a candidate CONTESTED. */
export const CONTESTED_SPREAD_THRESHOLD = 20;

/** Items raised by ≥2 evaluators are promoted to consensus (FR-REV-005). */
export const CONSENSUS_MIN_EVALUATORS = 2;

/**
 * Per-candidate aggregates.
 *
 * AM-09 closes OQ-12: self-reviews are EXCLUDED from the peer average and displayed
 * separately. The pilot included them at equal weight, which inflates every candidate by its
 * own author's optimism. `allEvaluatorAverage` is kept so the exclusion is visible rather than
 * silent — a reviewer can see what the self-score did.
 */
export function computeAggregates(candidates, reviews) {
  return candidates.map((c) => {
    const forThis = reviews.filter((r) => r.candidateId === c.id);
    const peer = forThis.filter((r) => !r.isSelf);
    const self = forThis.find((r) => r.isSelf) ?? null;

    const peerScores = peer.map((r) => r.overallScore);
    const allScores = forThis.map((r) => r.overallScore);

    // The spread is measured across ALL evaluators including the self-review, because a
    // self-score far above the peers IS the disagreement worth showing.
    const min = allScores.length ? Math.min(...allScores) : null;
    const max = allScores.length ? Math.max(...allScores) : null;
    const spread = min === null ? 0 : max - min;

    let highestRatedBy = null;
    let best = -1;
    for (const r of peer) {
      if (r.overallScore > best) { best = r.overallScore; highestRatedBy = r.evaluatorDisplayName; }
    }

    return {
      candidateId: c.id,
      writerProfileId: c.writerProfileId,
      writerDisplayName: c.writerDisplayName,
      modelDisplayName: c.modelDisplayName,
      modelFamily: c.modelFamily,
      wordCount: c.wordCount,
      placeholderCount: c.placeholders.length,
      citationCount: c.citations.length,
      reviewCount: forThis.length,
      peerAverage: peerScores.length ? round1(mean(peerScores)) : 0,
      selfScore: self ? self.overallScore : null,
      allEvaluatorAverage: allScores.length ? round1(mean(allScores)) : 0,
      // How much the author's own optimism would have added had it been counted.
      selfBias: self && peerScores.length ? round1(self.overallScore - mean(peerScores)) : null,
      scoreSpread: spread,
      scoreRange: min === null ? null : `${min}–${max}`,
      contested: spread > CONTESTED_SPREAD_THRESHOLD,
      highestRatedBy,
      criterionAverages: criterionAverages(peer),
    };
  });
}

function criterionAverages(reviews) {
  const sums = {};
  const counts = {};
  for (const r of reviews) {
    for (const [k, v] of Object.entries(r.criterionScores ?? {})) {
      sums[k] = (sums[k] ?? 0) + v;
      counts[k] = (counts[k] ?? 0) + 1;
    }
  }
  const out = {};
  for (const k of Object.keys(sums)) out[k] = round1(sums[k] / counts[k]);
  return out;
}

/**
 * FR-REV-005: common strengths and concerns — items raised by two or more evaluators. The spec
 * calls this "the signal reviewers act on", so near-duplicate phrasings are grouped rather than
 * listed separately; otherwise two evaluators saying the same thing differently never surfaces.
 */
export function computeConsensus(reviews) {
  const peer = reviews.filter((r) => !r.isSelf);
  return {
    commonStrengths: group(peer, 'strengths'),
    commonConcerns: group(peer, 'concerns'),
  };
}

function group(reviews, field) {
  const buckets = new Map();
  for (const r of reviews) {
    for (const item of r[field] ?? []) {
      const key = normalise(item);
      if (!buckets.has(key)) buckets.set(key, { text: item, evaluators: new Set() });
      buckets.get(key).evaluators.add(r.evaluatorDisplayName);
    }
  }
  return [...buckets.values()]
    .filter((b) => b.evaluators.size >= CONSENSUS_MIN_EVALUATORS)
    .map((b) => ({ text: b.text, evaluatorCount: b.evaluators.size, evaluators: [...b.evaluators] }))
    .sort((a, b) => b.evaluatorCount - a.evaluatorCount);
}

function normalise(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter((w) => w.length > 3).slice(0, 6).join(' ');
}

/**
 * FR-REV-001: exactly N² reviews for N settled candidates. A MISSING REVIEW FAILS THE PHASE —
 * the aggregate must not be quietly computed from whatever arrived.
 */
export function verifyReviewCompleteness(candidates, reviews, writerSelection) {
  const expected = candidates.length * writerSelection.length;
  const missing = [];
  for (const evaluator of writerSelection) {
    for (const c of candidates) {
      if (!reviews.some((r) => r.evaluatorProfileId === evaluator.profileId && r.candidateId === c.id)) {
        missing.push({ evaluator: evaluator.displayName, candidate: c.writerDisplayName });
      }
    }
  }
  return { expected, actual: reviews.length, complete: missing.length === 0 && reviews.length === expected, missing };
}

const PLACEHOLDER_RE = /TBD\s*\[UNKNOWN[^\]]*\]|\[UNKNOWN[^\]]*\]|\bTBD\b/gi;

/**
 * FR-GEN-005: unresolved placeholders detected, counted, and surfaced as a BLOCKING warning
 * before publication. The pilot shipped exactly these strings into published Confluence pages.
 */
export function scanPlaceholders(sections) {
  const found = [];
  for (const s of sections ?? []) {
    for (const m of String(s.body ?? '').matchAll(PLACEHOLDER_RE)) {
      found.push({ sectionId: s.id, sectionHeading: s.heading, text: m[0] });
    }
  }
  return found;
}

/**
 * DEC-27: a 0–100 AI quality score per candidate, against a per-skill threshold (default 80).
 * ADVISORY with a recorded override. It is NEVER accuracy — accuracy is measured by a human at
 * G4, and conflating the two would let the model grade its own homework.
 */
export function qualityScore({ candidate, template, aggregate, autoFailRules }) {
  const expected = template.sections.length;
  const present = (candidate.sections ?? []).filter((s) => (s.body ?? '').trim().length > 40).length;
  const coverage = expected ? present / expected : 0;

  const scorable = template.sections.filter((s) => s.scorable).length;
  const citationCoverage = scorable ? Math.min(1, candidate.citations.length / scorable) : 1;

  let score = 0;
  score += coverage * 45;                                       // template coverage
  score += citationCoverage * 20;                               // evidence
  score += Math.min(20, (aggregate?.peerAverage ?? 0) * 0.2);   // peer judgement
  score += candidate.placeholders.length === 0 ? 15 : Math.max(0, 15 - candidate.placeholders.length * 6);
  score = Math.round(Math.min(100, Math.max(0, score)));

  const failures = [];
  for (const rule of autoFailRules ?? []) {
    if (rule.id === 'placeholders-present' && candidate.placeholders.length > 0) {
      failures.push({ ...rule, detail: `${candidate.placeholders.length} unresolved placeholder(s).` });
    }
    if (rule.id === 'sections-missing' && present < expected) {
      failures.push({ ...rule, detail: `${expected - present} template section(s) are empty or too thin.` });
    }
    if (rule.id === 'citations-absent' && candidate.citations.length === 0) {
      failures.push({ ...rule, detail: 'No inline citations; no claim can be checked against a source.' });
    }
  }

  return {
    score,
    breakdown: {
      templateCoverage: Math.round(coverage * 100),
      citationCoverage: Math.round(citationCoverage * 100),
      peerAverage: aggregate?.peerAverage ?? null,
      placeholderCount: candidate.placeholders.length,
    },
    autoFailures: failures,
    blocking: failures.filter((f) => f.severity === 'blocking'),
  };
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const round1 = (n) => Math.round(n * 10) / 10;
