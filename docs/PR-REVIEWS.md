---
Written for: the engineering lead and the architects reviewing how the PoC was built, and the
R1 team inheriting its findings.
---

# JARVIS proof of concept — PR reviews

One review per story, in the order the stories were built. Each follows the specification's own
CI gate order (`repo-scaffold.md` §10): **boundaries → non-negotiables → requirement-to-test
mapping → findings → disposition**.

Two of those gates are **mechanised** rather than asserted, which is the point of them:
`scripts/check-boundaries.js` and `scripts/check-nonnegotiables.js`. A rule enforced only by
review discipline is a rule that gets broken again.

**Seventeen defects were found and fixed during the build.** Five of them are findings about the
*specification*, not just about this code, and are carried into [PRD.md](PRD.md) §10 as risks
for R1. They are marked **↑R1** below.

---

## Review summary

| Story | Boundaries | Non-negotiables | Tests | Findings | Disposition |
|---|---|---|---|---|---|
| JP-01 Config refuses unsafe start | ok | ok | 4 | **F-01** BOM breaks parse | Merged after fix |
| JP-02 Durable runs, event log | ok | ok | 4 | — | Merged |
| JP-03 API spine | ok | ok | 3 | **F-02** `Host` header untestable via `fetch` | Merged after fix |
| JP-04 Event stream | ok | ok | 2 | — | Merged |
| JP-05 Provider abstraction | ok | ok | 3 | — | Merged |
| JP-06 Run lifecycle, quorum | ok | ok | 4 | **F-03 ↑R1** solo run treated as degraded · **F-04** no-op ternary | Merged after fix |
| JP-07 Cost and budget | ok | ok | 6 | **F-05** invalid SQL in `bySkill` | Merged after fix |
| JP-08 Generate phase | ok | ok | 2 | **F-06 ↑R1** placeholder block dead-ends | Merged after fix |
| JP-09 N² review, contested | ok | ok | 4 | **F-07** contested never fired · **F-08** consensus never fired | Merged after fix |
| JP-10 Verdict, cherry-pick | ok | ok | 3 | — | Merged |
| JP-11 Shell, start modes, tokens | ok | ok | 3 | **F-09** ×2 paren imbalance · **F-10** `rgba()` outside tokens | Merged after fix |
| JP-12 Council modal | ok | ok | 2 | **F-11** falsy children render as text · **F-12** suggestion markdown raw | Merged after fix |
| JP-13 G4 scorecard | ok | ok | 4 | **F-13** passing checks showed failure text | Merged after fix |
| JP-14 G5 approval, publication | ok | ok | 8 | **F-14 ↑R1** target/item conflation · **F-15 ↑R1** provenance seal · **F-16 ↑R1** stale check not per target | Merged after fix |
| JP-15 Sandbox, diff, PR proposal | ok | ok | 5 | — | Merged |
| JP-16 Solo path, provenance, admin | ok | ok | 4 | **F-17** fixture seeded on run ID | Merged after fix |

Final state: **47 of 47 named tests pass · 8 boundaries clean · 10 non-negotiable checks pass ·
UI driver runs clean with zero console errors.**

---

## The engine test

Before any story review, the architectural claim that matters most
(`CLAUDE.md` §3: *"The test of M2 is M4"*):

> **Adding the fourth, fifth and sixth skill — including a new artifact kind (`report`), a new
> phase order (`code_plan`, which adjudicates before executing) and a solo writer — required
> ZERO changes under `server/council/`.** Only `config/` changed.

Verified by inspection of the change sets and enforced thereafter by
`check-nonnegotiables.js` check 5, which fails the build if engine code ever names a skill.
This is the single strongest evidence that the one-engine decision (AD-COUNCIL) holds.

---

## JP-01 — Configuration refuses to run unsafely

**Boundaries** `server/config/**` imports nothing else in `server`. ok
**Non-negotiables** no model identifier; no budget default in code. ok
**Tests** `config.budget.missingKeyRefusesStart`, `config.rejectsIndistinctCouncil`,
`config.rejectsDuplicateDisplayName`, `config.rejectsAdjudicateWithoutCaptain`

### F-01 — A UTF-8 BOM breaks configuration parsing
**Severity** MEDIUM · **Found by** the negative test for a null budget key

Writing the test fixture with PowerShell's `Set-Content -Encoding utf8` added a BOM, and
`JSON.parse` rejected the file with an opaque `Unexpected token`. Configuration files are
hand-edited, and Notepad, VS Code's "UTF-8 with BOM" and PowerShell all add one.

Worth noting *how* this surfaced: a test written to prove the validator **rejects** something
found a bug in the **loader**. A test that only proved the happy path would have shipped it.

**Fix** `loader.js` strips a leading BOM before parsing, with a comment explaining why
tolerating it is correctness rather than laxity.

---

## JP-03 — API spine

### F-02 — The loopback `Host` check could not be tested through `fetch`
**Severity** LOW (test-only) · **Found by** `api.rejectsNonLoopbackHost` returning 200

`Host` is a forbidden header: `fetch` silently refuses to override it, so the test was asserting
nothing. The control itself was correct.

**Fix** the test opens a raw socket via `node:net` and writes the request line directly. The
control matters — it is what stops a single-user local tool becoming a network service by DNS
rebinding — so a test that cannot actually exercise it is worse than no test.

---

## JP-06 — Run lifecycle and quorum

### F-03 ↑R1 — A solo skill was treated as a degraded council
**Severity** HIGH · **Found by** `review-pull-request` ending in `awaiting_human`

`FR-COUNCIL-003` says a quorum of ≥2 settled candidates is required, and that with one
candidate the run skips review and is marked **degraded**. Read literally — as I had
implemented it — that applies to a skill *configured* `writers: 1`, so every `report` run was
labelled degraded and parked at a human gate with no decision to present. A dead end.

The specification's intent is elsewhere: §3 calls the solo case *"the same engine with phases
omitted — not a separate code path"*. The quorum rule describes a **council that lost writers**,
not a skill that never had any.

**Fix** `quorumDecision` returns early when `review` is not a declared phase, and the state
machine permits `generating → scoring|approved` for that path.

**↑R1** `FR-COUNCIL-003` should state explicitly that it applies only where `review` is
declared. This is an easy and consequential misreading.

### F-04 — A no-op ternary left the solo path unreachable
**Severity** MEDIUM · **Found by** code reading during the F-03 fix

```js
const next = skill.council.phases.includes('adjudicate') ? 'awaiting_human' : 'awaiting_human';
```

Both branches identical — a leftover from an earlier edit that silently removed the distinction
it was meant to express.

**Fix** replaced with an explicit branch. A second instance of the same pattern was later found
in the pre-flight checks (**F-13**), which suggests it is worth grepping for as a class.

---

## JP-07 — Cost and budget

### F-05 — Invalid SQL in the `bySkill` ledger grouping
**Severity** MEDIUM · **Found by** reading the code immediately after writing it

The date predicate was being re-qualified by string replacement:

```js
where.map((x) => 'c.' + x.replace('created_at', 'created_at'))   // → "c.substr(created_at,...)"
```

producing `c.substr(...)`, which is not valid SQL. It would have thrown the first time the admin
console was opened with a date range.

**Fix** qualify the column inside the predicate (`x.replace('created_at', 'c.created_at')`)
rather than prefixing the whole expression.

**Comment** this is the kind of defect that only string-built SQL produces. The remaining
queries use fixed predicates with bound parameters.

---

## JP-08 — Generate phase

### F-06 ↑R1 — The placeholder gate dead-ended the run
**Severity** HIGH · **Found by** the smoke test, when a run reached G5 and could go no further

`FR-GEN-005` correctly blocked publication of a candidate carrying
`TBD [UNKNOWN — requires user input]`. But there was no way to *resolve* it: the artifact was
unpublishable and the run was stuck. The only exits were to regenerate and hope, or to abandon
the run.

The specification does have the answer — `FR-REVIEW-004`, a human revision recorded as a new
candidate with `derivedFrom` — but it is easy to omit, and without it the gate is a wall rather
than a gate.

**Fix** implemented `POST /candidates/:id/edit`: it creates a new candidate with
`origin: 'human_edit'` and `derivedFrom` set, re-segments against the template, **re-scans**
placeholders rather than inheriting the old count, records the edit in provenance, and never
mutates the original. `pickFinalCandidate` now prefers a human edit over the synthesis it
derives from.

**↑R1** a blocking content gate needs its resolution path specified alongside it. Worth an
explicit cross-reference from `FR-GEN-005` to `FR-REVIEW-004`.

---

## JP-09 — N² review, self-review bias, contested marking

### F-07 — Contested marking never fired
**Severity** HIGH (for the product's purpose) · **Found by** the smoke test printing every spread

Spreads were 4, 19 and 16 points against a threshold of >20. The mechanism was correct and
untriggered — which for this particular feature is close to useless. `FR-REV-006` is the
specification's *single most direct mitigation* of the rubber-stamp risk (BRISK-009): it is what
tells the reviewer where to look. A council that never surfaces disagreement hides the
mechanism it exists to demonstrate.

Diagnosis: the evaluator lenses differed only in *strength*, not in *direction*. All three
rewarded the same properties by slightly different amounts, so their scores clustered.

**Fix** the lenses now act on the same measurable property in **opposing directions** —
`rigorous` reads length as imprecision and marks it down; `expansive` reads it as thoroughness
and marks it up. That is also how real reviewers with different priorities actually disagree.
A 3-writer run now reliably produces a contested candidate.

The current demo output illustrates the point better than the fix does:

```
PM Writer 3   Gemini 3 Pro   peer 77.5   self 98   bias +20.5   spread 21  CONTESTED 77–98
```

The contested flag is driven by a **+20.5-point self-bias** — the author rating its own draft
20 points above its peers. That is precisely the bias AM-09 excludes from the average, visible
in one line.

**Separately:** the test for this was rewritten. Asserting that a fixture *happens* to produce a
contested candidate is a flaky test about the fixture's mood. The rule is now tested directly
against synthetic reviews — including that exactly 20 is **not** contested, that 21 is, and that
a self-score far above the peers counts toward the spread while still being excluded from the
average. The end-to-end test asserts only that the flag and the spread are consistent.

### F-08 — Consensus extraction almost never fired
**Severity** MEDIUM · **Found during** the F-07 work

`FR-REV-005` promotes a strength or concern raised by ≥2 evaluators. Matching on exact strings
meant two evaluators phrasing the same concern differently never surfaced — so the panel that
carries *"the signal reviewers act on"* was usually empty.

**Fix** grouping normalises to lowercase, strips punctuation, and keys on the first six words
longer than three characters.

---

## JP-11 — Shell, start modes, design tokens

### F-09 — Two paren imbalances in `admin.js` (×2 occurrences)
**Severity** HIGH (blank page) · **Found by** `node --check` after the browser showed a blank page

Deeply nested `h(...)` calls — eight levels in the model registry table — lost a closing paren.
The whole SPA failed to parse, so the page rendered as an empty dark canvas with no console
output visible without instrumenting the browser.

**Fix** both repaired; `openHistory` was additionally **restructured** to build its table rows
into intermediate variables rather than nesting. Counting parens across eight levels is not a
reviewable practice, and the second occurrence proved the first was not bad luck.

**Process change** `node --check` across every `.js` file is now the first verification step.
A syntax error in a module with no build step is invisible until runtime.

### F-10 — A literal `rgba()` outside `tokens.css`
**Severity** LOW · **Found by** `check-nonnegotiables.js` check 2

The modal scrim was `rgba(7,9,13,.72)` inline. Small, but the design-system contract is that
`tokens.css` is the only file with literal values, and an exception erodes the check's meaning.

**Fix** added `--bg-scrim` to the token set.

---

## JP-12 — The Council modal

### F-11 — Falsy children rendered as the literal text "null" / "false"
**Severity** MEDIUM · **Found by** reading a screenshot of the landing page and the modal footer

`parent.append(cond && node)` stringifies `false` when `cond` is false. The landing page showed
a stray `null` below the lifecycle caption; the council modal footer showed `false`. `h()` and
`frag()` already filtered falsy children; direct `.append()` calls did not.

This is exactly the class of defect design-system §1.3 is about — *state is always honest* — and
it is invisible in code review because the expression looks idiomatic.

**Fix** added `mount(parent, ...children)` which routes through `frag()`, and converted **all 60
direct appends** across the client to it. Fixing the five visible instances would have left the
next one to be found by a reader of a screenshot.

### F-12 — Suggestion text rendered raw markdown
**Severity** LOW · **Found by** screenshot

Captain suggestions displayed `**Problem Statement**` with literal asterisks, because the text
was set via `textContent`.

**Fix** routed through the same escape-first `renderMarkdown` path as every other piece of model
output — not a bypass, since model output remains untrusted data.

---

## JP-13 — G4 scorecard

### F-13 — Passing pre-flight checks displayed the failure message
**Severity** MEDIUM · **Found by** the UI driver printing the pre-flight list

```
✓ Budget available — Daily budget is exhausted.          passed
✓ Base version current — The target changed since…       passed
```

Caused by the same no-op-ternary pattern as **F-04**:
`message: c.pass ? c.message : c.message`.

A passing check that displays the failure text is worse than no text: it reads as a
contradiction, and a reviewer who notices it stops trusting the whole panel. That is the pilot's
`Tests: 0/0` defect in a different costume.

**Fix** each check now carries both `passMessage` and `failMessage`, and the route selects.
Passing checks now say useful things — `385 premium requests remain today`.

---

## JP-14 — G5 approval and publication

Three findings here, all of the same shape, and all **↑R1**: *the unit of approval must be the
unit of idempotency, of reporting, and of retry.* Getting that wrong does not produce a visible
error — it produces a control that silently cannot do its job.

### F-14 ↑R1 — Target/item conflation broke per-item retry
**Severity** HIGH · **Found by** smoke test 2: `207 {total:1, succeeded:0, failed:1}` **while six
Jira issues had actually been created**

Seven user stories were bundled into one `jira_issue` target holding seven items. The adapter
returned `ok: false` because one item failed, so:

- the publish reported **one failure** and **zero successes**, while six issues existed;
- `retryable` named target 0, so retrying would re-attempt **all seven** — creating six
  duplicates, the precise outcome `FR-PUBLISH-003` exists to prevent;
- the per-item outcomes were not surfaced at all, because `latestResults` works per target.

**Fix** `buildTargets` emits **one target per issue**. Partial failure now reports
`{total: 7, succeeded: 6, failed: 1}` with `retryable: [2]`, and the retry creates nothing new.

**↑R1** the target is the unit of idempotency, approval and retry, so it must also be the unit a
human thinks about. R1 should model one approvable item as one target from the start.

### F-15 ↑R1 — Sealing provenance at approval left every artifact with an empty `publishedTo`
**Severity** HIGH · **Found by** the smoke test printing `publishedTo: []` for a published run

`FR-PROV-003` makes provenance immutable on approval. Implemented literally, the seal blocked
the publication facts — external ID and URL — which do not *exist* until after the approval that
authorised the write. Every published artifact therefore recorded no publication.

**Fix** the seal freezes how the artifact was **produced and decided**; `publishedTo`,
`approvedBy` and `approvedAt` remain appendable once afterwards, and only where currently empty.
Nothing already written is ever overwritten.

**↑R1** `FR-PROV-003` needs an explicit append-after-seal rule for publication fields, or every
implementation will hit this.

### F-16 ↑R1 — The stale check was per proposal, not per target — a live-lock
**Severity** HIGH · **Found by** `publish.partialFailure.retriesOnlyFailed` failing at its
*second* approval, with `409 approval_stale`

Two layered defects:

1. The Jira anchor was a **project-wide issue count**, so publishing anything to the project
   invalidated every other open proposal's approval.
2. More fundamentally, the anchor was computed over **all targets joined into one string**. So
   after a partial publish created five of six issues, those five anchors legitimately changed —
   *because they had been applied* — and that voided the very approval needed to retry the sixth.

**The successes blocked the retry.** The control intended to protect the reviewer made recovery
impossible, and it failed closed in a way no amount of retrying could clear.

**Fix**
- the Jira anchor now keys on whether an issue with **this summary** already exists, so
  unrelated project activity is not staleness;
- `staleCheckAnchor` is stored **per target** as an array;
- `staleTargetIndexes(proposal, only)` compares per target and **excludes targets already
  successfully applied** — their anchor changing is the expected consequence of applying them,
  not evidence of interference — and scopes the comparison to the targets a retry actually names;
- the error now names which targets are stale.

**↑R1** `RCR-STALE-001` reads naturally as a property of a proposal. It is a property of a
**target**. R1 should specify it per target and state that applied targets are excluded.

---

## JP-16 — Solo path, provenance, admin console

### F-17 — The "deterministic" fixture was not deterministic
**Severity** HIGH (for testability) · **Found by** three tests failing intermittently with
different failures on each run

The fixture seeded its PRNG on `run.id`, which is time-based. So identical inputs produced a
different council every time: the demo was not repeatable, and any test asserting on council
output was flaky. "Deterministic transport" was a claim the code did not honour.

**Fix** the seed is a hash of **skill id + inputs**. Identical requests now produce identical
drafts, scores, verdicts and contested candidates. Different inputs still produce a different
council.

**Comment** this is why the three flaky tests were worth chasing rather than retrying. The
flakiness was not test noise; it was the transport failing its own contract.

---

## Cross-cutting observations

**1. Negative tests found more than positive ones.** F-01 was found by a test written to prove a
*rejection*. F-06, F-14 and F-16 were found by exercising failure and recovery paths. Every
control in this product is a refusal, so the refusals are where the defects live.

**2. Two defects were found by reading a screenshot** (F-11, F-12) and one by reading the UI
driver's own output (F-13). None would have been caught by a passing functional test — they were
all cases of the interface *saying* something untrue while *doing* the right thing. That is the
pilot's characteristic defect, and it argues for the UI driver asserting on rendered text rather
than only on behaviour.

**3. The same bug shape recurred three times** (F-14, F-15, F-16): a control modelled at the
wrong granularity. Each time the code ran without error and the control silently did not work.
These are the findings most worth carrying into R1, because they are invisible to testing that
only checks the happy path.

**4. A no-op ternary appeared twice** (F-04, F-13), both times silently removing a distinction
the code was meant to express. Worth a lint rule.

**5. Mechanising the non-negotiables paid for itself immediately** — F-10 was found by check 2
the first time it ran, and the checks themselves needed two false-positive fixes
(`registry.resolve` matching a path-resolution pattern, `array.push` matching a git-write
pattern) before they were trustworthy. A check that cries wolf gets ignored, so tightening them
was part of the work, not overhead.

---

## Definition of done — final state

Per `CLAUDE.md` §8, a story is done when it is implemented, tested at the required level,
accessible, its requirement IDs map to passing tests, and it introduces no new hard-coded model
ID, hard-coded token value, or ungated write.

```
node scripts/config-validate.js        Configuration valid
node scripts/check-boundaries.js       8 boundaries clean
node scripts/check-nonnegotiables.js   10 checks passed
node --test tests/run-tests.js         pass 47 · fail 0
node tests/ui-check.js data/ui         all five gates walked · zero console errors
```

All sixteen stories merged. All seventeen findings resolved. Five carried to
[PRD.md](PRD.md) §10 as R1 risks.
