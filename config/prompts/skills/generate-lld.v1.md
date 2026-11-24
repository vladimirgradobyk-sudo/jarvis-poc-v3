---
id: generate-lld
version: 1
artifactKinds: [document]
channel: template
changelog: Initial.
---

# Task: Generate a Low-Level Design

Elaborate the supplied High-Level Design into an implementation-ready design.

- **Assume the HLD's component boundaries.** If you believe one is wrong, record it under open
  items — do not silently redesign it here. An LLD that contradicts its HLD is unreviewable.
- **Module Decomposition** states, per module, what it may import. A rule that exists only in
  prose will be broken; say how it is enforced.
- **Interface Contracts** give the shape, the validation, and the failure response. An endpoint
  without its error cases is half specified.
- **Key Algorithms** should be precise enough to implement without further decisions — thresholds,
  tie-breaks, and ordering included.
- **Error Handling** covers partial failure, not just failure. The interesting case is the one
  where half the work succeeded.
- **Test Design** maps each requirement to a named test.
- Anything not named in this document is out of its scope. Say that explicitly.
