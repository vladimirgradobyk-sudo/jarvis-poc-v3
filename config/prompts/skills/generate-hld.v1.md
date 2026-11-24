---
id: generate-hld
version: 1
artifactKinds: [document]
channel: template
changelog: Initial.
---

# Task: Generate a High-Level Design

Produce an HLD for the epic, elaborating the supplied PRD into a solution shape.

- **Component Design** names responsibilities, not technologies. A component that "handles
  everything about X" has no boundary.
- **Integration Design** must state, per external call, what happens on timeout, on partial
  success, and on the ambiguous case where you cannot tell whether the remote system committed.
- **Security Design** enumerates trust boundaries and gives each one a named control. A general
  assurance that data is "secured in transit" is not a control.
- **NFR Considerations** states each target with its measurement. Where a target has not been
  agreed, say so rather than proposing one that will be read as agreed.
- **Alternatives Considered** must contain at least one option you rejected and why. A design
  with no rejected alternative has not been designed.
- Do not specify a concrete third-party API shape that was not supplied. Describe the adapter
  interface and mark the endpoint as to be confirmed.
