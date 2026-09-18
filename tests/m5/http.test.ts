import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { createApp } from '../../src/server/app.ts';
import type { AppServices } from '../../src/server/host.ts';
import type { ActionAdapter } from '../../src/core/types.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
const origin = 'http://127.0.0.1:1';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function start(actions: Record<string, ActionAdapter>, extra: { models?: boolean; appServices?: AppServices } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-m5-http-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root, grants: ['workspace:write'] }], actions,
    ...(extra.models ? { models: { entries: [{ id: 'local', provider: 'fixture', grade: 'medium' as const, api: 'openai-completions' as const, baseUrl: 'http://127.0.0.1/v1', contextWindow: 1000, maxTokens: 100 }], apiKey: 'test', modelRuntime: {} as never } } : {}),
  });
  cleanup.push(() => runtime.close());
  const app = await createApp(runtime, { origin, ...(extra.appServices ? { appServices: extra.appServices } : {}) });
  cleanup.push(() => app.close());
  const home = await app.inject({ method: 'GET', url: '/', headers: { origin } });
  const cookie = String(home.headers['set-cookie'] ?? '');
  const headers = { origin, cookie, 'content-type': 'application/json' };
  return {
    runtime, app, root,
    get: (url: string) => app.inject({ method: 'GET', url, headers }),
    post: (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers, payload: JSON.stringify(payload) }),
  };
}

test('the capability config API exposes required fields and delegates verification to the app bridge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m5-capability-config-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const capability = join(capabilityRoot, 'configured');
  await mkdir(capability, { recursive: true });
  await writeFile(join(capability, 'capability.json'), JSON.stringify({
    id: 'configured',
    kind: 'mcp',
    version: '1.0.0',
    name: 'Configured MCP',
    url: 'https://example.test/mcp',
    headersEnv: { authorization: 'CONFIGURED_TOKEN' },
  }));
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'project', root }],
    catalog: { capabilityRoot },
  });
  cleanup.push(() => runtime.close());
  const calls: { id: string; version: string; values: Record<string, string> }[] = [];
  const appServices: AppServices = {
    appToken: 'test-token',
    applyConfig: async () => ({ revision: 1, effectiveRevision: 1, applied: true, configured: true, modelCount: 0, enabledModelCount: 0 }),
    pushSecret: async () => ({ revision: 1, effectiveRevision: 1, applied: true, configured: true, modelCount: 0, enabledModelCount: 0 }),
    snapshot: () => ({ revision: 1, effectiveRevision: 1, applied: true, configured: true, modelCount: 0, enabledModelCount: 0 }),
    capabilityConfig: {
      secretValues: () => ({}),
      verify: async (record, values = {}) => {
        calls.push({ id: record.id, version: record.version, values });
        return { ok: true, tools: ['configured_search'], message: '连接成功，发现 1 个工具' };
      },
    },
  };
  const app = await createApp(runtime, { origin, appServices });
  cleanup.push(() => app.close());
  const home = await app.inject({ method: 'GET', url: '/' });
  const cookie = String(home.headers['set-cookie'] ?? '');
  const headers = { origin, cookie, 'content-type': 'application/json' };
  const settings = JSON.parse((await app.inject({ method: 'GET', url: '/api/settings', headers })).body) as {
    capabilityConfig: { id: string; missing: string[] }[];
  };
  expect(settings.capabilityConfig).toEqual([
    expect.objectContaining({ id: 'configured', missing: ['CONFIGURED_TOKEN'] }),
  ]);
  const response = await app.inject({
    method: 'POST',
    url: '/api/capabilities/configured/1.0.0/test',
    headers,
    payload: JSON.stringify({ values: { CONFIGURED_TOKEN: 'secret-value' } }),
  });
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({ ok: true, tools: ['configured_search'] });
  expect(calls).toEqual([{ id: 'configured', version: '1.0.0', values: { CONFIGURED_TOKEN: 'secret-value' } }]);
});

test('HTTP session can begin a task, talk to the master channel, confirm requirements, and list the queue', async () => {
  const { runtime, get, post } = await start({
    check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: '/tmp/x', digest: 'a'.repeat(64) } }] }) },
  });
  const settings = JSON.parse((await get('/api/settings')).body);
  expect(settings.projects).toMatchObject([{ id: 'project' }]);
  const begun = JSON.parse((await post('/api/tasks', { projectId: 'project', request: 'Add search', requestId: 'begin' })).body);
  await post(`/api/tasks/${begun.taskId}/say`, { text: 'Case insensitive', requestId: 'say' });
  const proposed = await runtime.supervisor(begun.taskId).propose({
    requirementVersion: 2, summary: 'Search',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [{ id: 'check', kind: 'program', action: 'check' }],
  }, 'proposal');
  const accepted = await post(`/api/tasks/${begun.taskId}/accept`, { proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  expect(accepted.statusCode).toBe(200);
  const queued = JSON.parse((await post('/api/tasks', { projectId: 'project', request: 'Second feature', requestId: 'begin-2' })).body);
  await runtime.supervisor(queued.taskId).propose({
    requirementVersion: 1, summary: 'Second',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [{ id: 'check', kind: 'program', action: 'check' }],
  }, 'proposal');
  await post(`/api/tasks/${queued.taskId}/accept`, { proposalVersion: 1, targetBranch: 'main', requestId: 'accept-2' });
  const list = JSON.parse((await get('/api/tasks')).body);
  expect(list).toMatchObject([{ phase: 'running' }, { phase: 'queued' }]);
  const view = JSON.parse((await get(`/api/tasks/${begun.taskId}`)).body);
  expect(view).toMatchObject({ request: 'Add search', phase: 'running', messages: [{ text: 'Add search' }, { text: 'Case insensitive' }] });
});

test('pause over HTTP shows pausing then paused, and answering one question leaves other blocks open', async () => {
  const sent = deferred();
  const finish = deferred();
  const { runtime, get, post } = await start({
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
      sent.resolve(); await finish.promise;
      return { outcome: 'waiting', output: null, usage, question: { prompt: 'Format?' } };
    } },
    other: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'waiting', output: null, usage, question: { prompt: 'Other?' } }) },
    check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: '/tmp/x', digest: 'a'.repeat(64) } }] }) },
  });
  const begun = JSON.parse((await post('/api/tasks', { projectId: 'project', request: 'Work', requestId: 'begin' })).body);
  await runtime.supervisor(begun.taskId).propose({
    requirementVersion: 1, summary: 'Work',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'other', kind: 'agent', action: 'other', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work', 'other'] },
    ],
  }, 'proposal');
  await post(`/api/tasks/${begun.taskId}/accept`, { proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  const running = runtime.host.runReady();
  await sent.promise;
  await post(`/api/tasks/${begun.taskId}/pause`, { requestId: 'pause' });
  expect(JSON.parse((await get(`/api/tasks/${begun.taskId}`)).body).status).toBe('pausing');
  finish.resolve();
  await running;
  expect(JSON.parse((await get(`/api/tasks/${begun.taskId}`)).body).status).toBe('paused');
  await post(`/api/tasks/${begun.taskId}/resume`, { requestId: 'resume' });
  await runtime.host.runReady();
  const blocked = JSON.parse((await get(`/api/tasks/${begun.taskId}`)).body);
  const open = blocked.questions.filter((question: { status: string }) => question.status === 'open');
  expect(open.length).toBeGreaterThanOrEqual(2);
  await post(`/api/tasks/${begun.taskId}/answer`, { questionId: open[0]!.id, answer: { type: 'respond', value: 'markdown' }, requestId: 'ans' });
  const after = JSON.parse((await get(`/api/tasks/${begun.taskId}`)).body);
  expect(after.questions.filter((question: { status: string }) => question.status === 'open').length).toBe(open.length - 1);
});

test('cross-origin and unauthenticated calls cannot use the user command channel', async () => {
  const { app, post } = await start({});
  const begun = await post('/api/tasks', { projectId: 'project', request: 'Nope', requestId: 'begin', actor: 'user' });
  expect(begun.statusCode).toBe(200);
  const foreign = await app.inject({
    method: 'POST', url: `/api/tasks/${JSON.parse(begun.body).taskId}/answer`,
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    payload: JSON.stringify({ questionId: 'x', answer: { type: 'acknowledge' }, requestId: 'forge' }),
  });
  expect(foreign.statusCode).toBeGreaterThanOrEqual(400);
  const missing = await app.inject({
    method: 'POST', url: '/api/tasks',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ projectId: 'project', request: 'No cookie', requestId: 'x' }),
  });
  expect(missing.statusCode).toBe(401);
  expect((await post('/api/supervisor/propose', { proposal: {}, requestId: 'x' })).statusCode).toBe(404);
});

test('event cursor reconnects after the HTTP client disconnects while the host keeps running', async () => {
  const { runtime, app, get, post } = await start({
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: { done: true }, usage }) },
    check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: '/tmp/x', digest: 'a'.repeat(64) } }] }) },
  });
  const begun = JSON.parse((await post('/api/tasks', { projectId: 'project', request: 'Work', requestId: 'begin' })).body);
  await runtime.supervisor(begun.taskId).propose({
    requirementVersion: 1, summary: 'Work',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  const first = JSON.parse((await get(`/api/tasks/${begun.taskId}/events?after=0`)).body) as { cursor: number; type: string }[];
  expect(first.some(event => event.type === 'task.created')).toBe(true);
  const cursor = first[first.length - 1]!.cursor;
  await post(`/api/tasks/${begun.taskId}/accept`, { proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const again = JSON.parse((await get(`/api/tasks/${begun.taskId}/events?after=${cursor}`)).body) as { type: string }[];
  expect(again.some(event => event.type === 'task.accepted')).toBe(true);
  expect(JSON.parse((await get(`/api/tasks/${begun.taskId}`)).body).phase).toBe('completed');
  expect(app.hasRoute({ method: 'GET', url: '/api/tasks/:taskId/events/stream' })).toBe(true);
});

test('creating a conversation over HTTP applies the selected model and thinking level', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m5-http-model-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'project', root }],
    actions: {},
    models: {
      entries: [
        {
          id: 'm1', provider: 'fixture', grade: 'medium' as const, api: 'openai-completions' as const,
          baseUrl: 'http://127.0.0.1/v1', contextWindow: 1000, maxTokens: 100, reasoning: false,
        },
        {
          id: 'm2', provider: 'fixture', grade: 'high' as const, api: 'openai-completions' as const,
          baseUrl: 'http://127.0.0.1/v1', contextWindow: 2000, maxTokens: 100, reasoning: true, defaultThinkingLevel: 'low' as const,
        },
      ],
      apiKey: 'test',
      modelRuntime: {} as never,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm1' },
  });
  cleanup.push(() => runtime.close());
  const app = await createApp(runtime, { origin });
  cleanup.push(() => app.close());
  const home = await app.inject({ method: 'GET', url: '/', headers: { origin } });
  const cookie = String(home.headers['set-cookie'] ?? '');
  const headers = { origin, cookie, 'content-type': 'application/json' };

  const created = await app.inject({
    method: 'POST',
    url: '/api/conversations',
    headers,
    payload: JSON.stringify({ text: '选模型', model: 'm2', thinkingLevel: 'high', requestId: 'http-model' }),
  });
  expect(created.statusCode).toBe(200);
  const { conversationId } = created.json() as { conversationId: string };
  expect((await runtime.conversations.view(conversationId)).telemetry).toMatchObject({ model: 'm2', thinkingLevel: 'high' });
});
