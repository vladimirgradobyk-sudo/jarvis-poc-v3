---
id: generate-prd
version: 1
artifactKinds: [document]
channel: template
changelog: Initial.
---

# Task: Generate a Product Requirement Document

Produce a PRD for the epic named in the inputs, following the supplied template exactly.

- The **Problem Statement** describes today, not the solution. If you find yourself naming a
  component, you have drifted into design.
- **Functional Requirements** are testable statements. "The system shall be user-friendly" is
  not one. Each should be verifiable by someone who did not write it.
- **Success Metrics** must be measurable from something that exists or that this epic creates.
  A metric with no source of truth is an aspiration.
- **Scope** must state exclusions explicitly. A PRD that only says what is in scope will be read
  as promising everything else too.
- The epic key supplied in the inputs is the Traceability ID. Reference it in the document so the
  trace graph can anchor to it.
