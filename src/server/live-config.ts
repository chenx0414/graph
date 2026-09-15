import { RuntimeError } from '../core/types.ts';
import type { ModelGrade } from '../catalog/models.ts';
import type { ConfiguredModel, GraphConfig } from './config.ts';

export interface ResolvedCredential {
  credentialId: string;
  apiKey: string;
  limit?: number;
  sharedGroupId?: string;
  groupLimit?: number;
}

interface Identity { canonical: string; limit?: number; sharedGroupId?: string; groupLimit?: number }

export interface LiveConfigState {
  revision: number;
  config: GraphConfig;
  directory: ConfiguredModel[];
  credentials: Map<string, ResolvedCredential>;
  resolvedCredentialIds: string[];
  masterModel: string | undefined;
  enabled: boolean;
  limitAliases: Record<string, string>;
  /** Present when the last candidate was rejected (aliases sharing a key with
   * conflicting groups); the effective state then stays at the previous one. */
  conflict?: string | undefined;
}

export interface ApplyResult { applied: boolean; reason?: string | undefined }

export interface LiveConfig {
  revision(): number;
  config(): GraphConfig;
  entries(): ConfiguredModel[];
  preferences(): Partial<Record<ModelGrade, string[]>>;
  credentialFor(entry: { id: string }): ResolvedCredential | undefined;
  masterModel(): string | undefined;
  defaultBudgetTokens(): number | null;
  enabled(): boolean;
  status(): { configured: boolean; modelCount: number; enabledModelCount: number; effectiveRevision: number; limitAliases: Record<string, string> };
  resolvedCredentialIds(): string[];
  /** Compute a candidate from the current secret view; a conflict keeps the
   * previous effective state and reports why instead of half-applying. */
  apply(config: GraphConfig, revision: number): ApplyResult;
  /** APP-supplied secret values override the environment for the same ref. */
  pushSecret(ref: string, value: string | null): ApplyResult;
  secrets(): Record<string, string>;
  snapshot(): LiveConfigState;
  subscribe(listener: () => void): () => void;
}

function mergedValue(config: GraphConfig, env: Record<string, string | undefined>, secrets: Record<string, string>, credentialId: string) {
  const credential = config.credentials[credentialId];
  if (!credential) return undefined;
  const pushed = secrets[credential.secretRef];
  const fromEnv = env[credential.secretRef]?.trim();
  const value = pushed ?? (fromEnv || undefined);
  return { secretRef: credential.secretRef, value };
}

/** Validate that aliases resolving to one actual key agree on their shared
 * group, using the same merged (pushed over env) secret view the runtime sees. */
function groupConflict(config: GraphConfig, env: Record<string, string | undefined>, secrets: Record<string, string>) {
  const byValue = new Map<string, string[]>();
  for (const id of Object.keys(config.credentials)) {
    const resolved = mergedValue(config, env, secrets, id);
    if (!resolved?.value) continue;
    byValue.set(resolved.value, [...(byValue.get(resolved.value) ?? []), id]);
  }
  for (const aliases of byValue.values()) {
    if (aliases.length < 2) continue;
    const sorted = [...aliases].sort();
    const groups = [...new Set(sorted.map(id => config.credentials[id]?.sharedLimitGroupId).filter((value): value is string => Boolean(value)))];
    if (groups.length > 1) {
      return new RuntimeError('invalid_config', `credentials.${sorted[0]}.sharedLimitGroupId: aliases resolving to one key must share one sharedLimitGroupId (${sorted.join(', ')})`);
    }
  }
  return undefined;
}

function compute(config: GraphConfig, revision: number, env: Record<string, string | undefined>, secrets: Record<string, string>): ApplyResult | { state: LiveConfigState } {
  const conflict = groupConflict(config, env, secrets);
  if (conflict) return { applied: false, reason: conflict.message };
  const entries = config.models?.entries ?? [];
  const bySecretValue = new Map<string, string[]>();
  for (const id of Object.keys(config.credentials)) {
    const resolved = mergedValue(config, env, secrets, id);
    if (!resolved?.value) continue;
    bySecretValue.set(resolved.value, [...(bySecretValue.get(resolved.value) ?? []), id]);
  }
  const identities = new Map<string, Identity>();
  for (const aliases of bySecretValue.values()) {
    const sorted = [...aliases].sort();
    const canonical = sorted[0]!;
    const caps = sorted.map(id => config.limits.credentials[id]).filter((value): value is number => value !== undefined);
    const groups = [...new Set(sorted.map(id => config.credentials[id]?.sharedLimitGroupId).filter((value): value is string => Boolean(value)))];
    const groupId = groups[0];
    const identity: Identity = {
      canonical,
      ...(caps.length ? { limit: Math.min(...caps) } : {}),
      ...(groupId ? { sharedGroupId: groupId } : {}),
      ...(groupId && config.limits.sharedGroups[groupId] !== undefined ? { groupLimit: config.limits.sharedGroups[groupId] } : {}),
    };
    for (const alias of sorted) identities.set(alias, identity);
  }
  const credentials = new Map<string, ResolvedCredential>();
  for (const entry of entries) {
    const resolved = mergedValue(config, env, secrets, entry.credentialId);
    if (!resolved?.value) continue;
    const identity = identities.get(entry.credentialId);
    if (!identity) continue;
    credentials.set(entry.id, {
      credentialId: identity.canonical,
      apiKey: resolved.value,
      ...(identity.limit !== undefined ? { limit: identity.limit } : {}),
      ...(identity.sharedGroupId ? { sharedGroupId: identity.sharedGroupId } : {}),
      ...(identity.groupLimit !== undefined ? { groupLimit: identity.groupLimit } : {}),
    });
  }
  const masterModel = entries.find(entry => credentials.has(entry.id))?.id;
  return {
    state: {
      revision,
      config,
      directory: entries,
      credentials,
      resolvedCredentialIds: [...bySecretValue.values()].flatMap(aliases => aliases),
      masterModel,
      enabled: entries.length > 0 && credentials.size > 0,
      limitAliases: Object.fromEntries([...identities.entries()].filter(([alias, identity]) => alias !== identity.canonical).map(([alias, identity]) => [alias, identity.canonical])),
    },
  };
}

function isState(result: ApplyResult | { state: LiveConfigState }): result is { state: LiveConfigState } {
  return 'state' in result;
}

/** Immutable-snapshot configuration owner for the daemon. A save either
 * activates a complete candidate or leaves the previous one effective. */
export function createLiveConfig(options: { env: Record<string, string | undefined>; log?: (line: string) => void; initial: { config: GraphConfig; revision: number }; secrets?: Record<string, string> }): LiveConfig {
  const env = options.env;
  const log = options.log ?? (() => {});
  let secrets = { ...(options.secrets ?? {}) };
  let state: LiveConfigState;
  const listeners = new Set<() => void>();
  const initial = compute(options.initial.config, options.initial.revision, env, secrets);
  state = isState(initial)
    ? initial.state
    : {
        revision: options.initial.revision, config: options.initial.config, directory: options.initial.config.models?.entries ?? [],
        credentials: new Map(), resolvedCredentialIds: [], masterModel: undefined, enabled: false,
        limitAliases: {}, ...(initial.reason ? { conflict: initial.reason } : {}),
      };
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const recompute = (config: GraphConfig, revision: number): ApplyResult => {
    const candidate = compute(config, revision, env, secrets);
    if (!isState(candidate)) {
      // Keep the previous effective state; the caller reports the pending reason.
      log(`Configuration not applied: ${candidate.reason}`);
      return { applied: false, reason: candidate.reason };
    }
    state = candidate.state;
    notify();
    return { applied: true };
  };
  return {
    revision: () => state.revision,
    config: () => state.config,
    entries: () => state.directory,
    preferences: () => state.config.models?.preferences ?? {},
    credentialFor: entry => state.credentials.get(entry.id),
    masterModel: () => state.masterModel,
    resolvedCredentialIds: () => state.resolvedCredentialIds,
    defaultBudgetTokens: () => state.config.limits.defaultBudgetTokens,
    enabled: () => state.enabled,
    status: () => ({
      configured: state.enabled,
      modelCount: state.directory.length,
      enabledModelCount: state.credentials.size,
      effectiveRevision: state.revision,
      limitAliases: state.limitAliases,
    }),
    apply: (config, revision) => recompute(config, revision),
    pushSecret: (ref, value) => {
      const previous = secrets[ref];
      if (value === null || value === '') delete secrets[ref];
      else secrets = { ...secrets, [ref]: value };
      const result = recompute(state.config, state.revision);
      if (!result.applied) {
        // The push must not corrupt the effective binding; restore the previous value.
        if (previous === undefined) delete secrets[ref];
        else secrets = { ...secrets, [ref]: previous };
      }
      return result;
    },
    secrets: () => ({ ...secrets }),
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
