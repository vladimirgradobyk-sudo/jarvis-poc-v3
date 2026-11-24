# Deviation register

Every departure of this proof of concept from `JARVIS-MVP-Specification-v1.6`, why it was taken,
and what Release 1 does instead.

The purpose of this register is that a reader of the running demo can tell what is *evidence
about the design* from what is *an artefact of the prototype*. Anything not listed here is
implemented as specified.

---

## Approved by the requester before build

These were put to the requester as explicit choices and chosen deliberately.

| # | Deviation | Specification | Reason | What R1 does |
|---|---|---|---|---|
| **DV-01** | **Zero-dependency Node + vanilla ES-module SPA** instead of React 18 + Vite + TypeScript + Express + better-sqlite3 in four npm workspaces | `repo-scaffold.md` §2–3 | `npm install` is unreliable behind this workstation's TLS interception (spec constraint C-02 / OQ-3), and a build step before every demo is a failure mode during a presentation. `node:http` + `node:sqlite` need no install and no build | The specified stack. The module boundaries, the chokepoints and the event-sourced client projection are all preserved here, so the port is mechanical rather than a redesign |
| **DV-02** | **Generate LLD ships under the Architect agent** | `skill-catalogue.md` §4.6 #57 places Generate LLD in **R2**, owned by the Tech Lead agent, which is out of MVP scope | Explicitly requested for this PoC | R2, under the Tech Lead agent, depending on an approved HLD |
| **DV-03** | **G5 writes to local mock systems of record** rather than Confluence DC, Jira and Bitbucket | `integrations.md` | No credentials, and no risk of writing to a production system from a prototype. The *contract* is the real one — dry-run preview, deterministic idempotency key, stale-check anchor, per-item results, partial-failure retry — so swapping in REST calls touches only each adapter's `apply` function | Real adapters using the operator's delegated tokens, after approval |
| **DV-04** | **Deterministic fixture transport is the default provider**; a Bedrock transport is opt-in | `AD-MODEL`, `AD-INVOKE-R1`: GitHub Copilot CLI over ACP is the single approved provider | A-07 (≥3 approved model families) is unconfirmed on this workstation — only the Anthropic family is reachable — and FR-COUNCIL-004 requires distinct families. The demo must be repeatable, free and offline. The spec's own test strategy runs integration tests against recorded fixtures for the same reason | Copilot CLI over ACP behind the same `Transport` interface. The abstraction here has two real implementations, which is the point of having one |
| **DV-05** | **In-process `local` sandbox runtime**; the Docker runtime is a declared stub behind the same interface | `AD-SANDBOX`, `NFR-SEC-005`: a container with no credentials and allow-listed egress | Container build time on every demo run, and OQ-11 (container runtime on managed workstations) is unresolved. The local runtime copies the bundled repo to a temp workspace, holds no credentials, makes no network calls, and is destroyed after the run | The container runtime, with the egress allow-list and resource caps |
| **DV-06** | **Six skills, not 39** | `01-product-requirements.md` §3.2 | The PoC proves the mechanism, not breadth. `CLAUDE.md` §8 is explicit that breadth across the configured skills is not the goal: "one complete governed thread is" | The skills package delivered separately against the skill contract |

---

## Taken during the build

| # | Deviation | Reason |
|---|---|---|
| **DV-07** | **Prompts are not sent to a model on the default transport.** The fixture transport generates from the template's section content and the writer's voice profile, not from the prompt text | The prompt library is still real, versioned, immutable and **checksummed into provenance** — the mechanism the spec cares about — and the Bedrock transport does use the prompts. Only the fixture path bypasses them |
| **DV-08** | **No knowledge base or retrieval.** `Knowledge & Retrieval` is reduced to a context manifest that reports what it does *not* have | A-09 (knowledge-base licensing) is a go/no-go the PoC cannot resolve. Rather than imply grounding we lack, the UI and every provenance record carry a `DegradedSourceBanner` saying output is generic-model quality |
| **DV-09** | **No `writer.token` streaming.** Progress streams as named `writer.step` events, not per-token deltas | Step logs are what the pilot showed and what the spec specifies (FR-GEN-002). Token streaming is transport-only and unpersisted by FR-EVT-004 anyway, so its absence changes no stored state |
| **DV-10** | **One multiplexed SSE stream, no per-run subscription endpoint** (`POST /stream/subscriptions` is absent) | Single user, one browser tab. The stream carries every run and the client filters by `runId`. Resume-by-sequence, heartbeat and replay are all implemented |
| **DV-11** | **Jira publish targets are expanded one-per-issue** rather than one target holding N items | Found during testing: a single target holding seven stories reported a publish in which six issues were created as one *failure*, and made "retry only the failed item" inexpressible — the exact duplicate-creating blanket retry FR-PUBLISH-003 forbids. The target is the unit of idempotency, approval and retry, so it must also be the unit a human approves |
| **DV-12** | **Test counters are always `not measured`** | There is no JDK or Maven in the sandbox, so no test run happens. FR-EXE-003 requires counters to be reported accurately or not at all, so refusing to produce a figure is the specified behaviour rather than a gap. R1 parses a real test run |
| **DV-13** | **Fixture placeholder rate is scaled per artifact kind** — full for `document`, 25% for `code_plan`, zero for `report` | FR-GEN-005 is unchanged and still blocks publication. But a planning council that frequently produced an unpublishable plan made the pull-request path unreachable at random, which teaches nothing. A human would reject such a plan at G2 anyway |
| **DV-14** | **Fixture evaluator divergence is tuned so one candidate in a 3-writer run reliably exceeds the 20-point contested threshold** | Contested marking is the spec's single most direct mitigation of the rubber-stamp risk (BRISK-009). A demo in which it never fires would hide the mechanism it exists to show. Real evaluators with genuinely different lenses do diverge this much |
| **DV-15** | **`git` is not used at all** | `git` is not installed on this workstation — and would not be used regardless. `AD-GIT` requires the SCM adapter to have *no push capability at all, "not a disabled one, an absent one"*. The sandbox copies files; nothing is ever initialised, committed or pushed. The output is a pull-request **proposal** |

---

## Specified controls that are fully implemented

Listed because a reader is entitled to know what was *not* shortcut.

- **No write without a current, explicit, single-use approval** bound to the exact proposal
  version and operation fingerprint (`FR-APPROVE-001`, `FR-API-040/042`). Proven by test for
  every adapter.
- **Stale-target detection** re-verified at approval *and again immediately before apply*
  (`RCR-STALE-001`, `FR-API-041`).
- **Idempotent publication**: a deterministic per-target key derived at proposal time; a replay
  returns the stored result and performs no external call (`FR-API-051/052`).
- **Partial-failure reporting** per item, with retry of only the failures (`FR-PUBLISH-003`).
- **Exactly N² reviews**, self-reviews flagged and excluded from the peer average
  (`FR-REV-001/003`, `AM-09`).
- **Contested-candidate marking** above a 20-point evaluator spread (`FR-REV-006`).
- **Every suggestion attributed** to its source candidate — enforced by a `NOT NULL` column, so
  an unattributed suggestion cannot be stored (`FR-ADJ-002`).
- **Mandatory section scoring** before document publication, with no auto-fill, no inference and
  no apply-to-all; aggregates computed server-side and a client-supplied aggregate rejected
  (`FR-SCORE-001/006`, `FR-API-030`).
- **Unresolved placeholders block publication**, resolvable only by a recorded human edit
  (`FR-GEN-005`, `FR-REVIEW-004`).
- **Secret scanning blocks a PR proposal** (`NFR-SEC-007`).
- **Redaction at the boundary** and **prompt-injection detection** on supplied input
  (`NFR-SEC-001`, `AIR-PROMPT-002`).
- **Append-only event log** enforced by database triggers; the run is reconstructable from it.
- **Loopback-only binding with a Host check**, CSRF on every state-changing request, and the
  canonical error envelope on every non-2xx response.
- **Mandatory budget configuration** that refuses server start, enforced at seven points.
- **Actor resolved from the OS user at startup** and stamped on every decision, score and
  approval.
- **Both themes at AA contrast**, keyboard-complete thread, `aria-live` streaming regions,
  colour never the sole carrier of meaning.
