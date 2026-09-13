import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { RuntimeError } from '../core/types.ts';
import { assertCredentialGroups, emptyGraphConfig, loadGraphConfig, resolveCredentialSecret, type ConfiguredModel, type GraphConfig } from './config.ts';
import { openConfigStore } from './config-service.ts';
import { openGraphServer } from './host.ts';
import type { ModelEntry } from '../catalog/models.ts';

export interface DaemonOptions {
  /** Explicit config path; null starts in first-run mode with no projects or models. */
  configPath: string | null;
  stateDir: string;
  webDir: string;
  port: number;
  mode: 'view' | 'execute';
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export interface GraphDaemon {
  url: string;
  stateDir: string;
  webDir: string;
  configPath: string | null;
  mode: 'view' | 'execute';
  /** True when at least one model is configured and all its credentials resolved. */
  configured: boolean;
  modelCount: number;
  enabledModelCount: number;
  server: Awaited<ReturnType<typeof openGraphServer>>;
  close(): Promise<void>;
}

function piModel(entry: ConfiguredModel): Model<'openai-completions'> {
  return {
    id: entry.id,
    name: entry.id,
    provider: entry.provider,
    api: 'openai-completions',
    baseUrl: entry.baseUrl,
    reasoning: false,
    input: ['text'],
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    cost: entry.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(entry.headers ? { headers: entry.headers } : {}),
  };
}

/** Group model entries by provider; sharing a provider means the same endpoint
 * and the same credential, so one registered transport is unambiguous. */
function providerGroups(entries: ConfiguredModel[]) {
  const groups = new Map<string, { baseUrl: string; credentialId: string; entries: ConfiguredModel[] }>();
  for (const entry of entries) {
    const group = groups.get(entry.provider);
    if (!group) {
      groups.set(entry.provider, { baseUrl: entry.baseUrl, credentialId: entry.credentialId, entries: [entry] });
      continue;
    }
    if (group.baseUrl !== entry.baseUrl) throw new RuntimeError('invalid_config', `Models for provider "${entry.provider}" must share one baseUrl`);
    if (group.credentialId !== entry.credentialId) throw new RuntimeError('invalid_config', `Models for provider "${entry.provider}" must share one credentialId`);
    group.entries.push(entry);
  }
  return groups;
}

function missingSecrets(config: GraphConfig, entries: ConfiguredModel[], env: Record<string, string | undefined>) {
  const missing = new Set<string>();
  for (const group of providerGroups(entries).values()) {
    const secret = resolveCredentialSecret(config, group.credentialId, env);
    if (!secret.configured && secret.secretRef) missing.add(secret.secretRef);
  }
  return missing;
}

/** Start the console daemon: validate the web build, load configuration, open
 * the runtime on an explicit state directory and serve on loopback only. */
export async function startGraphDaemon(options: DaemonOptions): Promise<GraphDaemon> {
  const log = options.log ?? (() => {});
  const index = join(options.webDir, 'index.html');
  if (!existsSync(index)) {
    throw new RuntimeError('web_build_missing', `Web build not found at ${index}. Build the console first: pnpm build:web (without pnpm: node --run build:web)`);
  }
  const config = options.configPath ? await loadGraphConfig(options.configPath) : emptyGraphConfig();
  const entries = config.models?.entries ?? [];
  if (options.mode === 'execute' && !entries.length) {
    throw new RuntimeError('models_missing', 'Execution mode requires a config with at least one model entry; start view-only or configure a model first');
  }
  const missing = missingSecrets(config, entries, options.env);
  if (missing.size && options.mode === 'execute') {
    throw new RuntimeError('credentials_missing', `Execution mode requires configured credentials; set: ${[...missing].join(', ')}`);
  }
  // A conflicting hand-edited config must not prevent the console from
  // starting; execute mode still refuses it instead of guessing limits.
  let groupConflict: RuntimeError | undefined;
  try { assertCredentialGroups(config, options.env); }
  catch (error) { groupConflict = error as RuntimeError; }
  if (groupConflict && options.mode === 'execute') throw groupConflict;
  if (groupConflict) log(`Config problem (${groupConflict.message}); model dispatch stays disabled.`);
  const enabled = entries.length > 0 && missing.size === 0 && !groupConflict;
  if (entries.length && missing.size) log(`Credentials not configured (${[...missing].join(', ')}); model dispatch stays disabled.`);
  const configStore = options.configPath ? await openConfigStore(options.configPath) : null;
  // The running daemon keeps the bindings it was started with; a saved file
  // revision only takes effect after a restart.
  const effectiveRevision = configStore?.revision() ?? 0;
  // Credential aliases that resolve to the same actual key must share one
  // scheduling identity; the alias names themselves stay in the config and are
  // never replaced by secret material.
  const bySecretValue = new Map<string, string[]>();
  for (const id of Object.keys(config.credentials)) {
    const secret = resolveCredentialSecret(config, id, options.env);
    if (!secret.configured || !secret.value) continue;
    bySecretValue.set(secret.value, [...(bySecretValue.get(secret.value) ?? []), id]);
  }
  const identities = new Map<string, { canonical: string; limit?: number; sharedGroupId?: string; groupLimit?: number }>();
  for (const aliases of groupConflict ? [] : bySecretValue.values()) {
    const sorted = [...aliases].sort();
    const canonical = sorted[0]!;
    const caps = sorted.map(id => config.limits.credentials[id]).filter((value): value is number => value !== undefined);
    const groups = [...new Set(sorted.map(id => config.credentials[id]?.sharedLimitGroupId).filter((value): value is string => Boolean(value)))];
    const groupId = groups[0];
    const identity = {
      canonical,
      ...(caps.length ? { limit: Math.min(...caps) } : {}),
      ...(groupId ? { sharedGroupId: groupId } : {}),
      ...(groupId && config.limits.sharedGroups[groupId] !== undefined ? { groupLimit: config.limits.sharedGroups[groupId] } : {}),
    };
    for (const alias of sorted) identities.set(alias, identity);
    if (sorted.length > 1) log(`Credential aliases ${sorted.join(', ')} resolve to the same key; scheduling as "${canonical}" with the strictest limit.`);
  }

  // Model id to credential mapping: one model can never inherit another model's key.
  const credentials = new Map<string, { credentialId: string; apiKey: string; limit?: number; sharedGroupId?: string; groupLimit?: number }>();
  for (const entry of entries) {
    const secret = resolveCredentialSecret(config, entry.credentialId, options.env);
    if (!secret.configured || !secret.value) continue;
    const identity = identities.get(entry.credentialId);
    if (!identity) continue;
    credentials.set(entry.id, {
      credentialId: identity.canonical,
      apiKey: secret.value,
      ...(identity.limit !== undefined ? { limit: identity.limit } : {}),
      ...(identity.sharedGroupId ? { sharedGroupId: identity.sharedGroupId } : {}),
      ...(identity.groupLimit !== undefined ? { groupLimit: identity.groupLimit } : {}),
    });
  }
  const credentialFor = (entry: ModelEntry) => credentials.get(entry.id);
  const limitAliases = Object.fromEntries([...identities.entries()].filter(([alias, identity]) => alias !== identity.canonical).map(([alias, identity]) => [alias, identity.canonical]));
  const limitSummary = [...new Set([...credentials.values()].map(binding => {
    const parts = [binding.limit !== undefined ? `${binding.credentialId} ≤${binding.limit}` : null, binding.groupLimit !== undefined ? `组 ${binding.sharedGroupId} ≤${binding.groupLimit}` : null].filter(Boolean);
    return parts.join(', ');
  }).filter(Boolean))];
  if (limitSummary.length) log(`Concurrency limits: ${limitSummary.join('; ')}`);

  let modelRuntime: ModelRuntime | undefined;
  if (enabled) {
    modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: true, refreshOnCreate: false });
    for (const [provider, group] of providerGroups(entries)) {
      const secret = resolveCredentialSecret(config, group.credentialId, options.env);
      modelRuntime.registerProvider(provider, { baseUrl: group.baseUrl, api: 'openai-completions', apiKey: secret.value!, models: group.entries.map(piModel) });
    }
  }

  // Explicit connectivity check. Only runs when the settings page asks for it;
  // ordinary config reads and saves never touch a provider.
  const testConnection = async (modelId: string) => {
    const entry = config.models?.entries.find(model => model.id === modelId);
    if (!entry) throw new RuntimeError('not_found', `Unknown model ${modelId}`);
    const secret = resolveCredentialSecret(config, entry.credentialId, options.env);
    if (!secret.configured) return { ok: false, model: entry.id, credentialId: entry.credentialId, message: `Credential not configured: ${secret.secretRef}` };
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${entry.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret.value}`, ...entry.headers },
        body: JSON.stringify({ model: entry.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
        signal: controller.signal,
      });
      const ok = response.status >= 200 && response.status < 300;
      await response.body?.cancel();
      return { ok, model: entry.id, credentialId: entry.credentialId, status: response.status, latencyMs: Date.now() - started, ...(ok ? {} : { message: `HTTP ${response.status}` }) };
    } catch (error) {
      return { ok: false, model: entry.id, credentialId: entry.credentialId, latencyMs: Date.now() - started, message: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  };
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(options.stateDir);
  const first = enabled ? entries[0]! : null;
  const server = await openGraphServer({
    stateDir,
    projects: config.projects,
    ...(enabled && modelRuntime ? {
      models: {
        entries,
        preferences: config.models!.preferences,
        apiKey: credentials.get(first!.id)?.apiKey ?? '',
        modelRuntime,
        credentialFor,
      },
      master: { action: 'master', definitionVersion: 'master@1', model: first!.id },
    } : {}),
    config: { revision: () => effectiveRevision },
    autoDrive: options.mode === 'execute',
    port: options.port,
    webDir: options.webDir,
    startup: {
      mode: options.mode, configured: enabled, modelCount: entries.length, enabledModelCount: enabled ? entries.length : 0,
      effectiveRevision, ...(Object.keys(limitAliases).length ? { limitAliases } : {}),
    },
    ...(configStore ? { configStore, configEnv: options.env, configTest: testConnection } : {}),
  });
  if (enabled) {
    server.runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
    server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
    server.runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  }
  return {
    url: server.url,
    stateDir,
    webDir: options.webDir,
    configPath: config.path,
    mode: options.mode,
    configured: enabled,
    modelCount: entries.length,
    enabledModelCount: enabled ? entries.length : 0,
    server,
    async close() { await server.close(); },
  };
}
