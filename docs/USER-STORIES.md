---
Written for: the engineers implementing and reviewing the PoC, and the QA reader checking
coverage against the specification.
---

# JARVIS proof of concept — user stories

Sixteen stories, `JP-01`…`JP-16`, in dependency order. Each carries the specification
requirement IDs it satisfies and the named test that verifies it — requirement IDs are the
shared vocabulary (`CLAUDE.md` §5), and tests are named for the requirement they verify.

**Definition of done** (per `CLAUDE.md` §8): implemented, tested, accessible, requirement IDs
mapped to passing tests, and introducing no new hard-coded model ID, hard-coded token value, or
ungated write.

---

## Platform spine

### JP-01 — Configuration refuses to run unsafely

> As a **platform engineer**, I want the server to refuse to start on unsafe configuration, so
> that a misconfigured budget or an undiversified council can never reach a user.

**Requirements** `CAP-ADMIN-01` · `FR-ARCH-SYS-042` · `NFR-COST-002` · `FR-MODEL-003` ·
`FR-COUNCIL-004`

**Acceptance criteria**
- Given any of the five budget keys is null, missing, non-numeric or non-positive, when the
  server starts, then it exits with a message naming the key and the requirement, and no port is
  bound.
- Given a per-run cap greater than the daily cap, when configuration loads, then it is rejected
  — a run could never complete.
- Given a multi-writer council with `requireDistinctModels: false`, when configuration loads,
  then it is rejected. An unsafe default is rejected, never warned about.
- Given two registry entries share a display name, when configuration loads, then it is
  rejected (one canonical display name per model).
- Given a council declares `adjudicate` with no captain, or a roster that cannot yield the
  required number of distinct model families, then it is rejected.
- Given a config file carries a UTF-8 BOM, when it loads, then it parses successfully.

**Tests** `config.budget.missingKeyRefusesStart` · `config.rejectsIndistinctCouncil` ·
`config.rejectsDuplicateDisplayName` · `config.rejectsAdjudicateWithoutCaptain`

---

### JP-02 — Durable runs and an append-only event log

> As an **auditor**, I want the event log to be append-only and the run reconstructable from it,
> so that I never have to trust a summary.

**Requirements** `FR-EVT-003` · `FR-COUNCIL-001` · `NFR-REL-003` · `FR-EVT-004`

**Acceptance criteria**
- Given an event exists, when an update or delete is attempted, then the database aborts it.
- Given a `writer.token` event, when persistence is attempted, then it is refused — transport
  only.
- Given a run mid-generation, when the server is killed and restarted, then every settled
  candidate survives and the run is resumable.
- Given a completed run, when its events are replayed, then the writers, reviews, verdict and
  decisions reconstruct.

**Tests** `events.appendOnly.rejectsUpdate` · `events.rejectsTokenEvents` ·
`run.survivesServerRestart` · `events.replay.reconstructsRunProjection`

---

### JP-03 — API spine that accepts no policy from the client

> As a **security engineer**, I want every policy decision made server-side, so that a client
> bug or a hostile client cannot waive a control.

**Requirements** `FR-API-001…005` · `FR-API-010…014` · `FR-API-002`

**Acceptance criteria**
- Given a request whose `Host` is not loopback, when it arrives, then it is refused.
- Given a state-changing request without a valid CSRF token, then it is refused.
- Given any non-2xx response, then the body is the canonical error envelope with a stable
  `code`, a message naming cause **and** next action, and a correlation ID.
- Given an error, then no response field contains a credential, token or secret.

**Tests** `api.rejectsNonLoopbackHost` · `api.requiresCsrfOnWrites` ·
`api.errorEnvelope.alwaysPresent`

---

### JP-04 — Event stream with resume-by-sequence

> As a **user**, I want to close my laptop lid mid-run and come back to a correct screen, so that
> a long wait is survivable.

**Requirements** `FR-EVT-001/002` · `FR-API-020…026`

**Acceptance criteria**
- Given a connect, then `stream.ready` is sent first and every event carries a monotonic `id`.
- Given a reconnect with `Last-Event-ID`, then retained events with a greater sequence replay in
  order, then live resumes, with no duplication and no gaps.
- Given no client is connected, then the run continues — runs are server-owned.
- Given 15 seconds pass, then a comment heartbeat is sent.

**Tests** `stream.replaysFromLastEventId` · `stream.runContinuesWithNoClient`

---

### JP-05 — Provider abstraction with two real transports

> As an **architect**, I want the provider abstraction to have more than one implementation, so
> that it has been shown to abstract something.

**Requirements** `FR-MODEL-001…005` · `AD-MODEL` · AM-01

**Acceptance criteria**
- Given a logical model name, when resolved, then the registry returns provider, family,
  canonical display name, context window, multiplier and status, and records the resolution.
- Given a resolved model, then its display name is identical on every surface — picker, writer
  card, review matrix, provenance, admin console.
- Given a deprecated model, then selecting it warns and names the alternative; an unavailable one
  is blocked.
- Given the Bedrock transport and a model with no Bedrock identifier, then resolution fails
  **visibly** rather than substituting a different model.
- Given application code, then no model identifier appears outside the registry.

**Tests** `model.registry.oneCanonicalDisplayName` · `model.noHardCodedIdsInAppCode` ·
`model.unavailableOnTransportFailsVisibly`

---

### JP-06 — Run lifecycle, quorum and cancellation

> As a **user**, I want a writer failure to degrade the run rather than lose it, and the
> degradation to be visible.

**Requirements** `FR-COUNCIL-001…009`

**Acceptance criteria**
- Given one writer fails with two or more remaining, then the run continues, is marked degraded,
  and names which writer failed and why.
- Given fewer than two candidates settle **and the skill declares a `review` phase**, then
  review and adjudication are skipped and the run is degraded.
- Given a skill that declares **no** `review` phase, then it is **not** degraded — that is the
  designed solo case.
- Given a cancellation in any non-terminal state, then partial candidates remain inspectable and
  are marked incomplete.
- Given `awaiting_human`, then the engine never leaves it without a recorded actor and timestamp.

**Tests** `council.quorum.belowTwoSkipsToHumanAndDegrades` · `council.solo.isNotDegraded` ·
`council.awaitingHuman.requiresActor` · `council.cancel.marksPartialsIncomplete`

---

### JP-07 — Token budget and consumption controls

> As a **platform engineer**, I want spend capped at every point where spend happens, so that a
> runaway council cannot drain a day's budget.

**Requirements** `FR-COST-001…004` · `NFR-COST-001/002/004` · threat `T-05` · `FR-ADMIN-001…008`

**Acceptance criteria**
- Given a skill and a writer selection, when an estimate is requested, then a premium-request
  **range** and a token total are returned, computed from the resolved multipliers and the
  measured context size, with the per-phase call breakdown.
- Given an estimate exceeding the per-run or daily cap, when a run is created, then it is refused
  with `402` naming the limit and the remaining balance.
- Given a run that has reached its per-run cap mid-flight, when the next phase is about to start,
  then the run halts, is marked degraded, and **keeps its settled candidates**.
- Given projected usage at or above the warning threshold, then a warning is surfaced before the
  spend.
- Given a completed run, then per-writer, per-phase and per-model actuals are recorded with the
  variance against the estimate.
- Given the admin console, then every grouping of the ledger reconciles to the same total, and
  the reconciliation is displayed.

**Tests** `cost.estimate.appearsBeforeGenerate` · `cost.budget.perRunBlocks` ·
`cost.budget.perDayBlocks` · `cost.midRunGuard.preservesSettledWork` ·
`cost.actualVsEstimate.recorded` · `admin.ledger.reconcilesAcrossGroupings`

---

## The Council

### JP-08 — Generate phase with honest gaps

> As a **reviewer**, I want a draft to tell me where it had no input, so that I am not sold a
> confident fabrication.

**Requirements** `FR-GEN-001…005`

**Acceptance criteria**
- Given a run starts, then each writer streams a **named** step log with completion ticks,
  elapsed time and a done count.
- Given a settled candidate, then its word count, section outline, resolved model, token counts
  and duration are recorded.
- Given a section the input does not support, then the draft carries
  `TBD [UNKNOWN — requires user input]`, and that placeholder is **detected server-side** rather
  than trusted from the model.
- Given unresolved placeholders, then publication is blocked and each one is named with its
  section.

**Tests** `gen.placeholders.detectedServerSide` · `gen.placeholders.blockPublication`

---

### JP-09 — N² review, self-review bias, contested marking

> As a **reviewer**, I want to be told which draft the evaluators disagreed about, so that I
> spend my attention where it pays.

**Requirements** `FR-REV-001…006` · AM-09

**Acceptance criteria**
- Given N settled candidates and N writers, then **exactly N²** reviews exist. A missing review
  fails the phase and is named.
- Given a review of a writer's own draft, then it is **flagged in the data**, not inferred later
  by comparing identifiers.
- Given a self-review, then it is **excluded from the peer average** and displayed separately,
  alongside the bias it would have introduced had it counted.
- Given evaluator scores for one candidate spanning more than 20 points, then the candidate is
  marked contested, with the spread shown.
- Given a strength or concern raised by two or more evaluators, then it is promoted to the
  consensus panel with the count.

**Tests** `council.reviews.producesNSquared` · `council.selfReview.excludedFromPeerAverage` ·
`council.contested.marksSpreadOver20` · `council.consensus.requiresTwoEvaluators`

---

### JP-10 — Verdict, attribution and cherry-pick

> As a **reviewer**, I want every proposed improvement to name where it came from, so that I can
> check it.

**Requirements** `FR-ADJ-001…006` · `FR-SYN-001…003` · `FR-HUM-001…006`

**Acceptance criteria**
- Given adjudication, then the verdict carries a winner, prose rationale, and a suggestion list
  capped at the configured maximum.
- Given any suggestion, then it names its source candidate. An unattributed suggestion cannot be
  stored.
- Given the Captain's analysis, then it is available in full, not as a summary line.
- Given the decision screen, then there is **one** decision: a base candidate and any subset of
  suggestions, with a single primary action carrying the count.
- Given zero suggestions selected, then publishing the base unchanged is available as its own
  action.
- Given a selected suggestion that cannot be applied, then it is named with the reason — never
  silently dropped.
- Given a request to re-adjudicate under a different Captain mode, then the Captain re-runs and
  the writers do not.

**Tests** `council.suggestions.alwaysAttributed` · `council.synthesis.reportsUnappliedSuggestions` ·
`council.readjudicate.reusesCandidates`

---

## Interface

### JP-11 — Shell, three start modes, design tokens

> As a **user**, I want to reach any skill three ways and complete the thread keyboard-only.

**Requirements** `FR-NAV-007…020` · `UX-A11Y-001…010` · design-system §6.1

**Acceptance criteria**
- Given the landing screen, then the 11-stage rail renders every stage at 1280px with a declared
  overflow treatment, and a run title is human-readable and never exposes a prompt, ID or
  template fragment.
- Given the 7-chip lifecycle row, then it is captioned as a summary and is not interactive.
- Given any of Agent, Action or Workflow mode, then the selected segment and the rendered panel
  come from one state value.
- Given a writing skill in any mode, then a write badge names the system and states that
  approval is required, as icon **and** text.
- Given every agent card, then the manifest has an identical shape.
- Given either theme, then contrast meets AA and no status is carried by colour alone.
- Given a literal hex, px or ms value, then it appears only in `tokens.css`.

**Tests** `web.stageRail.rendersAllEleven` (UI driver) · `check-nonnegotiables` (hex outside
tokens) · `run.title.neverExposesInternals`

---

### JP-12 — The Council modal

> As a **reviewer**, I want the screen to never tell me two contradictory things at once.

**Requirements** `FR-HUM-006` · `FR-CMP-001…004` · council-engine-spec §8

**Acceptance criteria**
- Given any run state, then the status string is produced in exactly one place and derives from
  that state. "Captain deliberating…" never appears beside "Verdict ready".
- Given the skill's declared phases, then tabs reflect them and future phases are disabled with
  a reason.
- Given an active run, then `Esc` and `✕` are blocked.
- Given 2–3 selected candidates, then compare panes render side by side, each individually
  focusable and labelled.
- Given streaming output, then settled content never reflows.
- Given a writer failure, then the error appears **in that writer's column**.

**Tests** `reducer.statusLabel.derivesFromStateOnly` · UI driver steps 6–10

---

## Gates and publication

### JP-13 — G4: the section scorecard

> As a **product owner**, I want accuracy measured section by section before anything is
> published, so that "70% accurate" becomes a number someone is accountable for.

**Requirements** `FR-SCORE-001…006` · `FR-API-030…032` · `BR-007`

**Acceptance criteria**
- Given a document artifact, then a scorecard row exists per **scorable** template section.
- Given any unscored row, then `Continue to approval` is disabled **and** the server refuses to
  complete the scorecard, naming the remaining count.
- Given a row, then nothing is auto-filled, inferred or copied from another row. A typical-effort
  hint appears as help text, never as a value.
- Given a client that supplies `effortSavedPercent` or any aggregate, then the request is
  rejected.
- Given rework hours greater than manual hours, then the request is rejected — that is a negative
  saving and probably a transposition.
- Given a complete scorecard, then it is immutable; a correction creates a new one.
- Given the aggregate saving, then it is computed from the totals, not as a mean of per-row
  percentages.

**Tests** `scorecard.incompleteBlocksPublish` · `scorecard.rejectsClientSuppliedAggregates` ·
`scorecard.rejectsReworkExceedingManual` · `scorecard.completeIsImmutable`

---

### JP-14 — G5: approval and idempotent publication

> As an **approver**, I want to be certain I am authorising exactly what I read.

**Requirements** `FR-APPROVE-001` · `FR-PUBLISH-001…007` · `FR-API-040…057` · `RCR-STALE-001`

**Acceptance criteria**
- Given a proposal, then the summary states system, destination, operation, title and ownership
  per target, and six pre-flight checks each report pass or fail **with the matching reason**.
- Given an approval, then it binds to the proposal version **and** the operation fingerprint, and
  a mismatch in either is refused.
- Given a target that changed, then the approval is refused as stale — checked at approval **and
  again immediately before apply**.
- Given a consumed approval, then re-publication is refused. An approval is single-use and is
  spent on use, not on success.
- Given no approval, then publication is refused and the refusal is audited.
- Given a retry with the same idempotency key, then the stored result is returned and **no
  external call is made**.
- Given a partial failure, then per-item results are reported and only the failures are
  retryable.
- Given a work item with no owner, then publication is blocked — an unowned item is a defect, not
  a default.
- Given a pull request, then an explicit confirmation naming repository, branch and target branch
  is required before approval is possible.

**Tests** `publish.requiresCurrentScopedApproval` · `publish.approval.isSingleUse` ·
`publish.approval.staleTargetBlocks` · `publish.approval.fingerprintMismatchBlocks` ·
`publish.idempotency.retryDoesNotDuplicate` · `publish.partialFailure.retriesOnlyFailed` ·
`publish.rejectsUnownedWorkItem` · `publish.pr.requiresExplicitConfirmation`

---

### JP-15 — Sandbox, diff and the PR proposal

> As a **developer**, I want the plan I chose to execute exactly once, in a place with no
> credentials, and the result to be a proposal.

**Requirements** `FR-EXE-001…004` · `FR-COUNCIL-007` · `NFR-SEC-007` · `AD-GIT` · `NFR-SEC-002`

**Acceptance criteria**
- Given an approved plan, then execution runs **exactly once**; a second attempt is refused and
  a re-run requires a new run.
- Given execution, then it happens in an isolated workspace with no credentials, which is
  destroyed afterwards.
- Given a multi-file change, then a file tree with add/modify status and a per-file diff are
  shown with accurate line counts.
- Given no real test run, then counters read `not measured`. **Never `0/0`.**
- Given a credential-like string in generated code, then the PR proposal is **blocked**, naming
  the file and line — and the matched value is never written to the log.
- Given the SCM adapter, then it exposes no function that pushes, commits, merges or deletes a
  branch.
- Given any path resolution, then it happens in exactly one module, and a traversal or symlink
  escape is refused.

**Tests** `council.execute.runsExactlyOnce` · `exec.testCounters.notMeasuredNeverZeroZero` ·
`exec.secretScan.blocksPrProposal` · `scm.adapter.hasNoPushCapability` ·
`security.pathGuard.rejectsTraversal`

---

### JP-16 — Solo path, provenance, history, admin console

> As an **architect**, I want a report skill to run on the same engine with phases omitted, so
> that enabling a council later is configuration rather than a rewrite.

**Requirements** engine AC 2 · `FR-PROV-001…004` · `FR-ADMIN-001…008` · `CAP-PROV-02`

**Acceptance criteria**
- Given a skill configured `writers: 1` with `review` and `adjudicate` omitted, then it runs end
  to end **with no engine code change**, is not marked degraded, and does not stop at a gate with
  nothing to decide.
- Given a report artifact, then it carries a provisional banner stating it must be evaluated by
  qualified personnel before anyone acts on it.
- Given any artifact, then provenance records models with canonical names, prompt references and
  **content checksums**, all N² review scores with self-flags, the Captain mode and verdict,
  section-level composition with origins, human edits, scores, approver, timestamps and resulting
  URLs.
- Given approval, then provenance becomes immutable — except that publication facts, which do not
  exist until after the approval that authorised them, may be appended once.
- Given the admin console, then it is read-only, reports what it has not measured as such, and
  shows an empty period as "no runs" rather than a zero chart.

**Tests** `council.solo.reportSkillNeedsNoEngineChange` · `provenance.sealedOnApproval` ·
`provenance.publicationAppendableAfterSeal` · `admin.ledger.reconcilesAcrossGroupings`

---

## Coverage summary

| Area | Stories | Named tests |
|---|---|---|
| Configuration and persistence | JP-01, JP-02 | 8 |
| API and stream | JP-03, JP-04 | 5 |
| Provider abstraction | JP-05 | 3 |
| Council engine | JP-06, JP-08, JP-09, JP-10 | 12 |
| Cost and budget | JP-07 | 6 |
| Interface | JP-11, JP-12 | 3 + UI driver |
| Gates and publication | JP-13, JP-14, JP-15 | 17 |
| Solo path, provenance, admin | JP-16 | 4 |
