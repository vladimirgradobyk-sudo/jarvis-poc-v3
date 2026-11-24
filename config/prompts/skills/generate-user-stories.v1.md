---
id: generate-user-stories
version: 1
artifactKinds: [structured_items]
channel: template
changelog: Initial.
---

# Task: Decompose into user stories

Decompose the supplied source document into user stories for the named Jira project.

- Each story is **independently demonstrable**. If story 4 cannot be shown working without story
  5, they are one story or the sequence is wrong.
- Use the form *As a &lt;role&gt;, I want &lt;capability&gt;, so that &lt;outcome&gt;*. The
  *so that* clause must name a real benefit, not restate the capability.
- Every story carries acceptance criteria in Given / When / Then form. Criteria are the contract;
  vague criteria produce vague implementations.
- Stories trace to the source document. Name the section each story comes from.
- Do not exceed the requested story count. Splitting further is a decomposition decision for a
  human, not a way to look thorough.
- Every story needs an owner. An unassigned work item is a defect, not a default — the assignee
  from the inputs applies to all of them unless the source says otherwise.
