import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { RuntimeError } from '../core/types.ts';
import { emptyGraphConfig, loadGraphConfig, resolveCredentialSecret, type ConfiguredModel, type GraphConfig } from './config.ts';
import { modelRequestHeaders } from '../catalog/models.ts';
import { openConfigStore } from './config-service.ts';
import { createLiveConfig, type LiveConfig } from './live-config.ts';
import { loadPresetBootstrap, publishBootstrap } from '../catalog/presets.ts';
import { GRAPH_ARCHITECTURES } from '../catalog/architecture-catalog.ts';
import { graphHome as resolveGraphHome } from '../catalog/graph-home.ts';
import { applyPriceSnapshot, PRICE_SNAPSHOT, PRICE_SNAPSHOT_BASE, type PriceRefreshResult, type PriceSnapshot } from '../catalog/price-snapshot.ts';
import { createModelScheduler } from '../runtime/model-scheduler.ts';
import { verifyMcpCapability } from '../runtime/capabilities.ts';
import { graphApplicationRoot } from '../runtime/graph-root.ts';
import { openRsiService, resolveRsiRoot } from '../runtime/rsi.ts';
import { graphDocumentationPaths } from '../runtime/agent-docs.ts';
import { openGraphServer } from './host.ts';
import { openAgentContextLibrary } from '../runtime/agent-context.ts';
import { createUsageService } from './usage.ts';

export interface DaemonOptions {
  /** Explicit config path; null starts in first-run mode with no projects or models. */
  configPath: string | null;
  stateDir: string;
  webDir: string;
  /** User-owned Graph home; capabilities and recipes live here. */
  graphHome?: string;
  port: number;
  mode: 'view' | 'execute';
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
  /** Permit execute intent before any model resolves; the APP applies the
   * configuration live. The CLI keeps the strict startup errors. */
  dynamic?: boolean;
  /** Built-in preset pack directory; defaults to the repository `presets/`. */
  presetsDir?: string;
  /** Re-verification hook for a price refresh; tests inject a deterministic one. */
  priceVerify?: (snapshot: PriceSnapshot) => boolean;
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
  /** Explicit archived-price refresh (C01); failure keeps old values as stale. */
  refreshPrices(expectedRevision: number): Promise<ApplyConfigResult & { results: PriceRefreshResult[] }>;
  close(): Promise<void>;
}

function piModel(entry: ConfiguredModel): Model<ConfiguredModel['api']> {
  const headers = modelRequestHeaders(entry);
  return {
    id: entry.id,
    name: entry.id,
    provider: entry.provider,
    api: entry.api,
    baseUrl: entry.baseUrl,
    reasoning: entry.reasoning !== false,
    input: ['text'],
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    cost: entry.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(headers ? { headers } : {}),
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
  const revocation = await (async (): Promise<{ refs: string[]; failure?: string }> => {
    let text: string;
    try {
      text = await readFile(revokedPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { refs: [] };
      return { refs: [], failure: error instanceof Error ? error.message : String(error) };
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed) || parsed.some(ref => typeof ref !== 'string')) throw new Error('expected a JSON array of secret refs');
      return { refs: parsed as string[] };
    } catch (error) {
      return { refs: [], failure: error instanceof Error ? error.message : String(error) };
    }
  })();
  // An unusable revocation file is never treated as "nothing was revoked":
  // start fail-closed with every configured credential revoked, so no key is
  // silently re-enabled; an explicit push (disable/restore) repairs the state.
  const revokedRefs = revocation.failure
    ? [...new Set(Object.values(config.credentials).map(credential => credential.secretRef))]
    : revocation.refs;
  if (revocation.failure) log(`Revocation file unusable (${revocation.failure}); all configured credentials start revoked. Disable or restore a connection to repair it.`);
  const usageService = createUsageService({
    env: options.env,
    home: options.env.HOME,
    ...(configStore ? { loadConfig: async () => ({ config: (await configStore.snapshot()).config, env: options.env }) } : {}),
  });
  // Import credentials owned by OpenCode/Codex/Grok CLIs without sending their
  // values to the browser or writing them into graph.config.json.
  const importedSecrets = await usageService.secretValues().catch(() => ({}));
  const live: LiveConfig = createLiveConfig({
    env: options.env,
    log,
    initial: { config, revision: configStore?.revision() ?? 0 },
    secrets: importedSecrets,
    revoked: revokedRefs,
  });
  /** Atomic multi-ref revocation persistence: a temp file plus rename means a
   * crash never leaves a half-written list, and errors reach the caller. */
  const persistRevoked = async (refs: string[]) => {
    const temporary = `${revokedPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...new Set(refs)].sort(), null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, revokedPath);
  };
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
      const headers = modelRequestHeaders(group.entries[0]!);
      // Re-registering the same provider name replaces its endpoint/key, so a
      // saved rotation applies to the next session opened for this provider.
      runtime.registerProvider(provider, {
        baseUrl: group.baseUrl,
        api: group.api,
        apiKey: binding.apiKey,
        models: group.entries.map(piModel),
        ...(headers ? { headers } : {}),
      });
    }
  };
  await syncProviders();

  const activateDispatch = (server: Awaited<ReturnType<typeof openGraphServer>>) => {
    // View-only CLI intent never starts dispatching because a config was saved.
    if (options.mode !== 'execute' && !options.dynamic) return;
    server.startDrive();
    server.runtime.host.recoverMasters();
  };
  // Bootstrap prompts are immutable Graph runtime content, not user capabilities.
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
    const headers = modelRequestHeaders(entry);
    try {
      const response = await fetch(`${entry.baseUrl.replace(/\/$/, '')}${anthropic ? '/messages' : '/chat/completions'}`, {
        method: 'POST',
        headers: anthropic
          ? { 'content-type': 'application/json', 'x-api-key': binding.apiKey, 'anthropic-version': '2023-06-01', ...headers }
          : { 'content-type': 'application/json', authorization: `Bearer ${binding.apiKey}`, ...headers },
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
  const rsiRoot = resolveRsiRoot(options.env, process.cwd());
  const rsiService = openRsiService({ ...(rsiRoot ? { root: rsiRoot } : {}), stateDir });

  const runtimeReady = await ensureModelRuntime();
  const presetsRoot = options.presetsDir ?? fileURLToPath(new URL('../../presets', import.meta.url));
  const userGraphHome = options.graphHome ?? resolveGraphHome(options.env);
  const capabilityPath = join(userGraphHome, 'capabilities');
  const recipesPath = join(userGraphHome, 'agent-combinations.json');
  const bootstrap = await loadPresetBootstrap(presetsRoot, log);
  const agentContext = openAgentContextLibrary(join(userGraphHome, 'prompts'), {
    ...(bootstrap.prompts.main ? { identity: bootstrap.prompts.main } : {}),
    ...(bootstrap.toolPrompt ? { mainTools: bootstrap.toolPrompt } : {}),
  });
  await agentContext.ensure();
  const documentation = graphDocumentationPaths();
  let catalogCapabilities: import('../catalog/catalog.ts').CapabilityRecord[] = [];
  let catalogCombinations: import('../catalog/agent-combinations.ts').AgentCombinationView[] = [];
  const systemSummary = async () => {
    const usage = await usageService.get();
    const liveCapabilities = graphServer?.runtime.catalog.capabilities() ?? catalogCapabilities;
    const configured = live.entries().map(entry => ({
      id: entry.id,
      provider: entry.provider,
      modelId: entry.modelId ?? entry.id,
      grade: entry.grade,
      reasoning: entry.reasoning !== false,
      ...(entry.defaultThinkingLevel ? { defaultThinkingLevel: entry.defaultThinkingLevel } : {}),
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      credentialConfigured: Boolean(live.credentialFor(entry)),
      pricingStatus: entry.pricing?.status ?? (entry.cost ? 'known' : 'unknown'),
    }));
    return {
      configuredModels: configured,
      access: live.access(),
      agentCombinations: graphServer?.runtime.catalog.agentCombinations() ?? catalogCombinations,
      agentDefinitions: graphServer?.runtime.catalog.availableAgentDefinitions() ?? [],
      architectures: GRAPH_ARCHITECTURES,
      subscriptionPlans: usage.plans.map(plan => ({
        id: plan.id,
        name: plan.name,
        configured: plan.configured,
        status: plan.status,
        plan: plan.plan,
        models: plan.models.map(model => ({
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          supported: model.supported,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          ...(model.inputCostPerMillion !== undefined ? { inputCostPerMillion: model.inputCostPerMillion } : {}),
          ...(model.outputCostPerMillion !== undefined ? { outputCostPerMillion: model.outputCostPerMillion } : {}),
        })),
        windows: plan.windows,
        balance: plan.balance,
        error: plan.error,
        updatedAt: plan.updatedAt,
      })),
      summary: usage.summary,
      capabilities: {
        root: capabilityPath,
        entries: liveCapabilities.length,
        byKind: Object.fromEntries(
          ['skill', 'mcp', 'extension', 'pi-extension', 'prompt'].map(kind => [
            kind,
            liveCapabilities.filter(entry => entry.kind === kind).length,
          ]),
        ),
      },
      agentContext: {
        root: agentContext.root,
        docsRoot: documentation.root,
      },
      application: {
        root: graphApplicationRoot(),
        mode: process.versions.electron ? 'packaged' : 'source',
      },
    };
  };
  const capabilitySecretValues = () => {
    const revoked = new Set(live.revoked());
    const values: Record<string, string> = {};
    for (const [ref, value] of Object.entries(options.env)) {
      if (!revoked.has(ref) && typeof value === 'string' && value.trim()) values[ref] = value;
    }
    for (const [ref, value] of Object.entries(live.secrets())) {
      if (!revoked.has(ref) && value.trim()) values[ref] = value;
    }
    return values;
  };
  let graphServer: Awaited<ReturnType<typeof openGraphServer>> | undefined;
  const currentMasterDefinitionVersion = () => {
    if (!bootstrap.prompts.main) return 'master@1';
    const main = graphServer?.runtime.catalog.definitions().find(item => item.id === 'main');
    return main ? `main@${main.version}` : 'master@1';
  };
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
    capabilitySecrets: capabilitySecretValues,
    master: { action: 'master', definitionVersion: currentMasterDefinitionVersion, model: () => live.masterModel() },
    catalog: {
      capabilityRoot: capabilityPath,
      recipesPath,
      ...(Object.keys(bootstrap.prompts).length ? { bootstrapPrompts: bootstrap.prompts } : {}),
      ...(bootstrap.toolPrompt ? { bootstrapToolPrompt: bootstrap.toolPrompt } : {}),
    },
    limits: { defaultBudgetTokens: live.defaultBudgetTokens() },
    access: () => live.access(),
    config: { revision: () => live.revision() },
    autoDrive: options.mode === 'execute' || options.dynamic === true,
    port: options.port,
    webDir: options.webDir,
    startupInfo: () => ({
      mode: options.mode, configured: live.enabled(), modelCount: live.entries().length,
      enabledModelCount: live.status().enabledModelCount, effectiveRevision: live.revision(),
      ...(Object.keys(live.status().limitAliases).length ? { limitAliases: live.status().limitAliases } : {}),
    }),
    ...(configStore ? { configStore, configEnv: { ...options.env, ...importedSecrets }, configTest: testConnection } : {}),
    usage: usageService,
    systemContext: {
      systemSummary,
    },
    ...(rsiService.root ? { rsi: rsiService } : {}),
    agentContext,
    appServices: {
      applyConfig: (document, expectedRevision) => applyConfig(document, expectedRevision),
      pushSecret: (ref, value) => pushSecret(ref, value),
      refreshPrices: (expectedRevision: number) => refreshPrices(expectedRevision),
      capabilityConfig: {
        secretValues: capabilitySecretValues,
        verify: (record, values = {}) => verifyMcpCapability(record, values),
      },
      appToken,
      rsi: {
        status: () => rsiService.status(),
        ack: (id: string) => rsiService.ackRestart(id),
      },
      snapshot: () => ({
        revision: live.revision(), effectiveRevision: live.revision(), applied: true,
        configured: live.enabled(), modelCount: live.entries().length, enabledModelCount: live.status().enabledModelCount,
      }),
    },
  });
  graphServer = server;
  const presetResult = publishBootstrap(server.runtime.catalog, bootstrap, log);
  presetsAvailable = presetResult.available;
  publishDefinitions = () => {
    if (presetsAvailable || definitionsPublished || !live.enabled()) return;
    definitionsPublished = true;
    server.runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
    server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
    server.runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  };
  publishDefinitions();
  const refreshCatalogSnapshot = async () => {
    const refreshed = await server.runtime.catalog.refreshCatalog();
    catalogCapabilities = refreshed.capabilities;
    catalogCombinations = refreshed.agentCombinations;
  };
  const ensureMainRecipe = async () => {
    if (!bootstrap.prompts.main) return;
    if (server.runtime.catalog.agentCombinationError()) {
      log(`Main Agent recipe unavailable (${server.runtime.catalog.agentCombinationError()}); using bootstrap master@1.`);
      return;
    }
    const existing = server.runtime.catalog.agentCombinations().find(item => item.id === 'main');
    try {
      if (!existing) {
        await server.runtime.catalog.saveAgentCombination({
          id: 'main',
          name: 'Atlas_main',
          description: '持续面对用户、规划任务、设计并监控 Graph，并在确认范围内组装和调用 subagents。',
          mode: 'main',
          recommendedGrade: 'high',
          review: false,
          tags: ['main', 'system'],
          resources: [],
        });
      } else if (existing.mode !== 'main') {
        await server.runtime.catalog.saveAgentCombination({ ...existing, mode: 'main' });
      } else {
        server.runtime.catalog.compileAgentCombination('main');
      }
    } catch (error) {
      log(`Main Agent recipe unavailable (${error instanceof Error ? error.message : String(error)}); using bootstrap master@1.`);
    }
  };
  await ensureMainRecipe();
  await refreshCatalogSnapshot();
  if (presetsAvailable) log(`Bootstrap: ${presetResult.installed.length} definitions ready${presetResult.failed.length ? `, ${presetResult.failed.length} failed` : ''}; capabilities: ${capabilityPath}.`);

  // Configuration/secret changes must be serialized as a whole (read the
  // current revocation view, validate, persist, activate/rollback): two
  // concurrent revocations previously overwrote each other's persisted refs.
  let configQueue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(action: () => Promise<T>): Promise<T> => {
    const run = configQueue.then(action, action);
    configQueue = run.then(() => undefined, () => undefined);
    return run;
  };
  const applyConfigNow = async (document: unknown, expectedRevision: number): Promise<ApplyConfigResult> => {
    if (!configStore) throw new RuntimeError('invalid_config', 'The daemon was started without a configuration file');
    // Validate against the merged view (env + APP-pushed secrets - revoked
    // refs) and approve the live candidate *before* touching the file.
    const saved = await configStore.save(document, expectedRevision, options.env, (candidate, revision) => {
      const liveResult = live.check(candidate, revision);
      if (!liveResult.applied) return liveResult;
      // Project root/in-flight checks belong to the candidate phase: a known
      // rejection must not reach the file or the active bindings.
      try {
        server.runtime.host.checkProjects(candidate.projects ?? []);
        return { applied: true };
      } catch (error) {
        return { applied: false, reason: error instanceof Error ? error.message : String(error) };
      }
    });
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
  const pushSecretNow = async (ref: string, value: string | null): Promise<ApplyConfigResult> => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new RuntimeError('invalid_input', 'secretRef must be an environment variable name');
    if (value !== null && (!value.trim() || value.length > 8_192)) throw new RuntimeError('invalid_input', 'A nonempty bounded secret value is required');
    const revoking = value === null || value.trim() === '';
    const previousRevoked = live.revoked();
    const nextRefs = revoking ? [...previousRevoked, ref] : previousRevoked.filter(item => item !== ref);
    const sameSet = previousRevoked.length === nextRefs.length && previousRevoked.every(item => nextRefs.includes(item));
    if (!sameSet) {
      try {
        await persistRevoked(nextRefs);
      } catch (error) {
        // Do not claim success and do not change the effective binding when the
        // revocation cannot survive a restart.
        return {
          revision: live.revision(), effectiveRevision: live.revision(), applied: false,
          reason: `撤销未能持久化（${error instanceof Error ? error.message : String(error)}）；连接保持原状态`,
          configured: live.enabled(), modelCount: live.entries().length, enabledModelCount: live.status().enabledModelCount,
        };
      }
    }
    const result = live.pushSecret(ref, revoking ? null : value.trim());
    if (!result.applied && !sameSet) await persistRevoked(previousRevoked).catch(() => undefined);
    if (result.applied) {
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

  /** Verify an archived price entry by fetching its official page and checking
   * the model id is still mentioned. Network/parse failures are a verification
   * failure, never a silent re-stamp. */
  const defaultPriceVerify = async (snapshot: PriceSnapshot): Promise<boolean> => {
    try {
      const response = await fetch(snapshot.sourceUrl, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'graph-price-refresh/1' } });
      if (!response.ok) return false;
      const text = await response.text();
      return text.includes(snapshot.modelId);
    } catch {
      return false;
    }
  };

  const refreshPricesNow = async (expectedRevision: number): Promise<ApplyConfigResult & { results: PriceRefreshResult[] }> => {
    if (!configStore || !config.path) throw new RuntimeError('invalid_config', 'The daemon was started without a configuration file');
    const raw = JSON.parse(await readFile(config.path, 'utf8')) as unknown;
    // Resolve every archived entry before mutating the document: an
    // unverifiable entry keeps its old amount and is marked stale.
    const verify = options.priceVerify ?? defaultPriceVerify;
    const decisions = new Map<string, boolean>();
    for (const snapshot of PRICE_SNAPSHOT) {
      decisions.set(`${snapshot.provider}:${snapshot.modelId}`, Boolean(await verify(snapshot)));
    }
    const retrievedAt = new Date().toISOString().slice(0, 10);
    const { document, results } = applyPriceSnapshot(raw, {
      verify: snapshot => decisions.get(`${snapshot.provider}:${snapshot.modelId}`) ?? false,
      revision: `${PRICE_SNAPSHOT_BASE}.refresh.${retrievedAt}`,
      retrievedAt,
    });
    const applied = await applyConfigNow(document, expectedRevision);
    // A rejected candidate must not look like a successful refresh.
    return applied.applied ? { ...applied, results } : { ...applied, results, reason: applied.reason ?? 'refresh rejected' };
  };

  const applyConfig = (document: unknown, expectedRevision: number) => serialized(() => applyConfigNow(document, expectedRevision));
  const pushSecret = (ref: string, value: string | null) => serialized(() => pushSecretNow(ref, value));
  const refreshPrices = (expectedRevision: number) => serialized(() => refreshPricesNow(expectedRevision));

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
    refreshPrices,
    async close() { await server.close(); },
  };
}
