import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { RuntimeError, type AttachmentInput } from '../core/types.ts';
import type { openTaskRuntime } from '../core/task-runtime.ts';
import { createSession, guard, localOrigin, setSessionCookie } from './auth.ts';
import { layoutGraph } from './layout.ts';

import type { AppServices, StartupInfo } from './host.ts';
import { sanitizeConfig, type ConfigStore } from './config-service.ts';
import {
  buildModelsRequest,
  buildVerifyRequest,
  parseModelsResponse,
  parseVerifyResponse,
  platformCatalogView,
  PROVIDER_ROUTES,
  sanitizeProviderView,
  shouldProbeModels,
  validateProbeRequest,
  type HttpRequestSpec,
  type ProbeTarget,
  type ProviderModelSummary,
} from './providers.ts';
import type { UsageService } from './usage.ts';
import type { AgentCombination } from '../catalog/agent-combinations.ts';
import type { DefinitionSpec } from '../catalog/catalog.ts';
import { capabilityConfigViews } from '../catalog/capability-config.ts';
import { searchPiPackages } from '../runtime/pi-package-search.ts';
import type { AgentContextLibrary, AgentPromptKey } from '../runtime/agent-context.ts';

type Runtime = Awaited<ReturnType<typeof openTaskRuntime>>;
function graphAgentDetail(runtime: Runtime, definitionVersion: string | null | undefined) {
  if (!definitionVersion) return null;
  const match = /^(.*)@(\d+)$/.exec(definitionVersion);
  if (!match) return null;
  const id = match[1]!;
  const version = Number(match[2]);
  try {
    const definition = runtime.catalog.definitionSpec(id, version) as DefinitionSpec;
    const talent = runtime.talent(id, { version });
    const snapshot = definition.snapshot && typeof definition.snapshot === 'object' && !Array.isArray(definition.snapshot)
      ? definition.snapshot as { agentCombination?: { name?: string; description?: string } }
      : undefined;
    const capabilityView = (bound: { id: string; version: string }, role: string) => {
      const record = runtime.catalog.capability(bound.id, bound.version);
      return {
        id: bound.id,
        version: bound.version,
        role,
        kind: record?.kind ?? null,
        name: record?.name ?? bound.id,
        status: record?.status ?? 'missing',
        source: record?.source ?? null,
      };
    };
    return {
      id,
      version,
      name: snapshot?.agentCombination?.name ?? id,
      description: snapshot?.agentCombination?.description ?? talent.detail.description,
      recommendedGrade: talent.detail.recommendedGrade,
      review: talent.detail.review,
      capabilities: [
        ...(definition.capabilities ?? []).map(bound => capabilityView(bound, 'capability')),
        ...(definition.prompts?.agent ? [capabilityView(definition.prompts.agent, 'agent')] : []),
        ...(definition.prompts?.tool ? [capabilityView(definition.prompts.tool, 'tool')] : []),
      ],
      experience: {
        task: talent.experience.task,
        samples: talent.experience.samples.slice(-5).reverse(),
      },
    };
  } catch {
    return null;
  }
}

export async function createApp(runtime: Runtime, options: { origin: string; webDir?: string; startup?: StartupInfo; startupInfo?: () => StartupInfo; config?: { store: ConfigStore; env: Record<string, string | undefined> }; configTest?: (modelId: string) => Promise<unknown>; appServices?: AppServices; usage?: UsageService; agentContext?: AgentContextLibrary; systemContext?: { systemSummary?: () => Promise<Record<string, unknown>> | Record<string, unknown> } }) {
  // Image attachments travel as base64 inside a chat message, so the default
  // 1 MiB JSON limit would reject the very payloads the composer can build
  // (up to 8 MiB of images plus text). Keep a bounded ceiling above that.
  const app = Fastify({ logger: false, bodyLimit: 24 * 1024 * 1024 });
  const session = createSession();
  const capabilitySecretValues = () => options.appServices?.capabilityConfig?.secretValues() ?? Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim())),
  );
  // The console is read per request. Every /assets/* file is already served
  // from disk on each request, so pinning index.html at startup would let a
  // rebuilt bundle sit behind a stale page - and a stale page can reference
  // asset names the rebuild just removed.
  const html = async () => options.webDir ? await readFile(join(options.webDir, 'index.html'), 'utf8').catch(() => defaultPage()) : defaultPage();
  // Provider configuration reuses the credential view the runtime already
  // merges (environment + APP/keychain pushes, minus revocations). Values are
  // consumed in-process only; responses carry names and flags, never a secret.
  const providerSecrets = (): Record<string, string | undefined> => {
    // The runtime's merged view is authoritative: it already drops revoked refs
    // even when the process environment still names the variable.
    const live = options.appServices?.capabilityConfig?.secretValues();
    return live ?? { ...(options.config?.env ?? {}) };
  };
  const providersView = async () => {
    const secrets = providerSecrets();
    let credentials: ReturnType<typeof sanitizeProviderView>['credentials'] = {};
    if (options.config) {
      try {
        const { config } = await options.config.store.snapshot();
        credentials = sanitizeProviderView(config, secrets).credentials;
      } catch {
        credentials = {};
      }
    }
    return { platforms: platformCatalogView(secrets).platforms, credentials };
  };
  /** One request/response round-trip for a probe; no secret ever reaches the reply. */
  const probeHttp = async (spec: HttpRequestSpec): Promise<{ status: number; body: unknown }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(spec.url, {
        method: spec.method,
        headers: spec.headers,
        ...(spec.body ? { body: spec.body } : {}),
        signal: controller.signal,
      });
      const text = await response.text().catch(() => '');
      let body: unknown;
      if (text) {
        try { body = JSON.parse(text) as unknown; } catch { body = text; }
      }
      return { status: response.status, body };
    } catch (error) {
      return { status: 0, body: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  };
  /** Probe an unsaved provider draft: always attempt the vendor's `/models`
   * list (unless the body says `probeModels:false`), then send one minimal
   * chat request. The `modelsListSupported` flag is copy-only - a vendor that
   * really answers `/models` is never skipped because of a local guess, and a
   * rejection keeps its own wording while manual model ids stay allowed. */
  const runProviderProbe = async (rawBody: unknown) => {
    const parsedBody = validateProbeRequest(rawBody);
    if (!parsedBody.ok) {
      throw new RuntimeError('invalid_input', parsedBody.errors.map(error => `${error.field}: ${error.message}`).join('; '));
    }
    const { provider, modelId: requestedModel, probeModels } = parsedBody.request;
    const apiKey = providerSecrets()[provider.credentialRef]?.trim() || undefined;
    const target: ProbeTarget = {
      baseUrl: provider.baseUrl,
      api: provider.api,
      ...(apiKey ? { apiKey } : {}),
      ...(provider.headers ? { headers: provider.headers } : {}),
    };
    const wantModels = shouldProbeModels(probeModels);
    const models: ProviderModelSummary[] = [];
    let modelsError: string | undefined;
    if (wantModels) {
      const response = await probeHttp(buildModelsRequest(target));
      const parsed = parseModelsResponse(target, response.status, response.body);
      if ('models' in parsed) models.push(...parsed.models);
      else modelsError = parsed.error;
    }
    const verifyModel = requestedModel ?? models[0]?.id;
    let verification: { ok: boolean; status?: number; error?: string; skipped?: boolean };
    if (!apiKey) {
      verification = { ok: false, error: `凭据未解析：${provider.credentialRef}（请在环境变量或钥匙串中提供）` };
    } else if (verifyModel) {
      const response = await probeHttp(buildVerifyRequest(target, verifyModel));
      const parsed = parseVerifyResponse(response.status, response.body);
      verification = parsed.ok
        ? { ok: true, status: parsed.status }
        : { ok: false, status: parsed.status, error: parsed.error };
    } else if (modelsError) {
      verification = { ok: false, error: modelsError };
    } else {
      verification = { ok: false, skipped: true, error: '没有可验证的模型：该端点不支持模型列表，请手动添加模型 id' };
    }
    return {
      provider: {
        id: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl,
        api: provider.api,
        credentialRef: provider.credentialRef,
        credentialKind: provider.credentialKind,
        custom: provider.custom,
      },
      credentialConfigured: Boolean(apiKey),
      models,
      ...(modelsError ? { modelsError } : {}),
      verification,
    };
  };

  app.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { statusCode?: number; code?: string };
    const status = typeof err.statusCode === 'number' ? err.statusCode : error instanceof RuntimeError ? 400 : 500;
    const code = error instanceof RuntimeError ? error.code : err.code ?? 'internal';
    const field = (error as Error & { field?: string }).field;
    reply.status(status).send({ code, message: err.message, ...(field ? { field } : {}) });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/' || request.url.startsWith('/assets/') || request.url === '/api/health') return;
    // The desktop bridge authenticates with the per-process token written to
    // the state directory; the browser session cookie never reaches Electron.
    if (request.url.startsWith('/api/app/')) {
      const token = request.headers['x-graph-app-token'];
      if (!options.appServices || typeof token !== 'string' || token !== options.appServices.appToken) {
        return reply.status(403).send({ code: 'forbidden', message: 'App bridge token required' });
      }
      return;
    }
    if (request.url.startsWith('/api/')) guard(session, request);
    const origin = request.headers.origin;
    if (origin && !localOrigin(origin)) {
      return reply.status(403).send({ code: 'forbidden_origin', message: 'Local origin required' });
    }
  });

  app.get('/', async (_request, reply) => {
    setSessionCookie(reply, session);
    reply.type('text/html').send(await html());
  });
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/startup', async () => options.startupInfo?.() ?? options.startup ?? { mode: 'view' as const, configured: false, modelCount: 0, enabledModelCount: 0 });
  app.get('/api/agent-context', async request => {
    const conversationId = (request.query as { conversationId?: string }).conversationId;
    return runtime.agentContextPreview(conversationId);
  });
  app.put('/api/agent-context/prompts', async request => {
    if (!options.agentContext) throw new RuntimeError('invalid_config', 'Agent context library is unavailable');
    const body = request.body as { key?: unknown; content?: unknown };
    if (typeof body?.key !== 'string' || typeof body.content !== 'string') {
      throw new RuntimeError('invalid_input', 'key and content are required');
    }
    await options.agentContext.savePrompt(body.key as AgentPromptKey, body.content);
    return options.agentContext.view();
  });
  app.put('/api/agent-context/prompts/default', async request => {
    if (!options.agentContext) throw new RuntimeError('invalid_config', 'Agent context library is unavailable');
    const body = request.body as { key?: unknown; content?: unknown };
    if (typeof body?.key !== 'string' || typeof body.content !== 'string') {
      throw new RuntimeError('invalid_input', 'key and content are required');
    }
    await options.agentContext.setPromptDefault(body.key as AgentPromptKey, body.content);
    return options.agentContext.view();
  });
  app.post('/api/agent-context/prompts/default/reset', async request => {
    if (!options.agentContext) throw new RuntimeError('invalid_config', 'Agent context library is unavailable');
    const body = request.body as { key?: unknown };
    if (typeof body?.key !== 'string') throw new RuntimeError('invalid_input', 'key is required');
    await options.agentContext.clearPromptDefault(body.key as AgentPromptKey);
    return options.agentContext.view();
  });
  app.post('/api/agent-context/prompts/reset', async request => {
    if (!options.agentContext) throw new RuntimeError('invalid_config', 'Agent context library is unavailable');
    const body = request.body as { key?: unknown };
    if (typeof body?.key !== 'string') throw new RuntimeError('invalid_input', 'key is required');
    await options.agentContext.resetPrompt(body.key as AgentPromptKey);
    return options.agentContext.view();
  });
  app.put('/api/agent-context/tools', async request => {
    if (!options.agentContext) throw new RuntimeError('invalid_config', 'Agent context library is unavailable');
    const body = request.body as { disabled?: unknown };
    if (!Array.isArray(body?.disabled) || body.disabled.some(name => typeof name !== 'string')) {
      throw new RuntimeError('invalid_input', 'disabled must be a string array');
    }
    return { disabledTools: await options.agentContext.setDisabledTools(body.disabled as string[]) };
  });
  if (options.usage) {
    app.get('/api/usage', async () => options.usage!.get(false));
    app.post('/api/usage/refresh', async () => options.usage!.get(true));
    app.get('/api/usage/credentials', async () => ({ credentials: await options.usage!.credentials() }));
  }
  app.get('/api/model-pricing', async () => options.usage
    ? options.usage.pricing()
    : { source: '~/.cc-switch/model-pricing.json', updatedAt: null, models: [] });
  // Provider directory + probe on the console's session-cookie `/api` face.
  // The page cannot read the desktop app token, so these must NOT live under
  // `/api/app/*`.
  app.get(PROVIDER_ROUTES.list, async () => providersView());
  app.post(PROVIDER_ROUTES.probe, async request => runProviderProbe(request.body));
  app.post('/api/app/secret', async request => {
    if (!options.appServices) throw new RuntimeError('invalid_config', 'The daemon was started without the app bridge');
    const body = request.body as { ref?: unknown; value?: unknown; persisted?: unknown };
    if (typeof body.ref !== 'string') throw new RuntimeError('invalid_input', 'secretRef is required');
    if (body.value !== null && typeof body.value !== 'string') throw new RuntimeError('invalid_input', 'The secret value must be a string or null');
    // `persisted: true` says the keychain now holds this value, which clears the
    // Agent's pending write instead of creating one.
    return options.appServices.pushSecret(body.ref, body.value as string | null, body.persisted === true);
  });
  // Secret writes the keychain does not hold yet, for the desktop app to store.
  // Only values the Agent pushed appear here; a keychain-only secret never
  // travels back out of the daemon.
  app.get('/api/app/secret-requests', async () => ({
    requests: options.appServices ? options.appServices.pendingSecretRequests() : [],
  }));
  // `?compare=1` adds the checkout comparison (`sync.deploy`), which walks both checkouts through git.
  // The desktop polls this route every five seconds, so the comparison is opt-in rather than a cost
  // every caller pays for.
  app.get('/api/app/rsi/status', async request => {
    if (!options.appServices?.rsi) return { available: false, pendingRestart: null, canRestart: false };
    const query = request.query as Record<string, unknown> | undefined;
    return options.appServices.rsi.status({ compare: String(query?.compare ?? '') === '1' });
  });
  app.post('/api/app/rsi/restart-ack', async request => {
    if (!options.appServices?.rsi) throw new RuntimeError('invalid_config', 'The daemon was started without the app bridge');
    const body = request.body as { id?: unknown };
    if (typeof body.id !== 'string' || !body.id.trim()) throw new RuntimeError('invalid_input', 'A restart request id is required');
    return options.appServices.rsi.ack(body.id.trim());
  });
  app.get('/api/limits', async () => runtime.modelLimits());
  // Per-tool telemetry the runtime records itself; the console renders it as the 工具 page.
  app.get('/api/tool-stats', async () => runtime.toolCallStats());
  app.post('/api/tool-stats/clear', async () => runtime.clearToolCalls());
  // Which skills the recorded calls touched: the 工具 page renders this next to the tool numbers.
  app.get('/api/skill-stats', async () => runtime.skillStats());
  // Promote a project skill into the capability library (a copy plus a manifest; never a binding).
  app.post('/api/skills/promote', async request => {
    const body = request.body as { skillId?: unknown } | undefined;
    if (typeof body?.skillId !== 'string' || !body.skillId.trim()) {
      throw new RuntimeError('invalid_input', 'skillId is required');
    }
    return runtime.promoteSkill(body.skillId.trim());
  });
  if (options.config) {
    app.get('/api/config', async () => {
      const { revision, config } = await options.config!.store.snapshot();
      const status = options.appServices?.snapshot();
      return {
        revision,
        ...(status ? { effectiveRevision: status.effectiveRevision, configured: status.configured } : {}),
        config: sanitizeConfig(config, providerSecrets()),
        // What the daemon knows on top of the file: secret writes waiting for the
        // keychain, and the file watcher's last outcome.
        pendingSecretRefs: options.appServices?.pendingSecretRequests().map(request => request.ref) ?? [],
        watch: options.appServices?.configWatch?.() ?? null,
      };
    });
    app.post('/api/config', async request => {
      const body = request.body as { expectedRevision?: unknown; document?: unknown };
      if (typeof body?.expectedRevision !== 'number' || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
        throw new RuntimeError('invalid_input', 'expectedRevision must be a nonnegative integer');
      }
      const current = await options.config!.store.snapshot();
      const nextModels = (body.document as { models?: { entries?: { id?: unknown }[] } })?.models?.entries;
      const nextIds = new Set(Array.isArray(nextModels) ? nextModels.map(entry => String(entry?.id ?? '')) : []);
      const removed = runtime.modelsInUse().filter(id => !nextIds.has(id));
      if (removed.length) throw new RuntimeError('config_in_use', `Models in use by unfinished tasks cannot be removed: ${removed.join(', ')}`);
      if (options.appServices) {
        // Hot apply: persist through the same atomic store, then activate the
        // candidate on this daemon. A rejected candidate keeps the previous
        // effective bindings and reports why instead of a false success.
        const applied = await options.appServices.applyConfig(body.document, body.expectedRevision);
        return { ...applied, restartRequired: false };
      }
      const saved = await options.config!.store.save(body.document, body.expectedRevision, options.config!.env);
      return { revision: saved.revision, restartRequired: current.revision !== saved.revision };
    });
    if (options.appServices?.refreshPrices) {
      // Explicit refresh only: saving a config must never fetch prices.
      app.post('/api/pricing/refresh', async request => {
        const body = request.body as { expectedRevision?: unknown } | undefined;
        if (typeof body?.expectedRevision !== 'number' || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
          throw new RuntimeError('invalid_input', 'expectedRevision must be a nonnegative integer');
        }
        const refreshed = await options.appServices!.refreshPrices!(body.expectedRevision);
        return { ...refreshed, restartRequired: false };
      });
    }
    if (options.configTest) {
      app.post('/api/config/test', async request => {
        const body = request.body as { modelId?: unknown };
        if (typeof body?.modelId !== 'string' || !body.modelId.trim()) throw new RuntimeError('invalid_input', 'modelId is required');
        return options.configTest!(body.modelId);
      });
    }
  }
  app.get('/api/settings', async () => {
    const projects = await runtime.user.projects();
    const models = runtime.models();
    const defaultModel = runtime.defaultModel();
    const definitions = runtime.catalog.definitions();
    const capabilities = runtime.catalog.capabilitiesView();
    const capabilityConfig = await capabilityConfigViews(capabilities, capabilitySecretValues());
    return {
      projects, models, defaultModel, definitions, capabilities, capabilityConfig,
      agentCombinations: runtime.catalog.agentCombinations(),
      capabilityRoot: runtime.catalog.capabilityRootPath() ?? null,
      agentCombinationFile: runtime.catalog.agentCombinationFilePath() ?? null,
      agentCombinationError: runtime.catalog.agentCombinationError() ?? null,
    };
  });
  app.get('/api/capabilities/config', async () => ({
    items: await capabilityConfigViews(runtime.catalog.capabilities(), capabilitySecretValues()),
  }));
  app.get('/api/tasks', async () => runtime.user.list());
  app.get('/api/inbox', async request => {
    const query = request.query as { limit?: string };
    return { history: runtime.inboxHistory(query.limit ? Number(query.limit) : undefined) };
  });
  app.get('/api/projects/:projectId/entries', async request => {
    const params = request.params as { projectId: string };
    const query = request.query as { q?: string; limit?: string };
    return {
      entries: runtime.projectEntries(params.projectId, query.q ?? '', query.limit ? Number(query.limit) : 80),
    };
  });
  app.get('/api/conversations', async request => {
    const query = request.query as { archived?: string };
    return runtime.conversations.list({ archived: query.archived === 'true' });
  });
  app.post('/api/conversations', async request => {
    const body = request.body as { projectId?: string; title?: string; text?: string; attachments?: AttachmentInput[]; model?: string; thinkingLevel?: string; requestId: string };
    return runtime.conversations.create({
      ...(body.projectId ? { projectId: body.projectId } : {}),
      ...(body.title ? { title: body.title } : {}),
      ...(body.text ? { text: body.text } : {}),
      ...(Array.isArray(body.attachments) ? { attachments: body.attachments } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.thinkingLevel ? { thinkingLevel: body.thinkingLevel } : {}),
      requestId: body.requestId,
    });
  });
  app.get('/api/conversations/:conversationId', async request => {
    const params = request.params as { conversationId: string };
    const query = request.query as { after?: string; before?: string; limit?: string };
    return runtime.conversations.view(params.conversationId, {
      ...(query.after ? { after: Number(query.after) } : {}),
      ...(query.before ? { before: Number(query.before) } : {}),
      ...(query.limit ? { limit: Number(query.limit) } : {}),
    });
  });
  app.get('/api/messages/:messageId/attachments/:index', async (request, reply) => {
    const { messageId, index } = request.params as { messageId: string; index: string };
    const image = runtime.conversations.attachment(messageId, Number(index));
    reply.header('cache-control', 'private, max-age=3600');
    reply.header('x-content-type-options', 'nosniff');
    return reply.type(image.type).send(image.bytes);
  });
  app.get('/api/conversations/:conversationId/history', async request => {
    const { conversationId } = request.params as { conversationId: string };
    const query = request.query as { after?: string; before?: string; limit?: string };
    return runtime.conversations.history(conversationId, {
      ...(query.after ? { after: Number(query.after) } : {}),
      ...(query.before ? { before: Number(query.before) } : {}),
      ...(query.limit ? { limit: Number(query.limit) } : {}),
    });
  });
  app.get('/api/conversations/:conversationId/artifacts', async request => {
    const { conversationId } = request.params as { conversationId: string };
    const query = request.query as Record<string, string | undefined>;
    return runtime.artifacts.listConversation(conversationId, {
      ...(query.namespace ? { namespace: query.namespace } : {}),
      ...(query.prefix ? { prefix: query.prefix } : {}),
      ...(query.schema ? { schema: query.schema } : {}),
      ...(query.tag ? { tag: query.tag } : {}),
      ...(query.trust && ['unverified', 'reviewed', 'accepted'].includes(query.trust)
        ? { trust: query.trust as 'unverified' | 'reviewed' | 'accepted' }
        : {}),
      ...(query.includeRetired === 'true' ? { includeRetired: true } : {}),
      ...(query.latestOnly === 'false' ? { latestOnly: false } : {}),
      ...(query.limit ? { limit: Number(query.limit) } : {}),
    });
  });
  app.get('/api/conversations/:conversationId/draft-graph', async request => {
    const params = request.params as { conversationId: string };
    const query = request.query as { version?: string };
    const view = await runtime.conversations.view(params.conversationId, { limit: 1 });
    const requested = query.version === undefined ? null : Number(query.version);
    if (requested !== null && (!Number.isSafeInteger(requested) || requested < 1)) {
      throw new RuntimeError('invalid_input', 'version must be a positive integer');
    }
    const proposal = requested === null
      ? view.proposal
      : await runtime.conversations.proposal(params.conversationId, requested);
    const spec = proposal?.spec;
    if (!spec) return { nodes: [], containers: [], loops: [], layout: { positions: {}, edges: [] } };
    const layout = await layoutGraph({ nodes: spec.nodes, containers: spec.containers ?? [], loops: spec.loops ?? [] });
    return {
      nodes: spec.nodes.map(node => {
        const fork = Boolean(node.context?.sourceNode)
          || Boolean(node.context?.requiredFacts?.some(fact => fact.kind === 'transcript_range' || fact.kind === 'tool_call'));
        return {
          id: node.id,
          kind: node.kind,
          status: 'draft',
          container: node.container,
          action: node.action,
          definitionVersion: node.definitionVersion,
          model: node.model,
          dependsOn: node.dependsOn ?? [],
          context: node.context ?? null,
          contextMode: node.kind === 'agent' ? (fork ? 'fork' : 'fresh') : null,
          agent: node.kind === 'agent' ? graphAgentDetail(runtime, node.definitionVersion) : null,
        };
      }),
      containers: spec.containers ?? [], loops: spec.loops ?? [], layout,
    };
  });
  app.get('/api/conversations/:conversationId/proposals/:version', async request => {
    const params = request.params as { conversationId: string; version: string };
    const version = Number(params.version);
    if (!Number.isSafeInteger(version) || version < 1) throw new RuntimeError('invalid_input', 'version must be a positive integer');
    return runtime.conversations.proposal(params.conversationId, version);
  });
  app.post('/api/conversations/:conversationId/messages', async request => {
    const params = request.params as { conversationId: string };
    const body = request.body as { text: string; requestId: string; attachments?: AttachmentInput[] };
    return runtime.conversations.chat(params.conversationId, {
      text: body.text,
      requestId: body.requestId,
      ...(Array.isArray(body.attachments) ? { attachments: body.attachments } : {}),
    });
  });
  app.post('/api/conversations/:conversationId/messages/:messageId/cancel', async request => {
    const params = request.params as { conversationId: string; messageId: string };
    const body = request.body as { requestId: string };
    return runtime.conversations.cancelMessage(params.conversationId, {
      messageId: params.messageId,
      requestId: body.requestId,
    });
  });
  app.post('/api/conversations/:conversationId/model', async request => {
    const params = request.params as { conversationId: string };
    const body = request.body as { model: string; thinkingLevel: string; requestId: string };
    return runtime.conversations.selectModel(params.conversationId, {
      model: body.model,
      thinkingLevel: body.thinkingLevel as ThinkingLevel,
      requestId: body.requestId,
    });
  });
  app.post('/api/conversations/:conversationId/compact', async request => {
    const params = request.params as { conversationId: string };
    const body = request.body as { requestId: string };
    return runtime.conversations.compact(params.conversationId, { requestId: body.requestId });
  });
  app.post('/api/conversations/:conversationId/archive', async request => {
    const params = request.params as { conversationId: string };
    const body = request.body as { requestId: string };
    return runtime.conversations.archive(params.conversationId, body.requestId);
  });
  app.post('/api/conversations/:conversationId/unarchive', async request => {
    const params = request.params as { conversationId: string };
    const body = request.body as { requestId: string };
    return runtime.conversations.unarchive(params.conversationId, body.requestId);
  });
  app.post('/api/conversations/:conversationId/bind', async request => {
    const params = request.params as { conversationId: string };
    const body = request.body as { projectId: string; requestId: string };
    return runtime.conversations.bind(params.conversationId, { projectId: body.projectId, requestId: body.requestId });
  });
  app.post('/api/conversations/:conversationId/confirm', async request => {
    const params = request.params as { conversationId: string };
    const body = request.body as { proposalVersion: number; targetBranch: string; requestId: string };
    return runtime.conversations.confirm(params.conversationId, { proposalVersion: body.proposalVersion, targetBranch: body.targetBranch, requestId: body.requestId });
  });
  app.post('/api/conversations/:conversationId/pause', async request => {
    const params = request.params as { conversationId: string };
    const body = request.body as { requestId: string };
    return runtime.conversations.pause(params.conversationId, body.requestId);
  });
  app.post('/api/conversations/:conversationId/resume', async request => {
    const params = request.params as { conversationId: string };
    const body = request.body as { requestId: string };
    return runtime.conversations.resume(params.conversationId, body.requestId);
  });
  app.post('/api/conversations/:conversationId/steer', async request => {
    const params = request.params as { conversationId: string };
    const body = request.body as { requestId: string };
    return runtime.conversations.steer(params.conversationId, { requestId: body.requestId });
  });
  app.post('/api/conversations/:conversationId/interrupt', async request => {
    const params = request.params as { conversationId: string };
    const body = request.body as { requestId: string };
    return runtime.conversations.interrupt(params.conversationId, { requestId: body.requestId });
  });
  app.get('/api/conversations/:conversationId/events', async request => {
    const params = request.params as { conversationId: string };
    const query = request.query as { after?: string; limit?: string };
    return runtime.conversations.events(params.conversationId, Number(query.after ?? 0), query.limit ? Number(query.limit) : 200);
  });
  app.get('/api/conversations/:conversationId/events/stream', async (request, reply) => {
    const params = request.params as { conversationId: string };
    const after = Number((request.query as { after?: string }).after ?? 0);
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // An idle snapshot attach has no replay events to flush the headers.
    reply.raw.flushHeaders();
    const watch = runtime.conversations.watch(params.conversationId, after);
    const abort = () => { void watch.return?.(); };
    request.raw.on('close', abort);
    try {
      for await (const event of watch) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } finally { request.raw.off('close', abort); await watch.return?.(); reply.raw.end(); }
  });
  app.post('/api/tasks', async request => {
    const body = request.body as { projectId: string; request: string; requestId: string };
    return runtime.user.begin({ projectId: body.projectId, request: body.request, requestId: body.requestId });
  });
  app.get('/api/tasks/:taskId', async request => runtime.user.task((request.params as { taskId: string }).taskId).view());
  app.post('/api/tasks/:taskId/say', async request => {
    const params = request.params as { taskId: string };
    const body = request.body as { text: string; requestId: string };
    return runtime.user.task(params.taskId).say(body.text, body.requestId);
  });
  app.post('/api/tasks/:taskId/accept', async request => {
    const params = request.params as { taskId: string };
    const body = request.body as { proposalVersion: number; targetBranch: string; requestId: string };
    return runtime.user.task(params.taskId).accept({ proposalVersion: body.proposalVersion, targetBranch: body.targetBranch, requestId: body.requestId });
  });
  app.post('/api/tasks/:taskId/abandon', async request => {
    const params = request.params as { taskId: string };
    const body = request.body as { requestId: string; reason?: string };
    return runtime.user.task(params.taskId).abandon(body.requestId, body.reason);
  });
  app.post('/api/tasks/:taskId/pause', async request => {
    const params = request.params as { taskId: string };
    const body = request.body as { requestId: string };
    return runtime.user.task(params.taskId).pause(body.requestId);
  });
  app.post('/api/tasks/:taskId/resume', async request => {
    const params = request.params as { taskId: string };
    const body = request.body as { requestId: string };
    return runtime.user.task(params.taskId).resume(body.requestId);
  });
  app.post('/api/tasks/:taskId/budget', async request => {
    const params = request.params as { taskId: string };
    const body = request.body as { nodeId: string; tokens: number | null; requestId: string };
    return runtime.user.task(params.taskId).setBudget(body);
  });
  app.post('/api/tasks/:taskId/answer', async request => {
    const params = request.params as { taskId: string };
    const body = request.body as { questionId: string; answer: Parameters<ReturnType<Runtime['user']['task']>['answer']>[1]; requestId: string };
    return runtime.user.task(params.taskId).answer(body.questionId, body.answer, body.requestId);
  });
  app.get('/api/tasks/:taskId/events', async request => {
    const params = request.params as { taskId: string };
    const query = request.query as { after?: string; limit?: string };
    const after = Number(query.after ?? 0);
    return runtime.events(params.taskId, after, query.limit ? Number(query.limit) : 200);
  });
  app.get('/api/tasks/:taskId/events/stream', async (request, reply) => {
    const params = request.params as { taskId: string };
    const after = Number((request.query as { after?: string }).after ?? 0);
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const watch = runtime.user.task(params.taskId).watch(after);
    // A client disconnect must end the server-side iterator, or the daemon
    // shutdown would wait on a stream nobody can consume.
    const abort = () => { void watch.return?.(); };
    request.raw.on('close', abort);
    try {
      for await (const event of watch) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } finally { request.raw.off('close', abort); await watch.return?.(); reply.raw.end(); }
  });
  app.post('/api/tasks/:taskId/nodes/:nodeId/messages', async request => {
    const { taskId, nodeId } = request.params as { taskId: string; nodeId: string };
    const body = request.body as { text: string; requestId: string };
    return runtime.sendNodeMessage(taskId, nodeId, body);
  });
  app.get('/api/tasks/:taskId/nodes/:nodeId/run', async request => {
    const params = request.params as { taskId: string; nodeId: string };
    const query = request.query as { after?: string; before?: string; limit?: string };
    return runtime.nodeRun(params.taskId, params.nodeId, {
      ...(query.after !== undefined ? { after: Number(query.after) } : {}),
      ...(query.before !== undefined ? { before: Number(query.before) } : {}),
      ...(query.limit ? { limit: Number(query.limit) } : {}),
    });
  });
  app.get('/api/tasks/:taskId/nodes/:nodeId/prompt', async request => {
    const params = request.params as { taskId: string; nodeId: string };
    return runtime.nodePrompt(params.taskId, params.nodeId);
  });
  app.get('/api/tasks/:taskId/operations', async request => {
    const params = request.params as { taskId: string };
    const query = request.query as { after?: string; before?: string; latest?: string; nodeId?: string; limit?: string };
    return runtime.operations(params.taskId, {
      ...(query.after ? { after: query.after } : {}), ...(query.before ? { before: query.before } : {}),
      ...(query.nodeId ? { nodeId: query.nodeId } : {}), latest: query.latest === 'true',
      limit: query.limit ? Number(query.limit) : 50,
    });
  });
  app.get('/api/tasks/:taskId/graph', async request => {
    const params = request.params as { taskId: string };
    const view = await runtime.user.task(params.taskId).view();
    const layout = await layoutGraph({ nodes: view.nodes, containers: view.containers, loops: view.loops });
    return {
      nodes: view.nodes.map(node => ({
        ...node,
        agent: graphAgentDetail(runtime, node.boundDefinition),
      })),
      containers: view.containers, loops: view.loops, revisions: view.revisions, layout, cost: view.cost,
      messages: runtime.graphMessages(params.taskId),
      handoffs: runtime.graphHandoffs(params.taskId),
    };
  });
  app.get('/api/tasks/:taskId/artifacts', async request => {
    const { taskId } = request.params as { taskId: string };
    const query = request.query as Record<string, string | undefined>;
    return runtime.artifacts.list(taskId, {
      ...(query.artifactId ? { artifactId: query.artifactId } : {}),
      ...(query.namespace ? { namespace: query.namespace } : {}),
      ...(query.prefix ? { prefix: query.prefix } : {}),
      ...(query.schema ? { schema: query.schema } : {}),
      ...(query.tag ? { tag: query.tag } : {}),
      ...(query.trust && ['unverified', 'reviewed', 'accepted'].includes(query.trust)
        ? { trust: query.trust as 'unverified' | 'reviewed' | 'accepted' }
        : {}),
      ...(query.includeRetired === 'true' ? { includeRetired: true } : {}),
      ...(query.latestOnly === 'false' ? { latestOnly: false } : {}),
      ...(query.limit ? { limit: Number(query.limit) } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  });
  app.get('/api/projects/:projectId/artifacts', async request => {
    const { projectId } = request.params as { projectId: string };
    const query = request.query as Record<string, string | undefined>;
    return runtime.artifacts.listProject(projectId, {
      // An index of everything published in this project also reads what its tasks published.
      ...(query.include === 'task' ? { includeTaskArtifacts: true } : {}),
      ...(query.namespace ? { namespace: query.namespace } : {}),
      ...(query.prefix ? { prefix: query.prefix } : {}),
      ...(query.schema ? { schema: query.schema } : {}),
      ...(query.tag ? { tag: query.tag } : {}),
      ...(query.trust ? { trust: query.trust as 'unverified' | 'reviewed' | 'accepted' } : {}),
      ...(query.includeRetired === 'true' ? { includeRetired: true } : {}),
      ...(query.latestOnly === 'false' ? { latestOnly: false } : {}),
      ...(query.limit ? { limit: Number(query.limit) } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  });

  app.get('/api/tasks/:taskId/artifacts/:artifactId', async request => {
    const { taskId, artifactId } = request.params as { taskId: string; artifactId: string };
    const { version, scope } = request.query as { version?: string; scope?: string };
    if (scope !== undefined && scope !== 'task' && scope !== 'project') {
      throw new RuntimeError('invalid_artifact', 'scope must be task or project');
    }
    return runtime.artifacts.get(taskId, artifactId, version ? Number(version) : undefined, scope);
  });
  app.get('/api/tasks/:taskId/artifacts/:artifactId/:version/content', async (request, reply) => {
    const { taskId, artifactId, version } = request.params as { taskId: string; artifactId: string; version: string };
    const scope = (request.query as { scope?: string }).scope;
    const result = await runtime.artifacts.read(taskId, artifactId, Number(version), 262_144, scope === 'task' || scope === 'project' ? scope : undefined);
    if ((request.query as { download?: string }).download === 'true') {
      reply.header('content-disposition', `attachment; filename="${result.record.name}"`);
      return reply.type(result.record.mediaType).send(await readFile(result.path));
    }
    return {
      artifact: result.record,
      text: result.text,
      truncated: result.truncated,
      bytes: result.bytes,
      events: result.events,
    };
  });
  app.post('/api/tasks/:taskId/artifacts/:artifactId/:version/retire', async request => {
    const { taskId, artifactId, version } = request.params as { taskId: string; artifactId: string; version: string };
    const body = request.body as { reason?: unknown; requestId?: unknown };
    if (typeof body?.reason !== 'string' || typeof body?.requestId !== 'string') {
      throw new RuntimeError('invalid_input', 'reason and requestId are required');
    }
    return runtime.artifacts.retire({
      taskId,
      artifactId,
      version: Number(version),
      reason: body.reason,
      requestId: body.requestId,
    });
  });
  app.post('/api/tasks/:taskId/artifacts/:artifactId/:version/promote', async request => {
    const { taskId, artifactId, version } = request.params as { taskId: string; artifactId: string; version: string };
    const body = request.body as { requestId?: unknown };
    if (typeof body?.requestId !== 'string') throw new RuntimeError('invalid_input', 'requestId is required');
    return runtime.artifacts.promote({
      taskId,
      artifactId,
      version: Number(version),
      requestId: body.requestId,
    });
  });
  app.get('/api/catalog', async () => ({
    definitions: runtime.catalog.definitions(),
    capabilities: runtime.catalog.capabilities(),
    agentCombinations: runtime.catalog.agentCombinations(),
    capabilityRoot: runtime.catalog.capabilityRootPath() ?? null,
    agentCombinationFile: runtime.catalog.agentCombinationFilePath() ?? null,
    agentCombinationError: runtime.catalog.agentCombinationError() ?? null,
  }));
  app.post('/api/catalog/refresh', async () => runtime.catalog.refreshCatalog());
  app.get('/api/catalog/pi-extension-updates', async () => runtime.catalog.piExtensionUpdates());
  // Browsing the official Pi package channel is read-only: npm, filtered by the `pi-package`
  // keyword the Pi documentation names. Adding a package stays a deliberate request to the Main Agent.
  app.get('/api/catalog/pi-packages', async request => {
    const query = request.query as { q?: string; limit?: string };
    const limit = Number.parseInt(query.limit ?? '', 10);
    return {
      packages: await searchPiPackages({
        ...(query.q?.trim() ? { query: query.q } : {}),
        ...(Number.isFinite(limit) ? { limit } : {}),
      }),
    };
  });
  app.post('/api/catalog/pi-extensions/:id/:version/update', async request => {
    const params = request.params as { id: string; version: string };
    return runtime.catalog.updatePiExtension(params.id, params.version);
  });
  app.post('/api/catalog/combinations', async request => {
    const body = request.body as { combination?: AgentCombination } | undefined;
    if (!body?.combination) throw new RuntimeError('invalid_input', 'combination is required');
    return runtime.catalog.saveAgentCombination(body.combination);
  });
  app.post('/api/catalog/combinations/:id/description', async request => {
    const params = request.params as { id: string };
    const body = request.body as { description?: unknown } | undefined;
    if (typeof body?.description !== 'string') throw new RuntimeError('invalid_input', 'description is required');
    return runtime.catalog.updateAgentCombinationDescription(params.id, body.description);
  });
  app.delete('/api/catalog/combinations/:id', async request => {
    const params = request.params as { id: string };
    return runtime.catalog.deleteAgentCombination(params.id);
  });
  app.post('/api/catalog/combinations/:id/compile', async request => {
    const params = request.params as { id: string };
    return runtime.catalog.compileAgentCombination(params.id);
  });
  app.get('/api/catalog/definitions/:definitionId', async request => {
    const params = request.params as { definitionId: string };
    const query = request.query as { version?: string; scope?: string };
    return runtime.talent(params.definitionId, {
      ...(query.version ? { version: Number(query.version) } : {}),
      ...(query.scope === 'all' ? { allVersions: true } : {}),
    });
  });

  if (options.webDir) {
    app.get('/assets/*', async (request, reply) => {
      const relative = request.url.replace(/^\//, '');
      const file = join(options.webDir!, relative);
      if (!file.startsWith(options.webDir!)) return reply.status(403).send();
      const body = await readFile(file).catch(() => null);
      if (!body) return reply.status(404).send();
      reply.type(relative.endsWith('.css') ? 'text/css' : relative.endsWith('.png') ? 'image/png' : 'text/javascript').send(body);
    });
  }
  void options.origin;
  return app;
}

function defaultPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Graph</title></head><body><div id="root">Graph</div></body></html>`;
}
