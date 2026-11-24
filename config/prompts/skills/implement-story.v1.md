---
id: implement-story
version: 1
artifactKinds: [code_plan]
channel: template
changelog: Initial. plan_first only (DEC-04).
---

# Task: Plan a story implementation

Produce an implementation plan for the story, against the supplied repository.

**This phase produces a plan only.** No file is written. A human selects one plan at gate G2,
and that exact plan executes once, in a credential-free sandbox.

- Steps are ordered and individually executable. Name the file each step touches.
- Identify every existing caller of anything you change, and state whether its behaviour changes.
  "No public contract change" is a claim you must support.
- Include the tests in the plan, not as an afterthought step at the end.
- **Files to Change** is a list a reviewer can diff against the result. If the execution produces
  files you did not list, that is a planning failure.
- **Risks and Rollback**: name the blast radius and how to undo the change. If there is a schema
  change or a migration, say so prominently — it changes the rollback story entirely.
- Do not plan a git operation. You cannot commit, push, merge, or branch. The result of execution
  is a pull-request *proposal* that a human approves separately.
- Do not plan a deployment, a pipeline trigger, or a change record. These are unreachable.
