// Model registry (AD-MODEL, FR-MODEL-001..005).
//
// THE ONE PLACE a model identifier is resolved and the ONE PLACE a display name is produced
// (repo-scaffold §4.2 chokepoint table). The pilot showed the same model as "Opus 4.5",
// "CLAUDE-OPUS-4-5" and "claude-opus-4-5" in a single flow and — worse — a writer configured
// as "Sonnet 4.5" resolved and reported as "claude-sonnet-4-6". Display name and resolved
// model must never disagree.

import { fixtureTransport } from './transports/fixture.transport.js';
import { bedrockTransport } from './transports/bedrock.transport.js';

export class ModelError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export class ModelRegistry {
  constructor(registryConfig, transportName) {
    this.entries = new Map(registryConfig.entries.map((e) => [e.id, e]));
    this.logical = new Map(registryConfig.logicalModels.map((l) => [l.id, l]));
    this.transportName = transportName;
    this.transport = transportName === 'bedrock' ? bedrockTransport : fixtureTransport;
  }

  /** Resolve logical → concrete. Records exactly what was resolved, for provenance. */
  resolve(logicalId) {
    const lm = this.logical.get(logicalId);
    if (!lm) {
      throw new ModelError('model_unavailable', `Unknown logical model "${logicalId}".`, { logicalId });
    }
    const entry = this.entries.get(lm.defaultEntryId);
    if (!entry) {
      throw new ModelError('model_unavailable',
        `Logical model "${logicalId}" points at missing registry entry "${lm.defaultEntryId}".`, { logicalId });
    }
    // FR-MODEL-004: an unavailable model is BLOCKED with a named alternative.
    if (entry.status === 'unavailable') {
      const alt = entry.replacedBy ? this.entries.get(entry.replacedBy) : null;
      throw new ModelError('model_unavailable',
        `${entry.displayName} is unavailable.` + (alt ? ` Use ${alt.displayName} instead.` : ''),
        { replacedBy: entry.replacedBy ?? null });
    }
    // The Bedrock transport can only reach entries that declare a Bedrock model id. Degrading
    // VISIBLY beats silently substituting a different model than the one displayed.
    if (this.transportName === 'bedrock' && !entry.bedrockModelId) {
      const alt = [...this.entries.values()].find((e) => e.bedrockModelId && e.status === 'available');
      throw new ModelError('model_unavailable',
        `${entry.displayName} is not reachable over the Bedrock transport.` +
        (alt ? ` ${alt.displayName} is. Change the writer's model or switch JARVIS_MODEL_TRANSPORT to "fixture".` : ''),
        { logicalId, entryId: entry.id, replacedBy: alt?.id ?? null });
    }

    return {
      logicalModel: logicalId,
      entryId: entry.id,
      resolvedModel: this.transportName === 'bedrock' ? entry.bedrockModelId : entry.id,
      displayName: entry.displayName,          // canonical, single source (FR-MODEL-003)
      family: entry.family,                    // AM-01: family drives distinctness
      provider: entry.provider,
      contextWindow: entry.contextWindow,
      multiplier: entry.premiumRequestMultiplier,
      status: entry.status,
      deprecated: entry.status === 'deprecated',
      replacedBy: entry.replacedBy ?? null,
      fixtureVoice: entry.fixtureVoice,
    };
  }

  /** Grouped by provider, newest first, for the ModelSelect combobox. */
  pickerOptions() {
    const groups = new Map();
    for (const lm of this.logical.values()) {
      if (lm.policyFixed) continue;   // DEC-15: the Captain model is not user-selectable
      let resolved;
      try { resolved = this.resolve(lm.id); } catch { continue; }
      const key = resolved.provider;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        logicalModel: lm.id,
        label: resolved.displayName + (resolved.deprecated ? ' (deprecated)' : ''),
        displayName: resolved.displayName,
        family: resolved.family,
        multiplier: resolved.multiplier,
        contextWindow: resolved.contextWindow,
        deprecated: resolved.deprecated,
        replacedByDisplayName: resolved.replacedBy ? this.entries.get(resolved.replacedBy)?.displayName : null,
      });
    }
    return [...groups.entries()].map(([provider, options]) => ({ provider, options }));
  }

  /**
   * Captain model options for the Configure screen. DEMO DEVIATION from DEC-15 / AM-10, which fix
   * the Captain model by policy: here it is selectable. The policy-fixed default is included and
   * flagged so a reviewer can see what the policy would have chosen.
   */
  captainPickerOptions() {
    const groups = new Map();
    for (const lm of this.logical.values()) {
      let resolved;
      try { resolved = this.resolve(lm.id); } catch { continue; }
      const key = resolved.provider;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        logicalModel: lm.id,
        label: resolved.displayName + (lm.policyFixed ? ' · policy default' : ''),
        displayName: resolved.displayName,
        family: resolved.family,
        policyFixed: !!lm.policyFixed,
      });
    }
    return [...groups.entries()].map(([provider, options]) => ({ provider, options }));
  }

  /** Read-only registry view for the Settings screen (FR-MODEL-002). */
  table() {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      logicalNames: [...this.logical.values()].filter((l) => l.defaultEntryId === e.id).map((l) => l.id),
      provider: e.provider,
      family: e.family,
      displayName: e.displayName,
      contextWindow: e.contextWindow,
      multiplier: e.premiumRequestMultiplier,
      capabilities: e.capabilities,
      status: e.status,
      replacedBy: e.replacedBy ?? null,
      reachableOnTransport: this.transportName === 'bedrock' ? !!e.bedrockModelId : true,
    }));
  }
}

/**
 * FR-COUNCIL-004 + AM-01. `requireDistinctModels` rejects a selection in which two writers
 * resolve to the same model FAMILY, with an actionable error NAMING BOTH.
 *
 * AM-01 is why this checks family rather than model id: two different Anthropic models are not
 * a diverse council. Correlated errors defeat the entire review mechanism, so this is a
 * correctness rule, not a preference.
 */
export function checkDistinctFamilies(selection) {
  const byFamily = new Map();
  for (const w of selection) {
    if (!byFamily.has(w.family)) byFamily.set(w.family, []);
    byFamily.get(w.family).push(w);
  }
  for (const [family, writers] of byFamily) {
    if (writers.length < 2) continue;
    const [a, b] = writers;
    return {
      ok: false,
      code: 'duplicate_model',
      message:
        `Duplicate model family: ${a.displayName ?? a.profileId} and ${b.displayName ?? b.profileId} ` +
        `both resolve to the ${family} family (${a.modelDisplayName} and ${b.modelDisplayName}). ` +
        `Council requires distinct families — change one.`,
      detail: {
        family,
        conflicts: writers.map((w) => ({
          writerProfileId: w.profileId,
          writerDisplayName: w.displayName,
          logicalModel: w.logicalModel,
          resolvedModel: w.resolvedModel,
          modelDisplayName: w.modelDisplayName,
          family: w.family,
        })),
      },
    };
  }
  return { ok: true };
}
