import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { RuntimeError } from '../core/types.ts';
import { emptyGraphConfig, loadGraphConfig, resolveCredentialSecret, type ConfiguredModel, type GraphConfig } from './config.ts';
import { openConfigStore } from './config-service.ts';
import { createLiveConfig, type LiveConfig } from './live-config.ts';
import { installPresets } from '../catalog/presets.ts';
import { createModelScheduler } from '../runtime/model-scheduler.ts';
import { openGraphServer } from './host.ts';

export interface DaemonOptions {
  /** Explicit config path; null starts in first-run mode with no projects or models. */
  configPath: string | null;
  stateDir: string;
  webDir: string;
  port: number;
  mode: 'view' | 'execute';
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
  /** Permit execute intent before any model resolves; the APP applies the
   * configuration live. The CLI keeps the strict startup errors. */
  dynamic?: boolean;
  /** Built-in preset pack directory; defaults to the repository `presets/`. */
  presetsDir?: string;
}

export interface ApplyConfigResult {
  revision: number;
  effectiveRevision: number;
  applied: boolean;
  reason?: string | undefined;
  configured: boolean;
  modelCount: number;
  enabledModelCount: number;
}

export interface GraphDaemon {
  url: string;
  stateDir: string;
  webDir: string;
  configPath: string | null;
  mode: 'view' | 'execute';
  /** True when at least one configured model has a resolved credential. */
  configured: boolean;
  modelCount: number;
  enabledModelCount: number;
  /** Random local token read from <stateDir>/app-token; guards the APP bridge. */
  appToken: string;
  server: Awaited<ReturnType<typeof openGraphServer>>;
  applyConfig(document: unknown, expectedRevision: number): Promise<ApplyConfigResult>;
  pushSecret(ref: string, value: string | null): Promise<ApplyConfigResult>;
  close(): Promise<void>;
}

function piModel(entry: ConfiguredModel): Model<ConfiguredModel['api']> {
  return {
    id: entry.id,
    name: entry.id,
    provider: entry.provider,
    api: entry.api,
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
  const groups = new Map<string, { baseUrl: string; credentialId: string; api: ConfiguredModel['api']; entries: ConfiguredModel[] }>();
  for (const entry of entries) {
    const group = groups.get(entry.provider);
    if (!group) {
      groups.set(entry.provider, { baseUrl: entry.baseUrl, credentialId: entry.credentialId, api: entry.api, entries: [entry] });
      continue;
    }
    if (group.baseUrl !== entry.baseUrl) throw new RuntimeError('invalid_config', `Models for provider "${entry.provider}" must share one baseUrl`);
    if (group.credentialId !== entry.credentialId) throw new RuntimeError('invalid_config', `Models for provider "${entry.provider}" must share one credentialId`);
    if (group.api !== entry.api) throw new RuntimeError('invalid_config', `Models for provider "${entry.provider}" must share one api`);
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
 * the runtime on an explicit state directory and serve on loopback only.
 *
 * With `dynamic: true` (the desktop APP) the daemon may start with execute
 * intent before any model resolves; later config/secret applies activate the
 * bindings on the same process. The CLI keeps the strict startup checks. */
export async function startGraphDaemon(options: DaemonOptions): Promise<GraphDaemon> {
  const log = options.log ?? (() => {});
  const index = join(options.webDir, 'index.html');
  if (!existsSync(index)) {
    throw new RuntimeError('web_build_missing', `Web build not found at ${index}. Build the console first: pnpm build:web (without pnpm: node --run build:web)`);
  }
  const config = options.configPath ? await loadGraphConfig(options.configPath) : emptyGraphConfig();
  const configStore = options.configPath ? await openConfigStore(options.configPath) : null;
  // Explicit revocations survive a restart: the APP may re-inject a keychain
  // value into the environment, but a disabled connection must stay disabled.
  const revokedPath = join(options.stateDir, 'revoked-secrets.json');
  const revokedRefs = await readFile(revokedPath, 'utf8').then((text: string) => {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((ref): ref is string => typeof ref === 'string') : [];
  }).catch(() => [] as string[]);
  const live: LiveConfig = createLiveConfig({ env: options.env, log, initial: { config, revision: configStore?.revision() ?? 0 }, revoked: revokedRefs });
  const entries = live.entries();
  const conflict = live.snapshot().conflict;

  if (!options.dynamic) {
    if (options.mode === 'execute' && !entries.length) {
      throw new RuntimeError('models_missing', 'Execution mode requires a config with at least one model entry; start view-only or configure a model first');
    }
    if (conflict && options.mode === 'execute') throw new RuntimeError('invalid_config', conflict);
    if (options.mode === 'execute' && entries.length && live.resolvedCredentialIds().length === 0) {
      const missing = missingSecrets(config, entries, options.env);
      throw new RuntimeError('credentials_missing', `Execution mode requires at least one configured credential; set: ${[...missing].join(', ')}`);
    }
  }
  if (conflict) log(`Config problem (${conflict}); model dispatch stays disabled.`);
  const missing = missingSecrets(config, entries, options.env);
  if (entries.length && missing.size) {
    log(live.enabled()
      ? `Credentials not configured (${[...missing].join(', ')}); those models stay disabled.`
      : `Credentials not configured (${[...missing].join(', ')}); model dispatch stays disabled.`);
  }

  const scheduler = createModelScheduler();
  let modelRuntime: ModelRuntime | undefined;
  let definitionsPublished = false;
  const ensureModelRuntime = async () => {
    if (!modelRuntime) {
      modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: true, refreshOnCreate: false });
    }
    return modelRuntime;
  };
  const syncProviders = async () => {
    if (!options.dynamic && !live.enabled()) return;
    const runtime = await ensureModelRuntime();
    for (const [provider, group] of providerGroups(live.entries())) {
      const binding = live.credentialFor(group.entries[0]!);
      if (!binding) continue;
      // Re-registering the same provider name replaces its endpoint/key, so a
      // saved rotation applies to the next session opened for this provider.
      runtime.registerProvider(provider, { baseUrl: group.baseUrl, api: group.api, apiKey: binding.apiKey, models: group.entries.map(piModel) });
    }
  };
  await syncProviders();

  const activateDispatch = (server: Awaited<ReturnType<typeof openGraphServer>>) => {
    // View-only CLI intent never starts dispatching because a config was saved.
    if (options.mode !== 'execute' && !options.dynamic) return;
    server.startDrive();
    server.runtime.host.recoverMasters();
  };
  // Replaced after the server exists: preset-driven definitions replace the
  // minimal built-ins when the pack is available.
  let presetsAvailable = false;
  let publishDefinitions = () => {};

  // Explicit connectivity check. Only runs when the settings page asks for it;
  // ordinary config reads and saves never touch a provider.
  const testConnection = async (modelId: string) => {
    const entry = live.entries().find(model => model.id === modelId);
    if (!entry) throw new RuntimeError('not_found', `Unknown model ${modelId}`);
    const binding = live.credentialFor(entry);
    if (!binding) return { ok: false, model: entry.id, credentialId: entry.credentialId, message: `Credential not configured: ${entry.credentialId}` };
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const anthropic = entry.api === 'anthropic-messages';
    try {
      const response = await fetch(`${entry.baseUrl.replace(/\/$/, '')}${anthropic ? '/messages' : '/chat/completions'}`, {
        method: 'POST',
        headers: anthropic
          ? { 'content-type': 'application/json', 'x-api-key': binding.apiKey, 'anthropic-version': '2023-06-01', ...entry.headers }
          : { 'content-type': 'application/json', authorization: `Bearer ${binding.apiKey}`, ...entry.headers },
        body: JSON.stringify({ model: entry.modelId ?? entry.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
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
  const appToken = randomUUID();
  await writeFile(join(stateDir, 'app-token'), `${appToken}\n`, { mode: 0o600 });

  const runtimeReady = await ensureModelRuntime();
  const server = await openGraphServer({
    stateDir,
    projects: config.projects,
    models: {
      entries: live.entries(),
      preferences: live.preferences(),
      apiKey: '',
      modelRuntime: runtimeReady,
      modelScheduler: scheduler,
      credentialFor: entry => live.credentialFor(entry),
    },
    live: {
      revision: () => live.revision(),
      entries: () => live.entries(),
      preferences: () => live.preferences(),
      credentialFor: entry => live.credentialFor(entry),
      masterModel: () => live.masterModel(),
      defaultBudgetTokens: () => live.defaultBudgetTokens(),
      projects: () => live.projects(),
    },
    master: { action: 'master', definitionVersion: 'master@1', model: () => live.masterModel() },
    limits: { defaultBudgetTokens: live.defaultBudgetTokens() },
    config: { revision: () => live.revision() },
    autoDrive: options.mode === 'execute' || options.dynamic === true,
    port: options.port,
    webDir: options.webDir,
    startupInfo: () => ({
      mode: options.mode, configured: live.enabled(), modelCount: live.entries().length,
      enabledModelCount: live.status().enabledModelCount, effectiveRevision: live.revision(),
      ...(Object.keys(live.status().limitAliases).length ? { limitAliases: live.status().limitAliases } : {}),
    }),
    ...(configStore ? { configStore, configEnv: options.env, configTest: testConnection } : {}),
    appServices: {
      applyConfig: (document, expectedRevision) => applyConfig(document, expectedRevision),
      pushSecret: (ref, value) => pushSecret(ref, value),
      appToken,
      snapshot: () => ({
        revision: live.revision(), effectiveRevision: live.revision(), applied: true,
        configured: live.enabled(), modelCount: live.entries().length, enabledModelCount: live.status().enabledModelCount,
      }),
    },
  });
  const presetResult = await installPresets(
    server.runtime.catalog,
    options.presetsDir ?? fileURLToPath(new URL('../../presets', import.meta.url)),
    log,
  );
  presetsAvailable = presetResult.available;
  publishDefinitions = () => {
    if (presetsAvailable || definitionsPublished || !live.enabled()) return;
    definitionsPublished = true;
    server.runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
    server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
    server.runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  };
  publishDefinitions();
  if (presetsAvailable) log(`Presets: ${presetResult.installed.length} installed, ${presetResult.skipped.length} unchanged${presetResult.failed.length ? `, ${presetResult.failed.length} failed` : ''}.`);

  const applyConfig = async (document: unknown, expectedRevision: number): Promise<ApplyConfigResult> => {
    if (!configStore) throw new RuntimeError('invalid_config', 'The daemon was started without a configuration file');
    // Validate against the merged view (env + APP-pushed secrets - revoked
    // refs) and approve the live candidate *before* touching the file.
    const saved = await configStore.save(document, expectedRevision, options.env, (candidate, revision) => live.check(candidate, revision));
    if (!saved.applied) {
      return {
        revision: saved.revision,
        effectiveRevision: live.revision(),
        applied: false,
        ...(saved.reason ? { reason: saved.reason } : {}),
        configured: live.enabled(),
        modelCount: live.entries().length,
        enabledModelCount: live.status().enabledModelCount,
      };
    }
    const result = live.apply(saved.config, saved.revision);
    if (result.applied) {
      await syncProviders();
      server.runtime.host.syncProjects();
      scheduler.wake();
      publishDefinitions();
      activateDispatch(server);
    }
    return {
      revision: saved.revision,
      effectiveRevision: live.revision(),
      applied: result.applied,
      ...(result.applied ? {} : { reason: result.reason }),
      configured: live.enabled(),
      modelCount: live.entries().length,
      enabledModelCount: live.status().enabledModelCount,
    };
  };
  const pushSecret = async (ref: string, value: string | null): Promise<ApplyConfigResult> => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new RuntimeError('invalid_input', 'secretRef must be an environment variable name');
    if (value !== null && (!value.trim() || value.length > 8_192)) throw new RuntimeError('invalid_input', 'A nonempty bounded secret value is required');
    const result = live.pushSecret(ref, value === null ? null : value.trim());
    if (result.applied) {
      await writeFile(revokedPath, `${JSON.stringify(live.revoked(), null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
      await syncProviders();
      scheduler.wake();
      publishDefinitions();
      activateDispatch(server);
    }
    return {
      revision: live.revision(),
      effectiveRevision: live.revision(),
      applied: result.applied,
      ...(result.applied ? {} : { reason: result.reason }),
      configured: live.enabled(),
      modelCount: live.entries().length,
      enabledModelCount: live.status().enabledModelCount,
    };
  };

  return {
    url: server.url,
    stateDir,
    webDir: options.webDir,
    configPath: config.path,
    mode: options.mode,
    configured: live.enabled(),
    modelCount: live.entries().length,
    enabledModelCount: live.status().enabledModelCount,
    appToken,
    server,
    applyConfig,
    pushSecret,
    async close() { await server.close(); },
  };
}
