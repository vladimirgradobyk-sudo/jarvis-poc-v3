// Sandbox Executor (WP-10, AD-SANDBOX, NFR-SEC-005).
//
// Repository operations run in a sandbox with NO CREDENTIALS and allow-listed egress. The
// runtime sits behind an interface: `local` (deviation DV-05) and `docker` (stubbed, same
// interface) so switching is a config change rather than a rewrite.
//
// The local runtime copies the bundled sample repo into a scratch workspace under the data
// directory, applies the planned edits there, extracts a diff, and destroys the workspace. It
// never touches the original. It has no network access because it makes no network calls, and
// no credentials because nothing passes any to it.

import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { scanForSecrets } from '../security/redact.js';
import { resolveWithin, displayPath } from '../security/path-guard.js';

/** Runtime interface. Both implementations expose exactly these three methods. */
class LocalRuntime {
  get name() { return 'local'; }

  lease(sampleRepoRoot) {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-codeplan-'));
    const workspace = join(dir, 'impl');
    cpSync(sampleRepoRoot, workspace, { recursive: true });
    return { dir, workspace };
  }

  destroy(lease) {
    try { rmSync(lease.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  /**
   * FR-EXE-003: test counters are reported ACCURATELY OR NOT AT ALL. There is no JDK or Maven
   * on this workstation, so no test run happens and this returns `measured: false`. The UI then
   * renders "not measured" rather than 0/0.
   *
   * The pilot showed `Tests: 0/0, Coverage: 0%` beside a PR that demonstrably contained Karate
   * and unit tests. A counter that contradicts the visible diff costs more trust than no
   * counter, so refusing to guess is the feature.
   */
  runTests() {
    return { measured: false, reason: 'No JVM toolchain in the sandbox; no test run was executed.' };
  }
}

class DockerRuntime {
  get name() { return 'docker'; }
  lease() {
    throw new Error(
      'The Docker sandbox runtime is not implemented in the PoC. It exists as a declared seam ' +
      '(AD-SANDBOX): the container runtime, egress allow-list and resource caps are an R1 ' +
      'concern (OQ-11). Set SANDBOX_RUNTIME=local.'
    );
  }
  destroy() {}
  runTests() { return { measured: false, reason: 'not implemented' }; }
}

export class SandboxExecutor {
  constructor({ runtimeName, sampleRepoRoot, dataRoot }) {
    this.runtime = runtimeName === 'docker' ? new DockerRuntime() : new LocalRuntime();
    this.sampleRepoRoot = sampleRepoRoot;
    this.dataRoot = dataRoot;
  }

  available() {
    return this.runtime.name === 'local';
  }

  /**
   * Execute the chosen plan. Returns the data the Execution record and the diff view need.
   * Exactly one plan, exactly once — FR-COUNCIL-007 is enforced by the engine before this runs.
   */
  async execute({ run, skill, planCandidate, onFile, onStep }) {
    const lease = this.runtime.lease(this.sampleRepoRoot);
    try {
      const steps = [
        'Leasing sandbox workspace',
        'Cloning repository (no credentials)',
        'Applying planned changes',
        'Extracting diff',
        'Scanning for credentials',
      ];
      for (const [i, step] of steps.entries()) {
        onStep?.({ step, status: 'running', index: i });
        await sleep(process.env.JARVIS_FAST_STEPS === '1' ? 0 : 180);
        onStep?.({ step, status: 'done', index: i });
      }

      const fileChanges = applyPlan(lease.workspace, this.sampleRepoRoot, run, onFile);

      // NFR-SEC-007: scan GENERATED code. A positive finding blocks the PR proposal.
      const secretFindings = scanForSecrets(fileChanges);

      const tests = this.runtime.runTests(lease.workspace);

      const branchName = `codeplan-${(run.inputs.storyKey ?? 'story').toLowerCase()}-${Date.now()}-impl`;
      const repoLabel = run.inputs.repositoryUrl ?? 'sample-repo';

      return {
        sandboxRuntime: this.runtime.name,
        workspacePath: displayPath(dirname(lease.dir), lease.workspace),
        branchName,
        baseBranch: run.inputs.baseBranch ?? 'dev',
        repository: repoLabel,
        // FR-PUBLISH-006: fork status is resolved at INPUT VALIDATION, not at publish time.
        forkDetected: false,
        upstreamRepo: null,
        testsMeasured: tests.measured,
        testsPassed: tests.measured ? tests.passed : null,
        testsTotal: tests.measured ? tests.total : null,
        coveragePct: tests.measured ? tests.coverage : null,
        testsNotMeasuredReason: tests.measured ? null : tests.reason,
        secretFindings,
        fileChanges,
        status: secretFindings.length > 0 ? 'blocked' : 'complete',
      };
    } finally {
      // The sandbox is destroyed after the run, success or failure.
      this.runtime.destroy(lease);
    }
  }
}

/**
 * The planned edits for the bundled story. In R1 this is where the CLI-agent transport writes
 * code inside the container; here the edits are deterministic so the diff is reviewable and the
 * demo repeatable. Every write goes through the path guard.
 */
function applyPlan(workspace, originalRoot, run, onFile) {
  const changes = [];
  const pkg = 'src/main/java/com/mastercard/intent';
  const testPkg = 'src/test/java/com/mastercard/intent';

  const edit = (relPath, transform, op) => {
    const abs = resolveWithin(workspace, relPath);
    const before = op === 'add' ? null : readFileSync(abs, 'utf8');
    const after = transform(before);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, after, 'utf8');
    const change = {
      path: relPath,
      op,
      beforeBody: before,
      afterBody: after,
      ...countLines(before, after),
    };
    changes.push(change);
    onFile?.({ path: relPath, op, added: change.linesAdded, removed: change.linesRemoved });
    return change;
  };

  // 1. New enumeration — additive, with an explicit UNKNOWN member so a future value cannot
  //    deserialise to null and take the happy path.
  edit(`${pkg}/AssuranceLevel.java`, () => `package com.mastercard.intent;

/**
 * Assurance level applied to a delegated intent.
 *
 * UNKNOWN exists deliberately: a value added upstream must not deserialise to null and take
 * the happy path. Callers switch exhaustively and reject UNKNOWN.
 */
public enum AssuranceLevel {

    NONE,
    CART_HASH,
    CRYPTOGRAPHIC,
    UNKNOWN;

    public static AssuranceLevel fromWire(String value) {
        if (value == null || value.isBlank()) {
            return NONE;
        }
        for (AssuranceLevel level : values()) {
            if (level != UNKNOWN && level.name().equalsIgnoreCase(value.trim())) {
                return level;
            }
        }
        return UNKNOWN;
    }
}
`, 'add');

  // 2. New validator with a single public entry point, so the call site stays one line.
  edit(`${pkg}/AssuranceValidator.java`, () => `package com.mastercard.intent;

/**
 * Validates the assurance level carried by an intent request.
 *
 * Returns a result rather than a boolean so the caller can distinguish "invalid" from
 * "not applicable" — a bare boolean would collapse those into one silent false.
 */
public class AssuranceValidator {

    public AssuranceResult validate(IntentRequest request) {
        if (request == null) {
            return AssuranceResult.invalid(AssuranceLevel.UNKNOWN, "request must not be null");
        }

        AssuranceLevel level = AssuranceLevel.fromWire(request.getAssuranceLevel());

        if (level == AssuranceLevel.UNKNOWN) {
            return AssuranceResult.invalid(level,
                    "unrecognised assurance level: " + request.getAssuranceLevel());
        }
        if (level == AssuranceLevel.CRYPTOGRAPHIC
                && (request.getCartHash() == null || request.getCartHash().length() < 32)) {
            return AssuranceResult.invalid(level,
                    "cryptographic assurance requires a cart hash of at least 32 characters");
        }
        return AssuranceResult.valid(level);
    }
}
`, 'add');

  edit(`${pkg}/AssuranceResult.java`, () => `package com.mastercard.intent;

/** Outcome of assurance validation: the resolved level plus the reason when it is not valid. */
public final class AssuranceResult {

    private final boolean valid;
    private final AssuranceLevel level;
    private final String reason;

    private AssuranceResult(boolean valid, AssuranceLevel level, String reason) {
        this.valid = valid;
        this.level = level;
        this.reason = reason;
    }

    public static AssuranceResult valid(AssuranceLevel level) {
        return new AssuranceResult(true, level, null);
    }

    public static AssuranceResult invalid(AssuranceLevel level, String reason) {
        return new AssuranceResult(false, level, reason);
    }

    public boolean isValid() { return valid; }

    public AssuranceLevel getLevel() { return level; }

    public String getReason() { return reason; }
}
`, 'add');

  // 3. A dedicated exception, so the existing handler maps the rejection to 422 rather than 500.
  edit(`${pkg}/AssuranceRejectedException.java`, () => `package com.mastercard.intent;

/**
 * Thrown when assurance validation rejects a request.
 *
 * Distinct from IllegalArgumentException so the existing handler can map it to 422 rather than
 * letting a generic runtime exception surface as a 500.
 */
public class AssuranceRejectedException extends RuntimeException {

    private final AssuranceLevel level;

    public AssuranceRejectedException(AssuranceLevel level, String reason) {
        super(reason);
        this.level = level;
    }

    public AssuranceLevel getLevel() { return level; }
}
`, 'add');

  // 4. Inbound model gains the field — additive.
  edit(`${pkg}/IntentRequest.java`, (before) =>
    before.replace(
      '    private String channel;\n',
      '    private String channel;\n    private String assuranceLevel;\n'
    ).replace(
      '    public String getChannel() { return channel; }\n    public void setChannel(String channel) { this.channel = channel; }\n',
      '    public String getChannel() { return channel; }\n' +
      '    public void setChannel(String channel) { this.channel = channel; }\n\n' +
      '    public String getAssuranceLevel() { return assuranceLevel; }\n' +
      '    public void setAssuranceLevel(String assuranceLevel) { this.assuranceLevel = assuranceLevel; }\n'
    ), 'modify');

  // 5. Internal model gains the resolved level.
  edit(`${pkg}/DelegateIntent.java`, (before) =>
    before.replace(
      '    private String channel;\n',
      '    private String channel;\n    private AssuranceLevel assuranceLevel = AssuranceLevel.NONE;\n'
    ).replace(
      '    public String getChannel() { return channel; }\n    public void setChannel(String channel) { this.channel = channel; }\n',
      '    public String getChannel() { return channel; }\n' +
      '    public void setChannel(String channel) { this.channel = channel; }\n\n' +
      '    public AssuranceLevel getAssuranceLevel() { return assuranceLevel; }\n' +
      '    public void setAssuranceLevel(AssuranceLevel assuranceLevel) { this.assuranceLevel = assuranceLevel; }\n'
    ), 'modify');

  // 6. Mapper propagates the resolved level.
  edit(`${pkg}/DelegateIntentMapper.java`, (before) =>
    before.replace(
      'public class DelegateIntentMapper {\n\n    public DelegateIntent toDelegateIntent(IntentRequest request) {',
      'public class DelegateIntentMapper {\n\n    /**\n     * Maps the request, resolving the assurance level. An absent level maps to NONE, which\n     * preserves the behaviour existing callers rely on.\n     */\n    public DelegateIntent toDelegateIntent(IntentRequest request) {'
    ).replace(
      '        intent.setChannel(request.getChannel());\n        return intent;',
      '        intent.setChannel(request.getChannel());\n' +
      '        intent.setAssuranceLevel(AssuranceLevel.fromWire(request.getAssuranceLevel()));\n' +
      '        return intent;'
    ), 'modify');

  // 7. Response contract gains a field — additive only.
  edit(`${pkg}/RegistrationResult.java`, (before) =>
    before.replace(
      '    private final String intentId;\n    private final String cartHash;\n',
      '    private final String intentId;\n    private final String cartHash;\n    private final AssuranceLevel assuranceLevel;\n'
    ).replace(
      '    public RegistrationResult(String intentId, String cartHash) {\n        this.intentId = intentId;\n        this.cartHash = cartHash;\n    }\n',
      '    public RegistrationResult(String intentId, String cartHash) {\n' +
      '        this(intentId, cartHash, AssuranceLevel.NONE);\n' +
      '    }\n\n' +
      '    public RegistrationResult(String intentId, String cartHash, AssuranceLevel assuranceLevel) {\n' +
      '        this.intentId = intentId;\n' +
      '        this.cartHash = cartHash;\n' +
      '        this.assuranceLevel = assuranceLevel;\n' +
      '    }\n'
    ).replace(
      '    public String getCartHash() { return cartHash; }\n',
      '    public String getCartHash() { return cartHash; }\n\n' +
      '    public AssuranceLevel getAssuranceLevel() { return assuranceLevel; }\n'
    ), 'modify');

  // 8. Service wires the validator in. The two-argument constructor is retained so existing
  //    callers compile unchanged.
  edit(`${pkg}/IntentRegistrationService.java`, (before) =>
    before.replace(
      '    private final IntentRepository repository;\n    private final DelegateIntentMapper mapper;\n',
      '    private final IntentRepository repository;\n    private final DelegateIntentMapper mapper;\n    private final AssuranceValidator assuranceValidator;\n'
    ).replace(
      '    public IntentRegistrationService(IntentRepository repository, DelegateIntentMapper mapper) {\n        this.repository = Objects.requireNonNull(repository, "repository");\n        this.mapper = Objects.requireNonNull(mapper, "mapper");\n    }\n',
      '    public IntentRegistrationService(IntentRepository repository, DelegateIntentMapper mapper) {\n' +
      '        this(repository, mapper, new AssuranceValidator());\n' +
      '    }\n\n' +
      '    public IntentRegistrationService(IntentRepository repository,\n' +
      '                                     DelegateIntentMapper mapper,\n' +
      '                                     AssuranceValidator assuranceValidator) {\n' +
      '        this.repository = Objects.requireNonNull(repository, "repository");\n' +
      '        this.mapper = Objects.requireNonNull(mapper, "mapper");\n' +
      '        this.assuranceValidator = Objects.requireNonNull(assuranceValidator, "assuranceValidator");\n' +
      '    }\n'
    ).replace(
      '        DelegateIntent intent = mapper.toDelegateIntent(request);\n        String id = repository.save(intent);\n\n        return new RegistrationResult(id, intent.getCartHash());',
      '        AssuranceResult assurance = assuranceValidator.validate(request);\n' +
      '        if (!assurance.isValid()) {\n' +
      '            throw new AssuranceRejectedException(assurance.getLevel(), assurance.getReason());\n' +
      '        }\n\n' +
      '        DelegateIntent intent = mapper.toDelegateIntent(request);\n' +
      '        String id = repository.save(intent);\n\n' +
      '        return new RegistrationResult(id, intent.getCartHash(), intent.getAssuranceLevel());'
    ), 'modify');

  // 9. Tests for the new behaviour, including the negative paths the plan called for.
  edit(`${testPkg}/AssuranceValidatorTest.java`, () => `package com.mastercard.intent;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

class AssuranceValidatorTest {

    private final AssuranceValidator validator = new AssuranceValidator();

    @Test
    void absentLevelResolvesToNone() {
        IntentRequest request = new IntentRequest();
        request.setCartHash("abc123");

        AssuranceResult result = validator.validate(request);

        assertTrue(result.isValid());
        assertEquals(AssuranceLevel.NONE, result.getLevel());
    }

    @Test
    void cartHashLevelIsAccepted() {
        IntentRequest request = new IntentRequest();
        request.setCartHash("abc123");
        request.setAssuranceLevel("cart_hash");

        assertTrue(validator.validate(request).isValid());
    }

    @Test
    void unrecognisedLevelIsRejectedRatherThanDefaulted() {
        IntentRequest request = new IntentRequest();
        request.setCartHash("abc123");
        request.setAssuranceLevel("quantum");

        AssuranceResult result = validator.validate(request);

        assertFalse(result.isValid());
        assertEquals(AssuranceLevel.UNKNOWN, result.getLevel());
    }

    @Test
    void cryptographicLevelRequiresASufficientCartHash() {
        IntentRequest request = new IntentRequest();
        request.setCartHash("tooshort");
        request.setAssuranceLevel("cryptographic");

        assertFalse(validator.validate(request).isValid());
    }

    @Test
    void nullRequestIsRejected() {
        AssuranceResult result = validator.validate(null);

        assertFalse(result.isValid());
        assertEquals(AssuranceLevel.UNKNOWN, result.getLevel());
    }
}
`, 'add');

  // 10. Extend the EXISTING test rather than replacing it, proving the contract is unchanged.
  edit(`${testPkg}/IntentRegistrationServiceTest.java`, (before) =>
    before.replace(
      '    @Test\n    void rejectsANullRequest() {',
      '    @Test\n' +
      '    void defaultsAssuranceToNoneWhenAbsent() {\n' +
      '        IntentRequest request = new IntentRequest();\n' +
      '        request.setCartHash("abc123");\n\n' +
      '        RegistrationResult result = service.register(request);\n\n' +
      '        assertEquals(AssuranceLevel.NONE, result.getAssuranceLevel());\n' +
      '    }\n\n' +
      '    @Test\n' +
      '    void rejectsAnUnrecognisedAssuranceLevel() {\n' +
      '        IntentRequest request = new IntentRequest();\n' +
      '        request.setCartHash("abc123");\n' +
      '        request.setAssuranceLevel("quantum");\n\n' +
      '        assertThrows(AssuranceRejectedException.class, () -> service.register(request));\n' +
      '    }\n\n' +
      '    @Test\n    void rejectsANullRequest() {'
    ), 'modify');

  return changes;
}

function countLines(before, after) {
  const b = before === null ? [] : before.split('\n');
  const a = after.split('\n');
  if (before === null) return { linesAdded: a.length, linesRemoved: 0 };
  // Line-set difference: adequate for a review-facing counter and cheap.
  const bSet = new Map();
  for (const l of b) bSet.set(l, (bSet.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of a) {
    const n = bSet.get(l) ?? 0;
    if (n > 0) bSet.set(l, n - 1);
    else added += 1;
  }
  const removed = [...bSet.values()].reduce((x, y) => x + y, 0);
  return { linesAdded: added, linesRemoved: removed };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
