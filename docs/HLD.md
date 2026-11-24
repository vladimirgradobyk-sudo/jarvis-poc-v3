---
Written for: solution and software architects, security engineers and the engineering lead
reviewing the PoC against JARVIS-MVP-Specification-v1.6.
---

# JARVIS proof of concept — high-level design

**Version** 1.0 · **Date** 2026-11-18
**Basis** `02-architecture/00-architecture-overview.md`, `council-engine-spec.md`,
`system-architecture.md`, `security-architecture.md`. Component names are the specification's,
unchanged.

---

## 1. Architectural position

| Dimension | PoC | Specification (R1) | Deviation |
|---|---|---|---|
| Form | Single-tenant local web application on **127.0.0.1** only | Same | — |
| Client | Vanilla ES-module SPA, no build step | React 18 + Vite | DV-01 |
| Server | Node `node:http`, no framework | Express/Node LTS | DV-01 |
| Store | `node:sqlite` (WAL) + append-only event log | better-sqlite3, same model | DV-01 |
| Models | Provider abstraction with **two** transports: deterministic `fixture` (default) and `bedrock` (opt-in) | Copilot CLI over ACP | DV-04 |
| Writes | **Only** via Proposal & Approval → Integration Adapters | Same, real adapters | DV-03 |
| Code execution | `local` sandbox runtime behind the runtime interface; `docker` stubbed | Container sandbox | DV-05 |
| Users | One, `actor` = OS-authenticated user resolved at startup | Same | — |
| Skills | Six, as configuration | 39, delivered separately | DV-06 |

### 1.1 Principles, carried unchanged

1. **The AI is untrusted.** Model output, repository content and retrieved knowledge are data,
   never instructions.
2. **Policy outside the model.** Models propose. Deterministic code authorises, executes and
   records.
3. **Every side effect is a Proposal** approved by a named human for that exact version and
   operation.
4. **Diversity is functional**: distinct model families per council, enforced at configuration
   load and again at run creation.
5. **Provenance by default**: every artifact is reconstructable from the event log.
6. **Smallest sufficient design**, with the seams the later releases need left open.

---

## 2. System context

```
   Delivery team member ──browser, 127.0.0.1, same origin──▶ JARVIS (local)
   Platform engineer ─────config, budgets, model registry───▶

   JARVIS ──Transport interface──▶ fixture (in-process)      ← default, no network
                                 └ bedrock (HTTPS, SigV4)    ← opt-in, real cost
   JARVIS ──PublishTarget interface, after approval──▶ mock Confluence · Jira · Bitbucket
                                                      (local store; real REST in R1)
```

The only outbound network call the PoC can make is the Bedrock transport, and only when
explicitly enabled. In the default configuration the process makes no network calls at all.

---

## 3. Components

Twelve canonical components, mapped one-to-one onto the specification's names.

| Component | Where | Responsibility |
|---|---|---|
| React SPA | `web/` | Projection of server run state. Stage → agent → skill → run → review → approve |
| API Layer | `server/app.js`, `server/api/routes.js` | Versioned REST + one SSE stream; validation, CSRF, idempotency, error envelope |
| Run Orchestrator | folded into `server/council/engine.js` | Server-owned run lifecycle, bounded concurrency, persistence, cancellation |
| **Council Engine** | `server/council/` | generate → review → compare/adjudicate → human decision → (execute) → score → propose |
| Provider Abstraction | `server/providers/` | Model registry, transports, metering in premium requests |
| Knowledge & Retrieval | reduced to a context manifest in `engine.buildContext` | Reports what it has — and what it has not (DV-08) |
| Policy & Guard | `server/security/`, `server/council/cost.js` | Paths, redaction, injection detection, budgets, secret scan |
| Proposal & Approval | `server/persistence/repos/publish.repo.js` + the G5 routes | Proposals, approvals, stale check, atomic apply, provenance |
| Integration Adapters | `server/integrations/index.js` | Confluence, Jira, SCM. Mutually isolated; none imports the engine |
| Sandbox Executor | `server/sandbox/executor.js` | Credential-free workspace, apply plan, extract diff, destroy |
| Config Loader | `server/config/` | Per-file merge, schema validation, refuse unsafe values, config hash |
| Persistence | `server/persistence/` | SQLite WAL, migrations, append-only event log, immutability triggers |

### 3.1 The rule that matters most

The Council Engine is **artifact-agnostic and agent-agnostic**. It knows about phases, writers,
rubrics and captains — never about PRDs, HLDs, Jira or pull requests. There is no
`if (skill.id === …)` anywhere under `server/council/`.

The test of this is empirical and was performed: **adding the fourth, fifth and sixth skill —
including a new artifact kind and a new phase order — required zero changes under
`server/council/`.** Only `config/` changed. This is the specification's own test (`CLAUDE.md`
§3: *"The test of M2 is M4"*), and it is recorded in [PR-REVIEWS.md](PR-REVIEWS.md).

### 3.2 Single-responsibility chokepoints

Three things exist in exactly one place each, because duplicating them is how the pilot's
defects happened (`repo-scaffold.md` §4.2). All three are enforced mechanically by
`scripts/check-nonnegotiables.js`, not by review discipline.

| Concern | The one place | The pilot defect it prevents |
|---|---|---|
| Path resolution | `server/security/path-guard.js` | A second `path.resolve` is a traversal bug waiting to happen |
| Model name → display name | `server/providers/registry.js` | The pilot showed one model three ways in one flow, and display disagreed with resolved |
| Run status string | `web/lib/reducer.js` (client), `server/council/state-machine.js` (server) | The pilot showed "Captain deliberating…" above "✓ Verdict ready" |

---

## 4. Key flows

### 4.1 Document skill — run to publication

```
 1  User selects skill, fills inputs rendered from the declared schema
 2  SPA  → POST /runs/estimate
 3       → Policy & Guard: validate, redact, detect injection, budget check
 4  SPA  ← G1 preview: context manifest, estimate range, budget remaining
 5  User → POST /runs            (server-side budget decision; 402 if over)
 6  API  → Orchestrator: create run, persist, stamp actor and config hash
 7  Engine → 3 writers on 3 distinct families, concurrent, bounded
 8         → 9 reviews (every writer scores every candidate, self flagged)
 9         → Captain adjudicates under the recorded mode
10  SPA  ← events over GET /api/stream (monotonic seq, replayable)
11  User → POST /runs/{id}/decision     ◀── GATE G3: one base + any suggestions
12  Engine → synthesise, section-level origins recorded
13  User → PUT /scorecards/.../sections ◀── GATE G4: every section, by hand
14  API  → POST /runs/{id}/proposals    (placeholders and secrets block here)
15  User → POST /proposals/{id}/approve ◀── GATE G5: version + fingerprint
16  API  → re-verify stale anchor, then adapter.apply with the approval
17  Adapter ← PublishResult → provenance sealed, trace recorded
```

### 4.2 Code skill — plan-first

```
 1  Developer → run implement-story (plan_first is the only mode)
 2  Engine    → 3 plans, 9 reviews, Captain picks
 3  Developer ◀── GATE G2: choose ONE plan. Plans are never synthesised —
                 a merged plan is something nobody reviewed
 4  Engine    → lease sandbox, copy workspace (no credentials)
 5  Sandbox   → apply the chosen plan EXACTLY ONCE, extract diff, destroy
 6  Policy    → secret scan; a finding BLOCKS the proposal
 7  Developer → review the multi-file diff; counters read "not measured"
 8  Developer ◀── GATE G5: confirmation naming repo, branch and target
 9  SCM adapter → pull-request PROPOSAL. Nothing is pushed
```

### 4.3 Report skill — the solo case

```
 1  configure → generate → publish.  writers: 1. No review. No captain.
 2  THE SAME ENGINE with phases omitted — not a second code path.
 3  Not degraded: the quorum rule applies only where `review` is declared.
 4  No cherry-pick decision exists, so the run goes straight to G5.
```

---

## 5. Trust boundaries

| # | Boundary | Control in the PoC |
|---|---|---|
| B1 | Browser → server | Loopback bind + `Host` check, same origin (so no CORS policy exists), CSRF token on every state-changing request, schema validation before any side effect, **no client-supplied policy** |
| B2 | Server → model provider | Channel separation (policy is the only instruction channel), redaction at the boundary, budget check before the call, no credentials in prompts |
| B3 | Model output → server | Parsed as data. Never executed, never shell-interpolated. Markdown rendered through an escape-first path so output cannot inject markup. A model cannot name a tool or a path |
| B4 | Server → sandbox | Isolated temp workspace, no credentials passed, no network calls made, destroyed after the run. Every write inside it goes through the path guard |
| B6 | Server → systems of record | Adapters only, never without an unconsumed approval, deterministic idempotency key, actor recorded |
| B7 | Server → filesystem | One path guard: workspace-root confinement, `..` rejection, symlink rejection, real-path comparison |
| B8 | Supplied content → prompt | Delimited untrusted channel, injection detection on input with a refusal and an audit event |
| B10 | Agent → tools | No tool surface exists. The agent cannot call anything; the engine calls the transport |

### 5.1 Threats and controls

| Threat | Control |
|---|---|
| **Unapproved write** | Approval is single-use, bound to version + fingerprint, re-verified before apply. Adapters refuse an unapproved call independently of the route check |
| **Duplicate write on retry** | Deterministic per-target idempotency key derived at proposal time; a replay returns the stored result and makes no call |
| **T-05 denial of wallet** | Mandatory budgets, pre-run estimate, server-side block, per-phase re-check, bounded concurrency, wall-clock caps |
| **Prompt injection** | Delimited channels, pattern detection on input, refusal plus audit event. Model output cannot reach a tool |
| **Secret leakage** | Redaction at the boundary on input and on event payloads; secret scan on generated code blocks the PR; the matched value is never logged |
| **Path traversal** | One resolver, lexical and real-path checks, symlink rejection |
| **Autonomous git** | The capability is absent, not disabled. Enforced by a grep in CI |
| **Silent degradation** | Every degraded run names its cause in the interface, in the event log and in provenance |
| **Rubber-stamping** | Contested marking, consensus panel, self-review exclusion with the bias shown, a scorecard that cannot be auto-filled, and an approval bound to a fingerprint |

---

## 6. Deterministic versus probabilistic

Following `architecture-overview.md` §7. The split is the product: everything a reviewer relies
on is deterministic and testable.

| Deterministic (code, tested) | Probabilistic (model) |
|---|---|
| Selection, input validation, prompt assembly, redaction, injection detection, budget checks and estimates, quorum, review aggregation, self-score exclusion, contested detection, consensus extraction, placeholder scanning, quality score, secret scan, path and branch policy, proposal diff, fingerprinting, stale check, apply, idempotency, provenance, audit, status strings | Draft text, critique text, Captain rationale and suggestions, synthesis text, plan text |

---

## 7. Non-functional characteristics

| Concern | Target | How |
|---|---|---|
| Cost | Mandatory per-run and per-user-daily caps in premium requests **and** tokens | Seven enforcement points; startup refuses if unset |
| Reliability | A server restart loses no settled candidate | State persists after every phase transition and every writer settlement |
| Concurrency | One writer's failure never aborts another | Bounded concurrent execution; a rejection yields `null` for that writer only |
| Recoverability | Runs resume from the last completed phase | Durable state plus the append-only log |
| Observability | Per-run models, premium requests and durations per writer | Cost ledger as a first-class table, so every view reconciles |
| Auditability | Content-free audit events for propose / approve / apply / publish / policy / refusal | A module with no parameter for prompt text, so there is no path by which it could be written |
| Accessibility | WCAG 2.2 AA both themes, keyboard-complete thread | One token set with two verified themes; focus always drawn; `aria-live` on streaming; colour never sole carrier; 44×44 targets |
| Performance | Comparison interactive with three long documents | Escape-first markdown render, panes individually scrollable, context lines capped in diffs |

---

## 8. Seams kept open for R2 / R3

The PoC builds no platform service, but leaves the interfaces the later releases grow from
(`target-architecture.md` §3).

| Later service | Grows from | Seam present |
|---|---|---|
| LLM gateway | Provider Abstraction | `Transport` interface with two implementations |
| Workflow engine | Run Orchestrator | Phase list is data; the driver is generic |
| Tool / policy gateway | Policy & Guard + Adapters | `PublishTarget` contract: describe / anchor / validate / apply |
| Approval service | Proposal & Approval | Version + fingerprint + single-use consumption already modelled |
| Identity | `actor` | Resolved in one place at startup; becomes a token subject |
| Evaluation service | Scorecard data | Scores persisted against skill, template version and model |
| Council for QE and Performance (OQ-7) | The solo path | Enabling it is a change to one config file |

---

## 9. What this design does not address

- **Accuracy.** The default transport makes no model calls. The scorecard measures a fixture.
- **Retrieval.** No knowledge base, no chunking, no ranking, no per-chunk provenance.
- **Multi-user.** No authentication, authorisation, or per-user data separation. The surface is
  designed so authentication is additive, but none exists.
- **Real integration contracts.** No third-party API shape has been guessed at. Where R1 needs a
  real endpoint, the PoC has an adapter behind the interface and a local store — per
  `CLAUDE.md` §6.4, which forbids inventing an integration contract.
- **Scale.** Single process, in-process queue, one SQLite file.
