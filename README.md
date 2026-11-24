# JARVIS — proof of concept

A working demo of the governed AI delivery thread specified in
`JARVIS-MVP-Specification-v1.6`. Three agent families, six skills, five human gates, and token
budget controls — running locally with no model calls and no external writes.

> **This is a proof of concept, not Release 1.** See [docs/DEVIATIONS.md](docs/DEVIATIONS.md)
> for every departure from the specification and what R1 would do instead.

## Run it

```powershell
cd C:\Users\E180113\jarvis-poc
.\start.ps1
```

Then open **http://127.0.0.1:7701**.

No `npm install`. No build step. No credentials. No network access required.
Requires Node 22 or later (tested on 24.21).

## What it demonstrates

| | |
|---|---|
| **The Council** | 3 writers on 3 distinct model families, **exactly 9 reviews**, self-reviews flagged and excluded from the peer average, contested candidates marked where evaluators disagree by more than 20 points, a Captain verdict with every suggestion attributed to its source |
| **Five gates** | G1 inputs + cost · G2 plan selection · G3 captain's pick with section-level cherry-pick · G4 section scorecard · G5 single-use approval bound to an exact version |
| **Token budget controls** | Mandatory budget config that refuses server start if unset, a pre-run estimate, a server-side block, a mid-run denial-of-wallet guard, a warning threshold, actual-vs-estimate reporting, and a read-only admin console whose every tab reconciles to one ledger |
| **Honest state** | `not measured` instead of `0/0`; unresolved `TBD [UNKNOWN]` blocks publication; no status string that contradicts the run state |
| **One engine** | Four artifact kinds (`document`, `structured_items`, `code_plan`, `report`) and six skills through a single code path. Agents are configuration |

## The six skills

| Skill | Agent | Kind | Writes to |
|---|---|---|---|
| Generate PRD | Product Manager · Nick Fury | `document` | Confluence |
| Generate User Stories | Product Owner · Maria Hill | `structured_items` | Jira |
| Generate HLD | Architect · Doctor Strange | `document` | Confluence |
| Generate LLD | Architect · Doctor Strange | `document` | Confluence |
| Implement Story | Developer · Spider-Man | `code_plan` | Pull-request proposal |
| Review Pull Request | Developer · Spider-Man | `report` (solo) | Confluence |

## Walk-through

[docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md) is a 12-step tour that exercises every gate and every
refusal path. Start there.

## Documents

| Document | What it is |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product requirements for the PoC |
| [docs/USER-STORIES.md](docs/USER-STORIES.md) | 16 stories with acceptance criteria and requirement IDs |
| [docs/HLD.md](docs/HLD.md) | High-level design, components and trust boundaries |
| [docs/LLD.md](docs/LLD.md) | Low-level design, interfaces, schema and algorithms |
| [docs/PR-REVIEWS.md](docs/PR-REVIEWS.md) | A review per story, including defects found and fixed |
| [docs/DEVIATIONS.md](docs/DEVIATIONS.md) | Every departure from v1.6, with its reason |
| [docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md) | The demonstration walk-through |

## Verify it

```powershell
node scripts/config-validate.js        # refuses to pass on unsafe config
node scripts/check-boundaries.js       # module import rules
node scripts/check-nonnegotiables.js   # hard-coded models, hex, path.resolve, git verbs
node tests/run-tests.js                # named tests, one per requirement
node tests/ui-check.js data/ui         # drives the real UI in Edge, fails on any console error
```

## Layout

```
config/     stages · agents · skills · councils · rubrics · templates · prompts · budget
server/     api · council (the engine) · providers · sandbox · integrations · security · persistence
web/        vanilla ES-module SPA; tokens.css is the only file with literal values
sample-repo/  the bundled Java service the Developer agent plans against
docs/       PRD · user stories · HLD · LLD · PR reviews · deviations · demo script
tests/      named requirement tests, two API smoke tests, the UI driver
```

## Cost

**Running the demo costs nothing.** The default provider transport is a deterministic fixture
that makes no model calls, so a full 3-writer / 9-review / captain run takes about 20 seconds
and spends £0. The premium-request and token figures the UI shows are metered from the model
registry's multipliers: the *spend* is simulated, the *accounting* is real, so the budget
controls are genuinely exercised.

To use real models instead:

```powershell
$env:JARVIS_MODEL_TRANSPORT = "bedrock"
# plus AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN in the environment
```

Note that a 3-writer council needs **three distinct model families** (FR-COUNCIL-004 / AM-01),
and only the Anthropic family is reachable over Bedrock on this workstation. The council will
refuse by name rather than silently substituting a model — which is the correct behaviour, and
the reason fixture is the default.

## What this PoC does not do

No skills package. No real Confluence, Jira or Bitbucket. No Copilot CLI over ACP. No container
sandbox. No multi-user, SSO or RBAC. 33 of the 39 R1 skills are absent. No knowledge bases —
which matters, because the pilot's ~70% accuracy came substantially from domain corpora rather
than from prompts (spec assumption A-09), so output here is generic-model quality by
construction.
