import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import { RuntimeError } from '../core/types.ts';
import type { openTaskRuntime } from '../core/task-runtime.ts';
import { createSession, guard, localOrigin, setSessionCookie } from './auth.ts';
import { layoutGraph } from './layout.ts';

import type { AppServices, StartupInfo } from './host.ts';
import { sanitizeConfig, type ConfigStore } from './config-service.ts';

type Runtime = Awaited<ReturnType<typeof openTaskRuntime>>;

export async function createApp(runtime: Runtime, options: { origin: string; webDir?: string; startup?: StartupInfo; startupInfo?: () => StartupInfo; config?: { store: ConfigStore; env: Record<string, string | undefined> }; configTest?: (modelId: string) => Promise<unknown>; appServices?: AppServices }) {
  const app = Fastify({ logger: false });
  const session = createSession();
  const html = options.webDir ? await readFile(join(options.webDir, 'index.html'), 'utf8').catch(() => defaultPage()) : defaultPage();

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
    reply.type('text/html').send(html);
  });
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/startup', async () => options.startupInfo?.() ?? options.startup ?? { mode: 'view' as const, configured: false, modelCount: 0, enabledModelCount: 0 });
  app.post('/api/app/secret', async request => {
    if (!options.appServices) throw new RuntimeError('invalid_config', 'The daemon was started without the app bridge');
    const body = request.body as { ref?: unknown; value?: unknown };
    if (typeof body.ref !== 'string') throw new RuntimeError('invalid_input', 'secretRef is required');
    if (body.value !== null && typeof body.value !== 'string') throw new RuntimeError('invalid_input', 'The secret value must be a string or null');
    return options.appServices.pushSecret(body.ref, body.value as string | null);
  });
  app.get('/api/limits', async () => runtime.modelLimits());
  if (options.config) {
    app.get('/api/config', async () => {
      const { revision, config } = await options.config!.store.snapshot();
      const status = options.appServices?.snapshot();
      return {
        revision,
        ...(status ? { effectiveRevision: status.effectiveRevision, configured: status.configured } : {}),
        config: sanitizeConfig(config, options.config!.env),
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
    const definitions = runtime.catalog.definitions();
    const capabilities = runtime.catalog.capabilities();
    return { projects, models, definitions, capabilities };
  });
  app.get('/api/tasks', async () => runtime.user.list());
  app.get('/api/inbox', async request => {
    const query = request.query as { limit?: string };
    return { history: runtime.inboxHistory(query.limit ? Number(query.limit) : undefined) };
  });
  app.get('/api/conversations', async () => runtime.conversations.list());
  app.post('/api/conversations', async request => {
    const body = request.body as { projectId?: string; title?: string; text?: string; requestId: string };
    return runtime.conversations.create({ ...(body.projectId ? { projectId: body.projectId } : {}), ...(body.title ? { title: body.title } : {}), ...(body.text ? { text: body.text } : {}), requestId: body.requestId });
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
  app.get('/api/conversations/:conversationId/draft-graph', async request => {
    const params = request.params as { conversationId: string };
    const view = await runtime.conversations.view(params.conversationId, { limit: 1 });
    const spec = view.proposal?.spec;
    if (!spec) return { nodes: [], containers: [], loops: [], layout: { positions: {}, edges: [] } };
    const layout = await layoutGraph({ nodes: spec.nodes, containers: spec.containers ?? [], loops: spec.loops ?? [] });
    return {
      nodes: spec.nodes.map(node => ({ id: node.id, kind: node.kind, status: 'draft', container: node.container })),
      containers: spec.containers ?? [], loops: spec.loops ?? [], layout,
    };
  });
  app.post('/api/conversations/:conversationId/messages', async request => {
    const params = request.params as { conversationId: string };
    const body = request.body as { text: string; requestId: string };
    return runtime.conversations.chat(params.conversationId, { text: body.text, requestId: body.requestId });
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
  app.get('/api/tasks/:taskId/nodes/:nodeId/run', async request => {
    const params = request.params as { taskId: string; nodeId: string };
    const query = request.query as { after?: string; before?: string; limit?: string };
    return runtime.nodeRun(params.taskId, params.nodeId, {
      ...(query.after !== undefined ? { after: Number(query.after) } : {}),
      ...(query.before !== undefined ? { before: Number(query.before) } : {}),
      ...(query.limit ? { limit: Number(query.limit) } : {}),
    });
  });
  app.get('/api/tasks/:taskId/operations', async request => {
    const params = request.params as { taskId: string };
    const query = request.query as { after?: string; limit?: string };
    return runtime.operations(params.taskId, { ...(query.after ? { after: query.after } : {}), limit: query.limit ? Number(query.limit) : 50 });
  });
  app.get('/api/tasks/:taskId/graph', async request => {
    const params = request.params as { taskId: string };
    const view = await runtime.user.task(params.taskId).view();
    const layout = await layoutGraph({ nodes: view.nodes, containers: view.containers, loops: view.loops });
    return { nodes: view.nodes, containers: view.containers, loops: view.loops, revisions: view.revisions, layout, cost: view.cost };
  });
  app.get('/api/catalog', async () => ({ definitions: runtime.catalog.definitions(), capabilities: runtime.catalog.capabilities() }));
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
      reply.type(relative.endsWith('.css') ? 'text/css' : 'text/javascript').send(body);
    });
  }
  void options.origin;
  return app;
}

function defaultPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Graph</title></head><body><div id="root">Graph</div></body></html>`;
}
