// Cost estimation and budget enforcement (FR-COST-001..004, NFR-COST-001/002, DEC-19, T-05).
//
// The spec is blunt about why this module exists: the pilot had NO cost surface at all, yet
// token economics drove its single biggest design decision — the team chose plan-first over
// execute mode specifically because "it uses less tokens versus the execute mode". A product
// whose main cost lever is invisible cannot be operated responsibly.
//
// Unit of record: the Copilot PREMIUM REQUEST (AM-04).
//   premiumRequests = Σ over calls ( resolvedModel.premiumRequestMultiplier )
// Raw tokens are estimated and capped in addition — an inflated context is the other way to
// spend without noticing, and "token budget" is what people actually say.

import { recordCost, runConsumption, dailyConsumption } from '../persistence/repos/cost.repo.js';

/**
 * How many model calls each phase makes, as a function of writer count. This is the whole cost
 * model and it is deliberately explicit rather than buried in the engine: N writers cost N
 * calls to generate but N² to review, which is why a 5-writer council is 25 reviews and not 5.
 */
export function plannedCalls(phases, writerCount) {
  const calls = {};
  if (phases.includes('generate')) calls.generate = writerCount;
  if (phases.includes('review')) calls.review = writerCount * writerCount;   // FR-REV-001
  if (phases.includes('adjudicate')) calls.adjudicate = 1;
  return calls;
}

const CONTEXT_FLOOR_TOKENS = 1200;        // system + policy + template channels
const OUTPUT_TOKENS_PER_SECTION = 420;    // observed across the fixture templates
const REVIEW_OUTPUT_TOKENS = 500;
const CAPTAIN_OUTPUT_TOKENS = 1600;

/**
 * FR-COST-001 / NFR-COST-001: a pre-run estimate from writer count, resolved models and the
 * MEASURED context size — not a guess independent of the inputs.
 */
export function estimateRun({ phases, writerSelection, captainResolved, template, inputs, budget, consumedToday }) {
  const writerCount = writerSelection.length;
  const calls = plannedCalls(phases, writerCount);

  const inputChars = JSON.stringify(inputs ?? {}).length;
  const contextTokens = Math.ceil(inputChars / 3.9) + CONTEXT_FLOOR_TOKENS;
  const sectionCount = template.sections.length;
  const draftTokens = sectionCount * OUTPUT_TOKENS_PER_SECTION;

  const lines = [];
  let premiumRequests = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  if (calls.generate) {
    for (const w of writerSelection) {
      premiumRequests += w.multiplier;
      inputTokens += contextTokens;
      outputTokens += draftTokens;
    }
    lines.push({ phase: 'generate', calls: calls.generate,
                 premiumRequests: round2(writerSelection.reduce((a, w) => a + w.multiplier, 0)) });
  }

  if (calls.review) {
    // Every writer reviews every candidate, so each evaluator reads `writerCount` drafts.
    let pr = 0;
    for (const evaluator of writerSelection) {
      for (let i = 0; i < writerCount; i++) {
        pr += evaluator.multiplier;
        inputTokens += draftTokens + CONTEXT_FLOOR_TOKENS;
        outputTokens += REVIEW_OUTPUT_TOKENS;
      }
    }
    premiumRequests += pr;
    lines.push({ phase: 'review', calls: calls.review, premiumRequests: round2(pr) });
  }

  if (calls.adjudicate && captainResolved) {
    premiumRequests += captainResolved.multiplier;
    inputTokens += draftTokens * writerCount + contextTokens;
    outputTokens += CAPTAIN_OUTPUT_TOKENS;
    lines.push({ phase: 'adjudicate', calls: 1, premiumRequests: round2(captainResolved.multiplier) });
  }

  premiumRequests = round2(premiumRequests);
  const totalTokens = inputTokens + outputTokens;

  // A range, not a point. Reporting a single number implies a precision estimation does not have.
  const low = round2(premiumRequests * 0.85);
  const high = round2(premiumRequests * 1.3);

  const dailyRemaining = round2(budget.perUserDailyPremiumRequests - consumedToday.premiumRequests);
  const dailyTokensRemaining = budget.perUserDailyTokens - consumedToday.tokens;
  const price = budget.premiumRequestPrice;

  const estimate = {
    writerCount,
    calls,
    totalCalls: Object.values(calls).reduce((a, b) => a + b, 0),
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    estimatedTotalTokens: totalTokens,
    contextTokens,
    premiumRequests,
    premiumRequestsLow: low,
    premiumRequestsHigh: high,
    perPhase: lines,
    perRunLimit: budget.perRunPremiumRequests,
    perRunTokenLimit: budget.perRunTokens,
    dailyLimit: budget.perUserDailyPremiumRequests,
    dailyConsumed: consumedToday.premiumRequests,
    dailyRemaining,
    dailyTokensLimit: budget.perUserDailyTokens,
    dailyTokensConsumed: consumedToday.tokens,
    dailyTokensRemaining,
    warnPercent: budget.warnPercent,
    // Currency is OPTIONAL display only — the unit of record is the premium request (AM-04).
    currency: price?.currency ?? null,
    estimatedCostMinorUnits: price ? Math.round(premiumRequests * price.minorUnits) : null,
    estimatedCostLowMinorUnits: price ? Math.round(low * price.minorUnits) : null,
    estimatedCostHighMinorUnits: price ? Math.round(high * price.minorUnits) : null,
    requiresConfirmation: premiumRequests >= (budget.confirmAbovePremiumRequests ?? Infinity),
  };

  return { estimate, ...checkBudget(estimate, budget, consumedToday) };
}

/**
 * FR-COST-002: enforce per-run AND per-user-daily budgets, blocking with an explanation that
 * NAMES THE LIMIT. Server-side only — FR-API-002 forbids accepting a budget decision from the
 * client, because a client that can waive its own budget does not have one.
 */
export function checkBudget(estimate, budget, consumedToday) {
  const warnings = [];

  if (estimate.premiumRequestsHigh > budget.perRunPremiumRequests) {
    return {
      allowed: false,
      block: {
        code: 'budget_exceeded',
        requirementId: 'FR-COST-002',
        message:
          `This run is estimated at up to ${estimate.premiumRequestsHigh} premium requests, but the ` +
          `per-run limit is ${budget.perRunPremiumRequests}. Reduce the writer count or choose cheaper models.`,
        detail: { limit: budget.perRunPremiumRequests, estimated: estimate.premiumRequestsHigh, scope: 'per_run' },
      },
      warnings,
    };
  }

  if (estimate.estimatedTotalTokens > budget.perRunTokens) {
    return {
      allowed: false,
      block: {
        code: 'budget_exceeded',
        requirementId: 'FR-COST-002',
        message:
          `This run is estimated at ${estimate.estimatedTotalTokens.toLocaleString()} tokens, but the ` +
          `per-run token limit is ${budget.perRunTokens.toLocaleString()}. Reduce the context or the writer count.`,
        detail: { limit: budget.perRunTokens, estimated: estimate.estimatedTotalTokens, scope: 'per_run_tokens' },
      },
      warnings,
    };
  }

  if (estimate.premiumRequestsHigh > estimate.dailyRemaining) {
    return {
      allowed: false,
      block: {
        code: 'budget_exceeded',
        requirementId: 'FR-COST-002',
        message:
          `This run is estimated at up to ${estimate.premiumRequestsHigh} premium requests but only ` +
          `${estimate.dailyRemaining} of today's budget of ${budget.perUserDailyPremiumRequests} remains. ` +
          `The budget resets at 00:00 UTC.`,
        detail: { limit: budget.perUserDailyPremiumRequests, remaining: estimate.dailyRemaining,
                  estimated: estimate.premiumRequestsHigh, scope: 'daily' },
      },
      warnings,
    };
  }

  if (estimate.estimatedTotalTokens > estimate.dailyTokensRemaining) {
    return {
      allowed: false,
      block: {
        code: 'budget_exceeded',
        requirementId: 'FR-COST-002',
        message:
          `This run is estimated at ${estimate.estimatedTotalTokens.toLocaleString()} tokens but only ` +
          `${estimate.dailyTokensRemaining.toLocaleString()} of today's token budget remains.`,
        detail: { scope: 'daily_tokens', remaining: estimate.dailyTokensRemaining },
      },
      warnings,
    };
  }

  // Warning threshold (DEC-19): configurable, mandatory, and surfaced before the spend.
  const projectedPct =
    ((consumedToday.premiumRequests + estimate.premiumRequests) / budget.perUserDailyPremiumRequests) * 100;
  if (projectedPct >= budget.warnPercent) {
    warnings.push({
      code: 'budget_warning',
      message:
        `This run would take today's usage to ${Math.round(projectedPct)}% of the daily budget ` +
        `(warning threshold ${budget.warnPercent}%).`,
    });
  }

  for (const w of estimate.contextTokens > 0 ? [] : []) warnings.push(w);

  return { allowed: true, block: null, warnings };
}

/** Long-context warning: a writer whose window cannot hold the context will truncate. */
export function contextWarnings(writerSelection, estimate) {
  const out = [];
  for (const w of writerSelection) {
    if (estimate.contextTokens > w.contextWindow) {
      out.push({
        code: 'long_context',
        message:
          `Context is ${estimate.contextTokens.toLocaleString()} tokens; ${w.modelDisplayName} has a ` +
          `${w.contextWindow.toLocaleString()}-token window and will truncate.`,
      });
    }
  }
  return out;
}

/**
 * Mid-run guard (threat T-05, denial of wallet). Re-checked before EVERY phase, because an
 * estimate made before `generate` cannot know what `review` will actually cost. A run that
 * would breach its per-run cap stops and KEEPS its settled candidates — the work already paid
 * for is not thrown away.
 */
export function guardPhase({ runId, phase, budget, actor }) {
  const spent = runConsumption(runId);
  if (spent.premiumRequests >= budget.perRunPremiumRequests) {
    return {
      allowed: false,
      reason:
        `Run halted before "${phase}": it has consumed ${spent.premiumRequests} premium requests, ` +
        `reaching the per-run limit of ${budget.perRunPremiumRequests}. Completed work is preserved.`,
      reasonCode: 'budget_exceeded',
    };
  }
  if (spent.tokens >= budget.perRunTokens) {
    return {
      allowed: false,
      reason:
        `Run halted before "${phase}": it has consumed ${spent.tokens.toLocaleString()} tokens, ` +
        `reaching the per-run limit of ${budget.perRunTokens.toLocaleString()}. Completed work is preserved.`,
      reasonCode: 'budget_exceeded',
    };
  }
  const today = dailyConsumption(actor);
  if (today.premiumRequests >= budget.perUserDailyPremiumRequests) {
    return {
      allowed: false,
      reason:
        `Run halted before "${phase}": today's budget of ${budget.perUserDailyPremiumRequests} premium ` +
        `requests is exhausted. Completed work is preserved and the run can resume after 00:00 UTC.`,
      reasonCode: 'budget_exceeded',
    };
  }
  return { allowed: true };
}

/** FR-COST-003: record actuals per writer, per phase and per run. */
export function meter({ runId, phase, role, profileId, resolved, usage, actor }) {
  recordCost({
    runId, phase, role, profileId,
    resolvedModel: resolved.resolvedModel,
    modelDisplayName: resolved.displayName,
    modelFamily: resolved.family,
    multiplier: resolved.multiplier,
    calls: usage.calls ?? 1,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    premiumRequests: usage.premiumRequests ?? resolved.multiplier,
    actor,
  });
}

/** FR-COST-004 / NFR-COST-004: actual vs estimate, reported after every run. */
export function variance(estimate, actualPremiumRequests) {
  if (!estimate || !estimate.premiumRequests) return null;
  return round1(((actualPremiumRequests - estimate.premiumRequests) / estimate.premiumRequests) * 100);
}

export function sizeBandFor(premiumRequests, bands) {
  for (const b of bands ?? []) {
    if (b.maxPremiumRequests === null || premiumRequests <= b.maxPremiumRequests) return b.id;
  }
  return 'unbanded';
}

const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;
