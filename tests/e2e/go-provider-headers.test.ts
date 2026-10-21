import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * What travels with a model request.
 *
 * A request carries more than the prompt: it carries the headers the model
 * was configured with, and the routing headers a gateway needs to keep a
 * conversation together. A credential that cannot be resolved disables the
 * model it belongs to and nothing else - the other models keep working, and
 * the reply the user already received is never taken back because an
 * auxiliary call could not be made.
 *
 * And work that was accepted while the daemon could not dispatch it is not
 * lost: the next execute start picks it up.
 *
 * The proof is the real daemon and a real endpoint that records every header
 * it was sent.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface Endpoint {
  baseUrl: string;
  headers: Record<string, string>[];
  authorizations: string[];
  close: () => Promise<void>;
}

async function endpoint(text = 'Answered.'): Promise<Endpoint> {
  const headers: Record<string, string>[] = [];
  const authorizations: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    headers.push(Object.fromEntries(Object.entries(request.headers)
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value ?? ''])));
    authorizations.push(request.headers.authorization ?? '');
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    headers,
    authorizations,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function fixture(
  document: (project: string) => Record<string, unknown>,
  env: Record<string, string>,
  extraArgs: string[] = ['--execute'],
) {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-provider-headers-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify(document(project), null, 2));
  const daemon = await launchCli(root, { configPath, env, extraArgs });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown, text: async () => await response.text() };
  };
  return { root, project, configPath, daemon, request };
}

function model(id: string, provider: string, baseUrl: string, credentialId: string, extra: Record<string, unknown> = {}) {
  return {
    id, provider, grade: 'high', api: 'openai-completions', baseUrl,
    contextWindow: 32000, maxTokens: 256, credentialId, ...extra,
  };
}

interface ConversationView {
  master?: { status?: string; model?: string };
  messages?: { role: string; kind: string; text: string }[];
  questions?: { kind: string; status: string }[];
}

interface EventRow { type: string; data: Record<string, unknown> }

async function conversationEvents(request: (path: string) => Promise<{ body: unknown }>, conversationId: string): Promise<EventRow[]> {
  const response = await request(`/api/conversations/${conversationId}/events?after=0&limit=200`);
  return Array.isArray(response.body) ? response.body as EventRow[] : [];
}

/** The reply the user sees, in the conversation the daemon kept. */
function assistantReply(view: ConversationView): string {
  return (view.messages ?? []).filter(message => message.role === 'assistant')
    .map(message => message.text).join('');
}

test('configured model headers reach the provider on a real dispatch', async () => {
  const provider = await endpoint('header check');
  cleanup.push(() => provider.close());
  const f = await fixture((project) => ({
    version: 1,
    projects: [{ id: 'p', root: project }],
    models: { entries: [model('local', 'graph-openai', provider.baseUrl, 'local', {
      headers: { 'x-opencode-session': 'graph-header-test' },
    })] },
    credentials: { local: { secretRef: 'GRAPH_HEADER_KEY' } },
    limits: { credentials: { local: 1 } },
  }), { GRAPH_HEADER_KEY: 'header-key' });

  const created = await f.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'header task', requestId: 'headers-1' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;

  await expect.poll(async () => {
    const view = await f.request(`/api/conversations/${conversationId}`);
    return (view.body as ConversationView).master?.status;
  }, { timeout: 30_000, interval: 250 }).toBe('succeeded');

  // The request that left the process carried the header and the key.
  expect(provider.headers.length).toBeGreaterThan(0);
  expect(provider.authorizations[0]).toBe('Bearer header-key');
  expect(provider.headers.some(headers => headers['x-opencode-session'] === 'graph-header-test')).toBe(true);

  // The reply reached the conversation instead of being lost on the way.
  const view = (await f.request(`/api/conversations/${conversationId}`)).body as ConversationView;
  expect(assistantReply(view)).toBe('header check');
  expect(view.questions ?? []).toHaveLength(0);
}, 120_000);

test('OpenCode Go adds its routing header to connection tests and real dispatches', async () => {
  const provider = await endpoint('pong');
  cleanup.push(() => provider.close());
  const f = await fixture((project) => ({
    version: 1,
    projects: [{ id: 'p', root: project }],
    models: { entries: [model('opencode-go:deepseek-v4.1-flash', 'opencode-go', provider.baseUrl, 'opencode-go', {
      modelId: 'deepseek-v4.1-flash',
    })] },
    credentials: { 'opencode-go': { secretRef: 'GRAPH_OPENCODE_GO_KEY' } },
    limits: {},
  }), { GRAPH_OPENCODE_GO_KEY: 'opencode-go-key' });

  // The connection test carries the routing header too: a gateway that is
  // asked "can you answer?" must answer the same way the real request does.
  const tested = await f.request('/api/config/test', {
    method: 'POST',
    body: JSON.stringify({ modelId: 'opencode-go:deepseek-v4.1-flash' }),
  });
  expect(tested.status, JSON.stringify(tested.body)).toBe(200);
  expect(tested.body).toMatchObject({ ok: true, model: 'opencode-go:deepseek-v4.1-flash' });
  expect(provider.headers[0]?.['x-opencode-session']).toBeTruthy();

  const created = await f.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'opencode-go:deepseek-v4.1-flash', text: 'header task', requestId: 'headers-2' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;

  await expect.poll(async () => {
    const view = await f.request(`/api/conversations/${conversationId}`);
    return (view.body as ConversationView).master?.status;
  }, { timeout: 30_000, interval: 250 }).toBe('succeeded');

  expect(provider.headers.length).toBeGreaterThan(1);
  expect(provider.headers.slice(1).every(headers => Boolean(headers['x-opencode-session']))).toBe(true);
  const view = (await f.request(`/api/conversations/${conversationId}`)).body as ConversationView;
  expect(assistantReply(view)).toBe('pong');
}, 120_000);

test('an unresolved credential only disables its own model, not dispatch for others', async () => {
  const provider = await endpoint('usable model');
  cleanup.push(() => provider.close());
  const f = await fixture((project) => ({
    version: 1,
    projects: [{ id: 'p', root: project }],
    models: { entries: [
      model('usable', 'graph-openai', provider.baseUrl, 'usable'),
      model('unusable', 'graph-openai-unusable', provider.baseUrl, 'unusable'),
    ] },
    credentials: { usable: { secretRef: 'GRAPH_USABLE_KEY' }, unusable: { secretRef: 'GRAPH_MISSING_KEY' } },
    limits: {},
  }), { GRAPH_USABLE_KEY: 'usable-key' });

  // Two models are configured, one of them can be called.
  const startup = await f.request('/api/startup');
  expect(startup.status).toBe(200);
  expect(startup.body).toMatchObject({ mode: 'execute', configured: true, modelCount: 2, enabledModelCount: 1 });

  const created = await f.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'usable', text: 'partial credentials', requestId: 'headers-3' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;

  await expect.poll(async () => {
    const view = await f.request(`/api/conversations/${conversationId}`);
    return (view.body as ConversationView).master?.status;
  }, { timeout: 30_000, interval: 250 }).toBe('succeeded');
  expect(provider.headers.length).toBeGreaterThan(0);

  // The model without a credential was never asked: the daemon knows the
  // credential is missing and does not spend a call on it.
  const events = await conversationEvents(f.request, conversationId);
  const decision = events.find(event => event.type === 'prompt_suggestion.decided');
  expect(decision, 'the composer suggestion travels with the turn').toBeTruthy();
  expect(decision!.data).toMatchObject({ asked: false, model: null });

  // The turn of the usable model is whole: its reply is in the conversation
  // and nothing parked the master behind a question.
  const view = (await f.request(`/api/conversations/${conversationId}`)).body as ConversationView;
  expect(assistantReply(view)).toBe('usable model');
  expect(view.questions ?? []).toHaveLength(0);
  expect((view.messages ?? []).some(message => message.kind === 'error')).toBe(false);
  expect(events.some(event => event.type === 'operation.unknown')).toBe(false);
}, 120_000);

test('tasks created while dispatch was disabled are recovered on the next execute start', async () => {
  const provider = await endpoint('master ready');
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-master-recovery-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const entry = model('local', 'graph-openai', provider.baseUrl, 'local');
  const viewConfig = join(root, 'view.config.json');
  await writeFile(viewConfig, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }, { id: 'gone', root: project }],
    models: { entries: [entry] },
    credentials: { local: { secretRef: 'GRAPH_RECOVERY_KEY' } },
    limits: {},
  }));
  const executeConfig = join(root, 'execute.config.json');
  await writeFile(executeConfig, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    models: { entries: [entry] },
    credentials: { local: { secretRef: 'GRAPH_RECOVERY_KEY' } },
    limits: {},
  }));

  // View-only: the task is accepted, but nothing may be dispatched.
  const view = await launchCli(root, { configPath: viewConfig, env: {}, extraArgs: [] });
  const begun = await view.request('/api/tasks', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', request: 'queued while view-only', requestId: 'begin' }),
  });
  const taskId = (await begun.json() as { taskId: string }).taskId;
  const gone = await view.request('/api/tasks', {
    method: 'POST', body: JSON.stringify({ projectId: 'gone', request: 'removed project', requestId: 'begin-gone' }),
  });
  const goneTaskId = (await gone.json() as { taskId: string }).taskId;
  const viewOnly = await view.request(`/api/tasks/${taskId}`);
  expect((await viewOnly.json() as { nodes?: unknown[] }).nodes).toHaveLength(0);
  await view.close();

  // Execute: the master is backfilled, becomes active and dispatches.
  const execute = await launchCli(root, { configPath: executeConfig, env: { GRAPH_RECOVERY_KEY: 'recovery-key' }, extraArgs: ['--execute'] });
  cleanup.push(() => execute.close());
  await expect.poll(() => provider.headers.length, { timeout: 60_000, interval: 250 }).toBeGreaterThan(0);
  const recovered = await execute.request(`/api/tasks/${taskId}`);
  const nodes = (await recovered.json() as { nodes?: { id: string; status: string }[] }).nodes ?? [];
  expect(nodes.map(node => node.id)).toContain('master');
  expect(provider.authorizations[0]).toBe('Bearer recovery-key');
  expect(nodes.find(node => node.id === 'master')?.status).toBe('succeeded');

  // The recovery is a fact in the record, not an invisible repair - and the
  // record names what the task was waiting for. The view-only daemon had no
  // key for the model, so that is the reason it gives.
  const taskEvents = await execute.request(`/api/tasks/${taskId}/events?after=0&limit=200`);
  const rows = await taskEvents.json() as { type: string; data: Record<string, unknown> }[];
  const recoveredEvent = rows.find(row => row.type === 'task.master_recovered');
  expect(recoveredEvent, 'the backfilled master is recorded').toBeTruthy();
  expect(recoveredEvent!.data).toMatchObject({ reason: 'No credential bound for model local' });

  // The task of a project that is gone keeps its history but is not recovered.
  const removed = await execute.request(`/api/tasks/${goneTaskId}`);
  expect((await removed.json() as { nodes?: unknown[] }).nodes).toHaveLength(0);
}, 180_000);
