# sample-repo — intent-orchestration-service (excerpt)

A deliberately small slice of a Java service, bundled so the **Implement Story** skill has a
real codebase to plan against and produce a genuine multi-file diff from.

It is a fixture, not a product. It is not built, not compiled and not run — the PoC sandbox
reads these files, applies the planned edits in an isolated copy, and extracts a diff.

```
src/main/java/com/mastercard/intent/
  IntentRegistrationService.java   ← the story's primary target
  DelegateIntentMapper.java        ← propagation point
  DelegateIntent.java              ← internal model
  IntentRequest.java               ← inbound model
  RegistrationResult.java          ← public response contract (additive changes only)
  IntentRepository.java            ← persistence boundary
src/test/java/com/mastercard/intent/
  IntentRegistrationServiceTest.java ← existing-behaviour tests
```

## Why these files

The planning council needs a codebase with the properties that make planning non-trivial:

- **Named existing callers** (`IntentController`, `BatchIntentLoader`) referenced in comments,
  so a plan must state whether their behaviour changes.
- **A public response contract** (`RegistrationResult`) where additive change is safe and
  mutation is not.
- **Existing tests** a change must not break.
- **An obvious extension seam** (the mapper) so a good plan extends rather than branches.

## Note on `git`

`git` is not installed on this workstation, and it would not be used here even if it were.
`AD-GIT` requires the SCM adapter to have *no push capability at all — "not a disabled one, an
absent one"*. The sandbox copies files; it never initialises a repository, and nothing is ever
committed or pushed. The output is a pull-request **proposal**.
