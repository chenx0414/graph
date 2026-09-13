import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import { RuntimeError } from '../core/types.ts';
import type { openTaskRuntime } from '../core/task-runtime.ts';
import { createSession, guard, localOrigin, setSessionCookie } from './auth.ts';
import { layoutGraph } from './layout.ts';

import type { StartupInfo } from './host.ts';

type Runtime = Awaited<ReturnType<typeof openTaskRuntime>>;

export async function createApp(runtime: Runtime, options: { origin: string; webDir?: string; startup?: StartupInfo }) {
  const app = Fastify({ logger: false });
  const session = createSession();
  const html = options.webDir ? await readFile(join(options.webDir, 'index.html'), 'utf8').catch(() => defaultPage()) : defaultPage();

  app.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { statusCode?: number; code?: string };
    const status = typeof err.statusCode === 'number' ? err.statusCode : error instanceof RuntimeError ? 400 : 500;
    const code = error instanceof RuntimeError ? error.code : err.code ?? 'internal';
    reply.status(status).send({ code, message: err.message });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/' || request.url.startsWith('/assets/') || request.url === '/api/health') return;
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
  app.get('/api/startup', async () => options.startup ?? { mode: 'view' as const, configured: false, modelCount: 0, enabledModelCount: 0 });
  app.get('/api/settings', async () => {
    const projects = await runtime.user.projects();
    const models = runtime.models();
    const definitions = runtime.catalog.definitions();
    const capabilities = runtime.catalog.capabilities();
    return { projects, models, definitions, capabilities };
  });
  app.get('/api/tasks', async () => runtime.user.list());
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
    try {
      for await (const event of watch) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } finally { await watch.return?.(); reply.raw.end(); }
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
