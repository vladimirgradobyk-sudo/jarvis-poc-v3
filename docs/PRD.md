---
Written for: the JARVIS product owner, delivery lead and the architects reviewing the PoC.
---

# JARVIS proof of concept — product requirements

**Version** 1.0 · **Date** 2026-11-18 · **Status** delivered
**Basis** `JARVIS-MVP-Specification-v1.6`. Requirement IDs below are that specification's.

---

## 1. Why this exists

v1.6 is implementation-ready: 1,021 requirements, 32 decisions, 17 work packages across M0–M8,
five agent families and 39 R1 skills. That is months of delivery before anyone sees the product
move, and the decisions hardest to argue about on paper are exactly the unusual ones — a council
of three writers, nine recorded reviews, a deliberately effortful scorecard, five
non-bypassable gates.

The specification itself says why those exist (`CLAUDE.md` §9):

> The hardest problem the pilot identified was not generation quality — it was that **reviewing
> AI output is harder than producing it**, and people rubber-stamp what they cannot evaluate.

So the thing worth building first is not a document generator. It is the **review apparatus**: a
demonstration that disagreement between models can be made visible, that a reviewer can be
directed to the one draft worth their attention, that accuracy can be measured rather than
claimed, and that nothing reaches a system of record without a named person approving that exact
version.

## 2. Problem

| | |
|---|---|
| **Today** | Lifecycle artifacts are produced by hand or by ad-hoc prompting. Quality varies by author rather than by difficulty. Traceability from outcome to verifying test is weak. Review is the bottleneck, not authoring |
| **The pilot proved value** | ~20% delivery-effort reduction, ~70% artifact accuracy, JMeter authoring from 1–2 days to under 2 hours, performance data collection from 4–6 hours to automated |
| **The pilot is not releasable** | Its agents could act without approval, perform autonomous git operations, and left no audit trail. It should be contained immediately (WP-00) |
| **The open question this PoC answers** | Can the governance be added without destroying the productivity — and can a reviewer actually *use* what the Council produces? |

## 3. Scope

### In scope

| # | Capability | Specification |
|---|---|---|
| 1 | One Council engine driving **four artifact kinds** through declared phases | `AD-COUNCIL`, council-engine-spec §3 |
| 2 | **Six skills** across three agent families (table below) | — |
| 3 | **Five human gates**: G1 inputs and cost, G2 plan selection, G3 captain's pick, G4 accuracy scoring, G5 publication approval | `01-product-requirements.md` §6 |
| 4 | **Token budget and consumption controls** at seven enforcement points | `NFR-COST-001…004`, DEC-19 |
| 5 | **Three start modes** over one run launcher — Agent, Action, Workflow | DEC-23, `FR-NAV-012…020` |
| 6 | **Provenance** sufficient to reconstruct how an artifact came to exist | `FR-PROV-001…004` |
| 7 | **Read-only admin console** for usage, cost and quality | DEC-25, `FR-ADMIN-001…008` |
| 8 | **Accessibility**: keyboard-complete thread, AA contrast in both themes | `UX-A11Y-001…010` |

### Out of scope

Skills package · real systems of record · Copilot ACP transport · container sandbox ·
multi-user, SSO, RBAC · knowledge bases and retrieval · the other 33 R1 skills · R2 and R3
capabilities. Rationale per item in [DEVIATIONS.md](DEVIATIONS.md).

### Permanently out of scope, by design

Autonomous commit, push, merge or deploy. Pipeline triggers. Change-record submission. These are
unreachable by an agent in **any** release, with or without approval (`FR-AGENT-004`,
`FR-INT-115`, DEC-28). AI drafts; people execute through change management.

## 4. The six skills

Chosen so that one engine is exercised across every artifact kind and both the council and solo
paths — which is the specification's own test of whether the engine is correctly built
(`CLAUDE.md` §3: *"The test of M2 is M4"*).

| Skill | Agent | Artifact kind | Phases | Writers | Publishes to |
|---|---|---|---|---|---|
| Generate PRD | Product Manager · Nick Fury | `document` | configure→generate→review→compare→adjudicate→publish | 3 | Confluence |
| Generate User Stories | Product Owner · Maria Hill | `structured_items` | configure→generate→review→adjudicate→publish | 3 | Jira |
| Generate HLD | Architect · Doctor Strange | `document` | configure→generate→review→compare→adjudicate→publish | 3 | Confluence |
| Generate LLD | Architect · Doctor Strange | `document` | configure→generate→review→compare→adjudicate→publish | 3 | Confluence |
| Implement Story | Developer · Spider-Man | `code_plan` | configure→generate→review→adjudicate→**execute**→publish | 3 | PR proposal |
| Review Pull Request | Developer · Spider-Man | `report` | configure→generate→publish | **1** | Confluence |

Adding the fourth, fifth and sixth skill touched **zero** engine code. That is the acceptance
test for the engine, and it is recorded in [PR-REVIEWS.md](PR-REVIEWS.md).

## 5. Personas

Four of the specification's eleven are exercised.

| # | Persona | Uses the PoC to | Gates owned |
|---|---|---|---|
| P1 | Product Manager | Produce a PRD and decompose it into stories | G3, G4, G5 |
| P3 | Architect | Produce an HLD and elaborate it to an LLD | G3, G4, G5 |
| P4 | Developer | Plan and implement a story, review the change | G2, G5 |
| P8 | Platform Engineer | Set budgets, read usage and cost, inspect config health | — |

## 6. Non-negotiables

Carried unchanged from the specification. A build that violates any of these is wrong regardless
of how well it works.

1. **AI proposes; a human approves every write.** No trusted fast path.
2. **No autonomous git.** A pull request is proposed, never opened silently. The SCM adapter has
   no push capability at all — not a disabled one, an absent one.
3. **No secrets, credentials, personal data, cardholder data or Restricted data** in prompts,
   logs, artifacts or telemetry. Redacted at the boundary, not downstream.
4. **Repository content, retrieved knowledge and model output are untrusted data**, never
   instructions.
5. **Every artifact carries provenance**: models, prompt versions and checksums, context
   sources, scores, approver, timestamps, resulting URL.
6. **No hard-coded model identifier** in application code. Logical name → registry → resolved.
7. **Never report a state you have not verified.** `not measured`, never `0/0`.
8. **Deployment and change execution are never reachable by an agent.**

## 7. Token budget and consumption controls

The unit of record is the **Copilot premium request** (AM-04 / DEC-19):
`premiumRequests = Σ over calls ( model.premiumRequestMultiplier )`. Because the request was
phrased as "token budget", raw tokens are metered and capped **in addition** — a superset of
either reading, and the honest one, since an inflated context is the other way to spend without
noticing.

| # | Enforcement point | Behaviour | Requirement |
|---|---|---|---|
| 1 | Config load | Five budget keys are **mandatory with no defaults**. The server refuses to start if any is unset, non-numeric or non-positive, or if the per-run cap exceeds the daily cap | `FR-ARCH-SYS-042`, `NFR-COST-002` |
| 2 | Pre-run (G1) | Live estimate from writer count × resolved-model multipliers × expected calls per phase, with the measured context size shown, as a **range** not a point | `FR-COST-001` |
| 3 | Run creation | Server-side block returning `402 budget_exceeded` and naming the limit and the remaining balance. The client cannot waive it | `FR-COST-002`, `FR-API-002` |
| 4 | Before every phase | Re-checked, because an estimate made before `generate` cannot know what `review` will cost. A run that would breach its cap stops, is marked degraded, and **keeps its settled candidates** | threat `T-05` |
| 5 | Warning threshold | Configurable percentage; a banner in the shell and the launcher disabled at exhaustion | DEC-19 |
| 6 | After the run | Per-writer, per-phase and per-model actuals, with actual-vs-estimate variance | `FR-COST-003/004` |
| 7 | Admin console | Read-only. Overview KPIs, runs ledger, context-strategy comparison, size bands, estimate calculator with multipliers rendered from the registry. **Every tab reconciles to one ledger total, and the reconciliation is displayed rather than asserted** | `FR-ADMIN-001…008` |

Why this is prominent rather than a footnote (`council-engine-spec` §9, `FR-COST-004`): the pilot
had **no cost surface at all**, yet token economics drove its single biggest design decision —
plan-first mode was chosen over execute mode specifically because it uses fewer tokens. *A
product whose main cost lever is invisible cannot be operated responsibly.*

## 8. Acceptance criteria

Twelve criteria, traced to the specification's sixteen (`01-product-requirements.md` §9). All
twelve pass; the mapping to named tests is in [USER-STORIES.md](USER-STORIES.md).

| # | Criterion | Traces to | Status |
|---|---|---|---|
| A1 | A 3-writer run produces 3 candidates on **3 distinct model families**, **exactly 9 reviews** with self-reviews flagged and excluded from the peer average, a Captain verdict with every suggestion attributed, and working section-level cherry-pick | AC 2 | ✅ |
| A2 | A duplicate model family is refused at configuration time, **naming both writers** | AC 2 | ✅ |
| A3 | Contested candidates — evaluator spread above 20 points — are visibly marked with the spread | engine AC 10 | ✅ |
| A4 | **No write occurs without a current, explicit, single-use approval** bound to the exact version and fingerprint, proven by test for every adapter | AC 3 | ✅ |
| A5 | A stale target voids the approval, checked at approval **and again before apply** | AC 5 | ✅ |
| A6 | A retried publication never creates a second page or issue; a partial failure retries **only** the failures | AC 5 | ✅ |
| A7 | **A document artifact cannot be published without complete section scores**, and the client cannot supply its own aggregate | AC 8 | ✅ |
| A8 | Unresolved placeholders block publication; the only resolution is a recorded human edit | engine AC 11 | ✅ |
| A9 | Test counters read **`not measured`**, never `0/0`; a secret finding blocks a PR proposal | engine AC 3, AC 6 | ✅ |
| A10 | **Cost guardrails**: pre-run estimate in premium requests, budgets enforced server-side, mandatory configuration, plan-first the only code mode | AC 11 | ✅ |
| A11 | The same engine runs a solo `report` skill with `review` and `adjudicate` omitted and **no engine code change** | engine AC 2 | ✅ |
| A12 | **Every skill is reachable from all three start modes, keyboard-only**, with write badges on every writing skill, AA contrast in both themes | AC 10, AC 15 | ✅ |

### Criteria deliberately not claimed

| Specification criterion | Why not |
|---|---|
| AC 1 — the full eleven-stage thread on one real epic | Needs the skills package. Six skills, four stages |
| AC 4 — no auto-approval, proven by inspection | Implemented and inspectable, but the absence of a Copilot CLI integration means there is no tool-approval surface to prove it against |
| AC 7 — prompt-injection defences tested against hostile content in a cloned repository and a retrieved knowledge document | Detection is implemented and tested on supplied input. There is no retrieval and no repository clone to plant hostile content in |
| AC 9 — every platform Must requirement maps to a passing verification | 28 named tests, not 413 requirements |
| AC 13 — run survives browser reload and server restart | Persistence and resume-by-sequence are implemented and the restart path is tested; a browser-reload test is not automated |
| AC 14 — skills-package conformance | No skills package |
| AC 16 — repository AI-readiness assessment | WP-16, out of scope |

## 9. What the PoC establishes, and what it does not

**It establishes** that the Council mechanism produces usable review signal: three writers with
genuinely different lenses disagree, the disagreement is measurable, a reviewer is directed to
the contested draft, and the cherry-pick decision is expressible as one choice rather than the
pilot's two competing radio groups. It establishes that the five gates are enforceable
server-side rather than as UI affordances, and that the cost of a council run can be estimated
before it starts and reconciled after it finishes.

**It does not establish** accuracy. The fixture transport makes no model calls, so every
accuracy figure the demo produces is a figure about a fixture. The ~70% the pilot measured came
substantially from domain knowledge bases that this PoC does not have (A-09). Accuracy is a
question for M3 with real models and real corpora, and the scorecard exists so that it can then
be measured rather than argued about.

## 10. Risks this PoC surfaces for R1

| Risk | Evidence from the build |
|---|---|
| **The target is the unit of approval, and getting it wrong breaks retry.** Bundling seven stories into one Jira target made a publish in which six issues were created report as a single failure | Found in testing, fixed as DV-11. R1 should treat one approvable item as one target from the start |
| **Provenance cannot be sealed at approval alone.** Publication facts arrive after the approval that authorised them | Found in testing. `FR-PROV-003` needs an explicit append-after-seal rule for publication fields, or every published artifact has an empty `publishedTo` |
| **The placeholder gate can dead-end a run** if there is no edit path | The specification has `FR-REVIEW-004`; it is easy to omit, and without it a blocked artifact cannot be published at all |
| **A solo skill must not be treated as a degraded council.** The quorum rule reads naturally as applying to any run with one candidate | Found in testing. `FR-COUNCIL-003` should state that it applies only where `review` is a declared phase |
| **Three distinct model families is a hard dependency, not a preference** | A-07 is unconfirmed here, and the council correctly refuses rather than substituting. This blocks M2 entirely, as the specification says |
