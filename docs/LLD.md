---
Written for: the engineers implementing, extending or porting the PoC.
---

# JARVIS proof of concept — low-level design

**Version** 1.0 · **Date** 2026-11-18
Elaborates [HLD.md](HLD.md). Assumes its component boundaries and does not revisit them.

---

## 1. Module decomposition and import rules

Enforced by `scripts/check-boundaries.js` in CI, not by good intentions
(`repo-scaffold.md` §4).

| Layer | May import | May **not** import |
|---|---|---|
| `server/config/**` | nothing in `server` | everything else |
| `server/persistence/**` | `persistence` only | `council`, `providers`, `integrations`, `api` |
| `server/security/**` | `persistence` | `council`, `providers`, `integrations`, `api` |
| `server/providers/**` | nothing in `server` | `council`, `integrations`, `persistence`, `api` |
| `server/council/**` | `persistence`, `security`, `providers` | `integrations` (publication goes through the API layer), `api` |
| `server/sandbox/**` | `security` | `council`, `integrations`, `providers` |
| `server/integrations/**` | `persistence` | `council`, `providers`, **other adapters** |
| `server/api/**` | everything in `server` | `web` |
| `web/components/**` | `lib/format`, `lib/a11y` | `features`, `lib/api` — components take props and emit callbacks; they do not fetch and do not read stores |
| `web/features/**` | `components`, `lib` | sibling `features/*` |

**The rule that matters most:** nothing under `server/council/` may branch on a skill
identifier. If a behaviour needs to differ per skill, it belongs in `config/`, or the engine
needs a new declarative capability.

---

## 2. Configuration

### 2.1 Load sequence

```
budget.json · models/registry.json · stages/stages.json · agents/agents.json
rubrics/rubrics.json · templates/templates.json · councils/{writers,captains}/*.json
skills/<agent>/*.json          (deterministic order: agent dir, then file name)
        │
        ├─ stripNotes()        remove `_`-prefixed documentation keys
        ├─ validateConfig()    collects EVERY problem, then throws once
        ├─ loadPrompt()        resolve each promptRef, record a content checksum
        └─ configHash          sha256 over the sorted merged object
```

`validateConfig` collects rather than fails fast, so one run fixes the whole file. The server
exits non-zero on `ConfigError`; there is no degraded-mode startup.

### 2.2 Validation rules that reject rather than warn

| Rule | Rejected because |
|---|---|
| Any of five budget keys null / non-numeric / ≤ 0 | A run would be uncapped |
| `perRunPremiumRequests > perUserDailyPremiumRequests` | A single run could never complete |
| `warnPercent` outside (0, 100) | Not a threshold |
| Two registry entries sharing a `displayName` | FR-MODEL-003: one canonical name per model |
| `status: deprecated` with no `replacedBy` | FR-MODEL-004 requires a named alternative |
| `requireDistinctModels !== true` where `writers.max > 1` | A council of identical families is a bug, not a configuration |
| Roster resolving to fewer distinct **families** than `writers.default` | The council could never start |
| `phases` includes `adjudicate` with no `captain` | No verdict is possible |
| `phases` includes `execute` with `artifactKind !== 'code_plan'` or `requiresSandbox !== true` | council-engine-spec §3 |
| `phases` not starting `configure` / ending `publish` / out of canonical order | Engine invariant |
| `promptRef` without an explicit `.vN.md` | Config references a version, never "latest" |
| A template with no scorable section where `requiresScorecard` | The G4 scorecard would have zero rows |
| A section with fewer than two `fixtureBullets` | Every writer would produce identical text and the council could not disagree |
| Duplicate IDs anywhere | Fatal |

### 2.3 Prompt versioning

Prompts are immutable versioned files with frontmatter (`id`, `version`, `artifactKinds`,
`channel`, `changelog`). The loader records `ref` **and a content checksum**; both land in every
provenance record, which is what proves which text produced an artifact. A published version is
never edited — bump instead.

---

## 3. Data model

### 3.1 Conventions

| Aspect | Rule |
|---|---|
| IDs | Opaque, type-prefixed, time-ordered: `run_`, `cand_`, `rev_`, `verd_`, `sug_`, `dec_`, `exec_`, `sc_`, `prop_`, `appr_`, `pres_`, `prov_`, `aud_`. Clients must not parse them |
| Timestamps | UTC ISO-8601 with milliseconds, one format everywhere |
| Amounts | Integer minor units with explicit currency. Never a float |
| JSON columns | `camelCase` inside; `snake_case` column names |
| Casing | `camelCase` on the wire, `snake_case` in SQL |

### 3.2 Tables

`runs` · `candidates` · `candidate_placeholders` · `candidate_citations` · `reviews` ·
`verdicts` · `suggestions` · `human_decisions` · `executions` · `file_changes` · `scorecards` ·
`section_scores` · `proposals` · `approval_decisions` · `publish_results` ·
`provenance_records` · `run_events` · `cost_records` · `audit_events` · three `mock_*` stores.

### 3.3 Constraints that carry a requirement

| Constraint | Requirement |
|---|---|
| `suggestions.source_candidate_id NOT NULL` | FR-ADJ-002 — an unattributed suggestion **cannot be stored** |
| `reviews UNIQUE (run_id, evaluator_profile_id, candidate_id)` | FR-REV-001 — N² with no double-counting |
| `UNIQUE INDEX approval_decisions (proposal_id, proposal_version) WHERE consumed_at IS NULL AND decision='approve'` | FR-API-042 — at most one live unconsumed approval per version |
| `UNIQUE INDEX publish_results (idempotency_key) WHERE ok = 1` | FR-API-052 — a successful write cannot be recorded twice |
| `section_scores` nullable score columns | FR-SCORE-006 — unscored means NULL, so "scored" is not confusable with "scored zero" |
| `executions.tests_* ` nullable + `tests_measured` flag | FR-EXE-003 — "not measured" is representable and is the default |
| Triggers on `run_events` (no update, no delete) | FR-EVT-003 — append-only, enforced by the database |
| Trigger on `reviews` (no update) | A correction is a new run, not an edited score |
| Trigger on `approval_decisions` (only `consumed_at` may change) | An approval is a fact |

---

## 4. The engine

### 4.1 Phase driver

```js
start(runId):
  transition → generating
  guardPhase('generate')                  // budget re-check
  settled = runGenerate()                 // concurrent, bounded at 5
  q = quorumDecision(settled.length, phases)
  if !q.proceed → degrade, emit, stop at awaiting_human (or failed)
  if phases ⊇ review     → guard, transition, runReview()        // N²
  if phases ⊇ adjudicate → guard, transition, runAdjudicate()
  scoreQuality()                          // advisory, DEC-27
  if phases ⊇ adjudicate → awaiting_human // a decision exists
  else                   → scoring | approved   // solo: nothing to decide
```

Every phase is preceded by `guardPhase`, because an estimate made before `generate` cannot know
what `review` will cost.

### 4.2 State machine

States: `created → queued → generating → reviewing → adjudicating → awaiting_human →
synthesizing → executing → scoring → approved → published`, plus `cancelled` and `failed`.
`failed` may transition back to a phase state, which is how resume works.

`generating → scoring | approved` is legal specifically for the solo-report path.

### 4.3 Guards

| ID | Guard | Implementation |
|---|---|---|
| FR-COUNCIL-001 | Persist after every transition and settlement | `updateRun` + `appendEvent` in one method |
| FR-COUNCIL-002 | One writer's failure aborts no other | `runBounded` catches per task and yields `null` |
| FR-COUNCIL-003 | Quorum ≥ 2 to enter `reviewing` — **only where `review` is declared** | `quorumDecision(settled, phases)` returns `solo` early |
| FR-COUNCIL-004 | Distinct **families** (AM-01), naming both writers | `checkDistinctFamilies` at config load and at run creation |
| FR-COUNCIL-005 | Cancel in any non-terminal state; partials inspectable and marked | `canCancel` + `finishCancelled` |
| FR-COUNCIL-007 | `executing` exactly once | `hasExecution(runId)` → `409 invalid_state` |
| FR-COUNCIL-008 | Never leave `awaiting_human` without an actor | `insertHumanDecision` throws without one; the route records before the engine runs |
| FR-COUNCIL-009 | Degradation is never silent | Every degrade path emits `run.degraded` **and** sets `degradedReason` |

### 4.4 Review aggregation

```
peerAverage        = mean(scores where !isSelf)
selfScore          = the one review where isSelf
selfBias           = selfScore − peerAverage          ← shown, so the exclusion is visible
scoreSpread        = max(all scores) − min(all scores)   ← includes self: that IS disagreement
contested          = scoreSpread > 20                     (FR-REV-006)
consensus          = items raised by ≥ 2 distinct evaluators, grouped by normalised phrasing
criterionAverages  = per-criterion mean across peers only
```

Consensus grouping normalises to lowercase, strips punctuation and keeps the first six words
longer than three characters, so two evaluators phrasing the same concern differently still
surface as consensus. Without that, FR-REV-005 almost never fires.

### 4.5 Cost model

```
plannedCalls(phases, N) = { generate: N, review: N², adjudicate: 1 }

premiumRequests = Σ over calls ( resolvedModel.premiumRequestMultiplier )
tokens          = Σ ( contextTokens + draftTokens per call )
contextTokens   = ceil(len(JSON(inputs)) / 3.9) + 1200     // + system/policy/template channels
range           = [ premiumRequests × 0.85 , premiumRequests × 1.3 ]
```

N writers cost N calls to generate but **N² to review**, which is why a 5-writer council is 25
reviews and not 5. The model is written out explicitly rather than buried, because it is the
whole cost story.

Blocking order: per-run premium requests → per-run tokens → daily premium requests → daily
tokens. First breach wins and names its own limit.

---

## 5. Interfaces

### 5.1 `Transport`

Both implementations expose exactly this. Nothing else in the codebase knows a provider exists.

```ts
plannedSteps({ artifactKind, inputs }): string[]
generate({ template, writerProfile, resolved, inputs, context, artifactKind, seedSalt,
           policyText, promptText }): { body, sections, placeholders, citations,
                                        wordCount, usage }
review({ rubric, evaluatorProfile, evaluatorResolved, candidate, isSelf, ... })
       : { overallScore, criterionScores, strengths, concerns, feedback, usage }
adjudicate({ candidates, aggregates, captainProfile, captainResolved, captainMode,
             maxSuggestions, ... })
       : { winnerCandidateId, rationale, fullAnalysis, suggestions[], usage }
synthesise({ base, suggestions, candidates, captainResolved, template, ... })
       : { body, sections, applied[], wordCount, usage }

usage = { inputTokens, outputTokens, calls, premiumRequests }
```

Placeholders returned by a transport are **ignored**; the engine re-scans deterministically. A
model's self-report of its own gaps is not evidence.

### 5.2 `PublishTarget`

```ts
describe(target)  → what a human sees at G5: system, destination, operation, title, ownership
anchor(target)    → the stale-check anchor, re-verified at approval AND before apply
validate(target)  → finding[] { code, message, blocking }
apply(target, { body, actor, approvalId })
                  → { ok, externalId, externalUrl, items?, partial?, errorCode?, errorMessage? }
```

`apply` throws `WriteNotApproved` without an `approvalId`, independently of the route's check —
a single check is a single point of failure.

**The SCM adapter exposes these four methods and nothing else.** There is no push, commit,
merge, approve or delete-branch function, and one must never be added: `AD-GIT` requires the
absence of the capability, not its restriction.

### 5.3 Event union

```ts
run.created | run.phase | run.degraded | run.failed | run.cancelled
writer.started | writer.step | writer.settled | writer.failed
review.started | review.recorded | review.failed | review.complete
verdict.ready | verdict.failed | readjudicate.requested
human.decision | synthesis.complete | candidate.edited
exec.step | exec.file | exec.complete | exec.blocked
quality.scored | score.section | score.complete
proposal.created | approval.recorded | publish.result
```

`appendEvent` **throws** on `writer.token` (FR-EVT-004). No event carries a secret: payloads are
built from already-redacted values.

### 5.4 SSE protocol

```
GET /api/stream
  → 200 text/event-stream, no-store, x-accel-buffering: no
  → event: stream.ready   data: { seq, replayedFrom }      ← always first
  → id: <seq>  event: <type>  data: { runId, ...payload, at }
  → ': heartbeat'                                          ← every 15 s

Reconnect: the browser sends Last-Event-ID automatically from the `id:` field.
The server replays every event with a greater seq, in order, marked `replayed: true`,
then resumes live. No duplication, no gaps.
```

The client tracks `lastSeq` and folds events into a projection, so reconnect-and-replay needs no
special handling — the same reducer runs over replayed and live events.

### 5.5 HTTP surface

| Method | Path | Gate |
|---|---|---|
| GET | `/api/v1/bootstrap` · `/catalogue` · `/catalogue/skills/:id` · `/catalogue/search` · `/artifacts` | |
| POST | `/api/v1/runs/estimate` | **G1** |
| POST | `/api/v1/runs` | **G1** (server-side budget decision) |
| GET | `/api/v1/runs` · `/runs/:id` · `/runs/:id/events` | |
| POST | `/api/v1/runs/:id/cancel` | |
| POST | `/api/v1/runs/:id/decision` | **G2 / G3** |
| POST | `/api/v1/candidates/:id/edit` | |
| GET / PUT / POST | `/runs/:id/scorecard` · `/scorecards/:id/sections/:sid` · `/scorecards/:id/complete` | **G4** |
| POST | `/runs/:id/proposals` · `/proposals/:id/{approve,reject,revalidate,publish}` | **G5** |
| GET | `/runs/:id/provenance` · `/budget` · `/admin/{usage,runs}` · `/audit` · `/sor/*` · `/health` | |
| POST | `/admin/estimate` | |

Error envelope, on every non-2xx without exception:

```json
{ "error": { "code": "...", "message": "cause AND next action",
             "requirementId": "FR-...", "retryable": false,
             "detail": { }, "correlationId": "cor_..." } }
```

---

## 6. Gate implementations

### 6.1 G4 — scorecard

Rows are generated from the template version's **scorable** sections. `effortSavedPercent` and
every aggregate are computed server-side; a request containing one is rejected (FR-API-030).
Aggregate saving is computed from the **totals**, not as a mean of per-row percentages —
averaging percentages would let a half-hour section outweigh a six-hour one. `reworkHours >
manualEffortHours` is rejected: that is a negative saving and probably a transposition. A
complete scorecard is immutable; a correction creates a new one.

### 6.2 G5 — approval

```
fingerprint = sha256( { operation, targets, candidateBody } )
```

It covers everything the human sees. Editing the candidate after approval changes it, so the
stored approval no longer matches and publication is refused.

```
approve:  version match → fingerprint match → anchor re-verified → pre-flight all pass
          → insert approval (single live one enforced by a partial unique index)
          → seal provenance

publish:  approval exists, belongs to this proposal, is an approve, is UNCONSUMED,
          fingerprint still matches → anchor re-verified AGAIN → per target:
            idempotency key → stored success? return it, make no call
                            → else adapter.apply(...)
          → consume the approval (on attempt, not on success)
          → all ok? 200 + seal publication facts : 207 + retryable[]
```

The approval is consumed on **attempt**, not on success. Consuming only on success would leave a
reusable token after a failed publish.

### 6.3 Provenance immutability

Sealed on approval. Publication facts (`publishedTo`, `approvedBy`, `approvedAt`) remain
appendable **once** afterwards, and only where currently empty — because an external ID does not
exist until after the approval that authorised the write. Sealing them out would leave every
published artifact with an empty `publishedTo`, which is the opposite of provenance.

---

## 7. Sandbox

```
lease()   → mkdtemp + recursive copy of sample-repo       (no credentials passed)
apply     → deterministic edits, EVERY write via resolveWithin(workspace, path)
diff      → line-set difference per file, add/modify status
scan      → scanForSecrets(files); a finding BLOCKS the proposal
tests     → { measured: false, reason }                    ← no JVM; FR-EXE-003
destroy() → rmSync recursive, in a finally block
```

No network call is made, no repository is initialised, nothing is committed. `git` is never
invoked — the capability is absent.

---

## 8. Client

### 8.1 Projection

`createProjection()` / `applyEvent(p, ev)` folds the event stream into live per-writer state.
Steps are updated in place and never reordered, so settled content never reflows.

`statusLabel(run)` is the **single** place a client-side status string is produced. It switches
on `run.state` alone. There is no second code path that could disagree, which is what makes
FR-HUM-006 structural rather than a convention.

### 8.2 Rendering

`h(tag, props, ...children)` builds DOM and **discards `null` / `undefined` / `false` children**.
`mount(parent, ...children)` does the same for direct appends — the DOM's own `append`
stringifies a falsy value, so `parent.append(cond && node)` renders the literal text `false`.
Every append in the client goes through `mount`.

`renderMarkdown` escapes **first**, then introduces a fixed tag set. Model output is untrusted
data and cannot inject markup. Unresolved placeholders are wrapped in a marked span, so
FR-GEN-005 is visible in the prose as well as in the banner.

### 8.3 Tokens

`web/styles/tokens.css` is the only file containing a literal hex, px or ms value, and
`scripts/check-nonnegotiables.js` fails the build if one appears elsewhere. In R1 this file is
generated from the Figma export; it is hand-written here from the published token table with the
same names, so the generator can replace it unchanged.

---

## 9. Test design

| Level | Scope | Determinism |
|---|---|---|
| Named requirement tests | `tests/run-tests.js`, `node:test`. One test per requirement, named for it | Fully deterministic; the fixture transport is seeded |
| API smoke | `tests/smoke.js`, `smoke2.js`. Drive all four artifact kinds over real HTTP | Deterministic |
| UI driver | `tests/ui-check.js`. Drives Edge over the DevTools Protocol, walks all five gates, **fails on any console error or failed request** | Deterministic |
| Mechanical checks | `check-boundaries.js`, `check-nonnegotiables.js` | Static |

Negative tests are first class: a blocked write is as important to prove as a successful one.
There is no live-model test on the default path — live calls are non-deterministic and cost
money, so they cannot gate a change (`repo-scaffold.md` §10 step 13).
