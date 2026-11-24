---
Written for: whoever is presenting the PoC, and anyone exploring it unaccompanied.
---

# JARVIS proof of concept — demonstration walk-through

Twelve steps, about **15 minutes**. Every step costs nothing and is repeatable: the default
transport makes no model calls, and identical inputs produce an identical council.

```powershell
cd C:\Users\E180113\jarvis-poc
.\start.ps1
```

Open **http://127.0.0.1:7701**.

> **The point of the demo.** Not that an AI can write a document — that is not in doubt. The
> point is that **reviewing AI output is harder than producing it, and people rubber-stamp what
> they cannot evaluate** (`CLAUDE.md` §9). Every unusual thing you are about to see exists to
> fix that. If you only remember one screen, make it step 5.

---

## 1 · Landing — orientation, and what was deliberately removed

Three things worth pointing at:

- **The 11-stage rail** along the bottom, all stages visible, none clipped. The pilot truncated
  its final chip at every width (`FR-NAV-008`).
- **The 7-chip lifecycle row** is captioned *"Lifecycle overview — see the stage rail for the 11
  delivery stages"* and is **not clickable**. The pilot had three competing stage models; the
  11 config stages are canonical and this row is explicitly a summary.
- **There is no chat box.** Across 33 minutes of pilot demo nobody typed into one. It also
  defeats the input contract — free text arriving outside a declared schema cannot be validated,
  costed, or recorded as typed provenance — and a composer with no declared destination is an
  injection surface.

Top-left shows today's budget: `0 / 400 premium requests`. Keep an eye on it.

## 2 · Three ways to start

Click through **Agent mode → Action mode → Workflow mode**.

- **Agent mode** — three agent cards. Each shows the professional **role** first and the alias
  second (`Architect · Doctor Strange`); an alias never appears alone. Every card uses the
  *identical* manifest shape — `2 skills across 1 sub-agent` — because the pilot mixed inline
  skill lists with counts that did not reconcile.
- **Action mode** — type `pull request`. Note the **write badge**:
  `⤴ Writes to Bitbucket · approval required`. Icon **and** text, never colour alone. Press `/`
  to focus the search from anywhere.
- **Workflow mode** — the 11 stages as cards. Seven are greyed with *"Available in a later
  release"* rather than hidden, so the shape of the full product is visible.

## 3 · Gate G1 — inputs and cost

**Agent mode → Product → Generate PRD.**

The form is rendered **entirely from the skill's declared input schema** — there is no per-skill
form code. Fill in:

| Field | Value |
|---|---|
| Idea Source | `Cryptographic cart-hash assurance for agentic intent flows` |
| Supporting Material | `Merchants report disputes where the agent-submitted cart cannot be proven unchanged at authorisation.` |
| Epic URL | `MCSE-731` |

Watch the **cost estimate** update as you type:

```
11.48–17.55 premium requests · 78,628 tokens · 3 writers · 13 model calls
Calls by phase: generate 3×, review 9×, adjudicate 1×
Budget remaining today: 400 / 400 premium requests
```

Two things to say here. First, **three writers cost three calls to generate but nine to
review** — that is the whole cost model, and it is why a five-writer council is twenty-five
reviews, not five. Second, the pilot had **no cost surface at all**, yet token economics drove
its single biggest design decision. A product whose main cost lever is invisible cannot be
operated responsibly.

Expand **Context and prompt** and point at the amber banner: *no knowledge base is attached*.
The pilot's ~70% accuracy came substantially from domain corpora this PoC does not have, so it
says so rather than implying grounding it lacks.

Press **Generate**.

## 4 · Generate and Self & Peer Eval — making disagreement measurable

Three columns stream named step logs with green ticks. Each column names its **model** and its
**lens**. Settled content never reflows.

When it completes, open **Self & Peer Eval**:

```
PM Writer 1   Claude Sonnet 4.6   peer 84     self 89   bias  +5    spread  7
PM Writer 2   GPT-5.4             peer 83     self 77   bias  −6    spread 18
PM Writer 3   Gemini 3 Pro        peer 77.5   self 98   bias +20.5  spread 21  ⚠ CONTESTED 77–98
```

**This table is the product.** Four things in it:

1. **Exactly nine reviews** — every writer scored every draft including its own. Count them in
   the matrix: a 3×3 grid.
2. **`Self` badges**, and self-scores **excluded from the peer average**. Look at PM Writer 3:
   it rated its own draft **98** while its peers gave it **77.5** — a **+20.5-point bias**. Had
   that self-score been averaged in, as the pilot did, this draft would look like the strongest.
3. **`⚠ CONTESTED 77–98`** — the evaluators disagreed by more than 20 points about this draft.
   That chip is the single most direct answer to rubber-stamping: it tells the reviewer *where to
   look*. Hover it: *"Evaluators disagreed substantially about this draft. Worth your
   attention."*
4. **Common strengths and concerns** at the bottom — only items raised by **two or more**
   evaluators. One evaluator's opinion is noise; two is signal.

Expand **All individual reviews** to show that every score has written strengths, concerns and
prose feedback behind it. Nothing is a bare number.

## 5 · Captain's Pick — the most important screen

Open **Captain's Pick**.

- The **verdict** names a winner with prose reasoning, the Captain's **model**, and the **mode**
  chip (`full_context`) — a verdict is uninterpretable without knowing what the Captain could
  see.
- **Captain's full analysis** expands to the complete reasoning, not a summary line. It includes
  a *"What I could not judge"* section: the Captain compared the drafts against each other, and
  explicitly does not claim factual accuracy.
- **Your decision** is **one** decision: a base document, then any subset of improvements. The
  pilot presented *two competing radio groups over the same three candidates* — two mental models
  for one choice.
- Every improvement names its source: **`From PM Writer 1:`**. An unattributed suggestion cannot
  even be stored — the database column is `NOT NULL` — because a reviewer could not check it.

Tick two improvements. The count updates to `2/7 selected` and the primary button relabels itself
to **`Build document with 2 improvements`**. Untick them all and it becomes
**`Use PM Writer 3 unchanged`** — publishing the base untouched is always available as its own
action.

Also point out the tertiary actions: **Re-adjudicate · Peer Scored** re-runs *only the Captain*,
reusing the candidates and reviews. You can change how the verdict was reached without paying to
regenerate.

Click **Build document with 2 improvements**.

## 6 · Gate G4 — the accuracy instrument

> This is the screen people will push back on. That is the point.

A table with one row per scorable template section. `Continue to approval` is **disabled**, and
the banner says why:

> *Nothing here is auto-filled, inferred, or copied across rows. The effort is the point — it is
> the only measurement of whether the agent helped, and a skimmed scorecard measures nothing.*

This productises a real artefact: the pilot architect kept a **hand-written 25-row Confluence
table** of exactly these columns, and concluded *"overall time savings is approximately 75%"*.
That table was the only place quality was ever measured.

Score two or three rows by hand — manual effort, quality verdict, rework hours, accuracy — and
watch the **Saving** column compute. Then try to shortcut it:

- **Leave one row blank and press Continue.** Disabled. Now prove it is not just a greyed
  button: the server refuses too, with `422 scorecard_incomplete` naming the remaining count.
- Note the `typical: 4h` hint next to each section. It is **help text, never a pre-filled
  value**.

Fill the rest. The aggregate appears: `accuracy 78% · saving 75%`.

One detail worth mentioning: the aggregate saving is computed from the **totals**, not as a mean
of the per-row percentages — averaging percentages would let a half-hour section outweigh a
six-hour one.

## 7 · Gate G5 — approving exactly what you read

**Continue to approval.**

- **What will be written** — system, destination, operation, title. No ambiguity about what is
  about to happen.
- **Six pre-flight checks**, each with a reason: *placeholders resolved · sections scored ·
  secret scan clean · target valid · base version current · budget available*. Passing checks say
  something useful (`385 premium requests remain today`) rather than echoing a failure string.
- **Your approval** shows the proposal version and an **operation fingerprint** — a hash over
  the operation, the targets and the exact document body.

Note where the focus landed: on the **summary**, not on the approve button. That is deliberate.

Type a review note — it goes into the audit trail against your name — and press
**Approve and publish**. Then **View** the result to open the page in the mock Confluence store.

### Now break it, three ways

1. **Reuse the approval.** Approve again — refused: `409 approval_consumed`. An approval is
   **single-use**, and it is spent on *attempt*, not on success.
2. **Make the target stale.** Open **Systems of record → Confluence**, open the page, and press
   **Simulate an external edit**. Now go back and try to approve a new proposal against that
   page: `409 approval_stale`. The target moved underneath the reviewer, so the approval is void
   — and it is re-checked again immediately before the write, because the dangerous window is
   between approval and apply.
3. **Publish without approving.** (Easiest to show via the API.) Refused with
   `403 approval_required`, and the refusal is **audited**. Check it: **Admin console → Audit**.

## 8 · Provenance

**View provenance** on the published run.

Immutable, sealed on approval. It carries the models with canonical names, the **prompt files
and their content checksums** (which is what proves *which text* produced this artifact), all
nine review scores with self-reviews flagged, the Captain mode and verdict, the cherry-picked
improvements **with their origin**, your human edits, the section scores, who approved it, and
the resulting URL.

Mention the one deliberate exception: publication facts are appended *after* the seal, because an
external ID does not exist until after the approval that authorised the write.

## 9 · User Stories — Jira, and partial failure

**Action mode → Generate User Stories.** Source document: the PRD you just published. Assignee:
your name.

Run it through G3 and G4 as before. At G5, notice the targets: **one target per story**, not one
target holding seven. That matters — the target is the unit of idempotency, approval and retry,
so it has to be the unit a human approves.

Approve and publish. One story fails:

```
6 of 7 items published.   1 item failed.
Jira rejected required field 'MC Team' for issue type Story.
[ Retry 1 failed item ]
```

Press **Retry 1 failed item**. Only the failure is re-attempted; the six successes are not
re-sent, because each target carries its own idempotency key. Check **Systems of record → Jira**:
no duplicates. Every issue has an **assignee** — publishing an unowned work item is a defect, not
a default, and the gate blocks it.

## 10 · Implement Story — plan-first, sandbox, PR *proposal*

**Developer → Implement Story.** Story `G1206-10586`, repository `sample-repo`, base branch
`dev`.

Three **plans** are produced — note the rubric has changed to *Feasibility · Completeness ·
Sequencing · Risk Management · Clarity*, declared per artifact kind.

At **G2** you choose one plan. Plans are **never merged**: the human picks one and that exact
plan executes, because a merged plan is something nobody reviewed. And it executes **exactly
once** — a re-run requires a new run.

Then the **Execute** tab:

- 11 changed files with A/M status and a real per-file diff.
- **`Tests: not measured` · `Coverage: not measured`.** Not `0/0`. The pilot showed `Tests: 0/0`
  beside a PR that demonstrably contained tests; a counter that contradicts the visible diff
  costs more trust than no counter. There is no JVM in the sandbox, so no figure is reported.
- Secret scan: clean. A credential-like string would **block** the proposal, naming the file and
  line.

At G5 the PR needs an explicit confirmation **naming repository, branch and target branch**, and
stating the PR will be visible to the team. The approve button is unavailable until it is ticked.

Approve. You get a pull-request **proposal** in the mock SCM store. Nothing was pushed — and
nothing *could* be: the SCM adapter has no push, commit or merge function at all. Not disabled —
absent. `AD-GIT` requires the capability not to exist, and
`scripts/check-nonnegotiables.js` fails the build if one appears.

## 11 · Review Pull Request — the engine's exam

**Developer → Review Pull Request**, pointed at the plan you just executed.

It completes in seconds, and the tabs are different: `Configure → Review → Publish`. No peer
review. No Captain. One writer.

**This is the same engine with phases omitted — not a second code path.** The report carries a
mandatory provisional banner, anchors its findings to real files from the diff, tags them
`[HIGH]` / `[MEDIUM]` / `[LOW]`, and says `Tests: not measured`.

Worth stating plainly: adding this skill — a new artifact kind and a solo writer — required
**zero changes to the engine**. Only a config file. That is the specification's own test of
whether the one-engine decision holds (*"the test of M2 is M4"*).

## 12 · Budget controls and the admin console

**Admin console.**

- **Overview** — runs, premium requests, average per run, published artifacts, mean section
  accuracy from the G4 scorecards, quality-threshold overrides. Charts by phase, model family,
  skill and day.
- **Ledger reconciliation** — every grouping is a different cut of the same ledger, and the
  reconciliation is **displayed**, not asserted: *"All groupings reconcile to the ledger total."*
- **Runs** — per run: estimate, actual, **variance %**, model families, size band, per-phase
  breakdown.
- **Size bands** — with the note *"Bands classify runs for reporting only. They never choose
  models, writers or phases."*
- **Estimate calculator** — with the multiplier reference rendered **from the model registry**,
  so no number is typed into the UI.
- **Audit** — content-free events: no prompt text, no source content, no secrets. Your blocked
  publish attempt from step 7 is in here.

Then **show a budget refusal.** Lower the cap and restart:

```powershell
# config/budget.json → "perRunPremiumRequests": 5
.\start.ps1
```

Try to start a PRD run: refused with
*"This run is estimated at up to 17.55 premium requests, but the per-run limit is 5."* Note it is
the **server** refusing — the client cannot waive its own budget.

Finally, prove the configuration gate. Set `"perUserDailyPremiumRequests": null` and run
`.\start.ps1`:

```
Configuration failed to load: 1 problem found.
  • budget.perUserDailyPremiumRequests
      MANDATORY and unset. NFR-COST-002 / DEC-19: budget values have no built-in default —
      the server refuses to start rather than run uncapped.
```

**The server will not start.** No degraded mode, no silent default.

---

## Two more things worth showing

**Light theme.** Toggle it at the foot of the nav rail. One token set, two themes, both AA
contrast. The pilot rendered its generated reports light while the app ran dark.

**Keyboard only.** Put the mouse down and walk steps 3 to 7 again. Tab from the skip link
through the rail, header, launcher and stage rail; arrow keys move along the stage rail and
between the base-candidate radios; `Ctrl+Enter` submits the input form; `Esc` is **blocked**
while a run is active so you cannot lose work by accident.

---

## Questions you should expect

**"Is this using a real model?"**
No — by default. The provider abstraction has two transports and the default is a deterministic
fixture that makes no network calls. The *spend* is simulated; the **accounting is real** —
those premium-request figures flow through the same ledger and the same budget guards that live
usage would. Switch with `JARVIS_MODEL_TRANSPORT=bedrock`, though note a council needs three
distinct model families and only Anthropic is reachable here, so it will refuse by name rather
than quietly substituting a model. That refusal is correct behaviour.

**"So the accuracy numbers are meaningless?"**
The accuracy numbers are about a fixture, yes. What the demo establishes is that the *apparatus*
for measuring accuracy works and cannot be skipped. Measuring actual accuracy needs real models
and the domain knowledge bases, which is an M3 question and a licensing go/no-go (A-09).

**"Did it really write to Confluence?"**
To a local mock store. But the adapters implement the real contract — dry-run preview,
deterministic idempotency key, stale-check anchor, per-item results, partial-failure retry — so
substituting REST calls changes only each adapter's `apply` function.

**"How much of the specification is this?"**
Six skills of 39, four stages of 11, and 12 of the 16 acceptance criteria.
[DEVIATIONS.md](DEVIATIONS.md) lists every departure and what R1 does instead;
[PRD.md](PRD.md) §8 states plainly which criteria are **not** claimed and why.

**"What did building it tell us?"**
Five things that change R1, all in [PR-REVIEWS.md](PR-REVIEWS.md) — most importantly that three
separate controls were specified at the wrong granularity (the publish target, the provenance
seal, and the stale check), and in each case the code ran without error while the control
silently did not work. Those are the findings worth the most.
