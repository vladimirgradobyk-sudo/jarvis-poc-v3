---
id: review-pull-request
version: 1
artifactKinds: [report]
channel: template
changelog: Initial. Solo run — writers: 1, no review, no captain.
---

# Task: Review a pull-request proposal

Review the supplied change against the story it claims to implement.

- Start from the story's acceptance criteria. For each one, say whether the diff satisfies it.
  A change that is clean but incomplete against its story is a `[HIGH]` finding.
- Then review the diff on its own terms: correctness, reachable untested paths, error handling,
  interface misuse, and anything logged that should not be.
- Order findings by severity, most severe first. Each finding states the file, what is wrong, and
  what to do about it.
- **Test Assessment** is a separate section because it is the thing reviewers skip. Say what is
  covered, what is reachable but uncovered, and what cannot be tested as written.
- **Recommendation** is one of: approve, approve with comments, or request changes. Say which, and
  name the specific blocking items if any.

## Honesty

Test and coverage figures are **not measured** unless you were given the output of a real test
run. Never substitute a zero. Your report is provisional and will be published with a banner
saying it must be evaluated by qualified personnel before anyone acts on it.
