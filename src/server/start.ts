import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { RuntimeError } from '../core/types.ts';
import { emptyGraphConfig, loadGraphConfig, resolveCredentialSecret, type ConfiguredModel, type GraphConfig } from './config.ts';
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
  const enabled = entries.length > 0 && missing.size === 0;
  if (entries.length && missing.size) log(`Credentials not configured (${[...missing].join(', ')}); model dispatch stays disabled.`);
  const configStore = options.configPath ? await openConfigStore(options.configPath) : null;
  // Model id to credential mapping: one model can never inherit another model's key.
  const credentials = new Map<string, { credentialId: string; apiKey: string; limit?: number; sharedGroupId?: string; groupLimit?: number }>();
  for (const entry of entries) {
    const secret = resolveCredentialSecret(config, entry.credentialId, options.env);
    if (!secret.configured || !secret.value) continue;
    const groupId = config.credentials[entry.credentialId]?.sharedLimitGroupId;
    const limit = config.limits.credentials[entry.credentialId];
    const groupLimit = groupId ? config.limits.sharedGroups[groupId] : undefined;
    credentials.set(entry.id, {
      credentialId: entry.credentialId,
      apiKey: secret.value,
      ...(limit !== undefined ? { limit } : {}),
      ...(groupId ? { sharedGroupId: groupId } : {}),
      ...(groupLimit !== undefined ? { groupLimit } : {}),
    });
  }
  const credentialFor = (entry: ModelEntry) => credentials.get(entry.id);
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
    config: { revision: () => configStore?.revision() ?? 0 },
    autoDrive: options.mode === 'execute',
    port: options.port,
    webDir: options.webDir,
    startup: { mode: options.mode, configured: enabled, modelCount: entries.length, enabledModelCount: enabled ? entries.length : 0 },
    ...(configStore ? { configStore, configEnv: options.env } : {}),
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
