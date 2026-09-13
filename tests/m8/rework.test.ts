import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { startGraphDaemon, type GraphDaemon } from '../../src/server/start.ts';
import { openGraphServer } from '../../src/server/host.ts';
import { createModelScheduler } from '../../src/runtime/model-scheduler.ts';
import { controlledOpenAIStream } from '../../src/runtime/controlled-openai.ts';
import { git } from '../../src/git/git.ts';
import type { NodeSpec } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-rework-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** Streaming provider that tracks real concurrency per Authorization header. */
async function trackingProvider(options: { delayMs?: number } = {}) {
  const state = { requests: [] as { authorization: string; model: string }[], inFlight: 0, maxInFlight: 0, maxByKey: new Map<string, number>(), byKey: new Map<string, number>() };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { model?: string } : {};
    const key = request.headers.authorization ?? '';
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const current = (state.byKey.get(key) ?? 0) + 1;
    state.byKey.set(key, current);
    state.maxByKey.set(key, Math.max(state.maxByKey.get(key) ?? 0, current));
    state.requests.push({ authorization: key, model: body.model ?? '' });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] })}\n\n`);
    await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 200));
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
    response.end('data: [DONE]\n\n');
    state.inFlight -= 1;
    state.byKey.set(key, current - 1);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { state, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

async function gitProject(root: string) {
  const project = join(root, 'project');
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, 'test', 'check.js'), 'console.log("ok");\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'init']);
  return project;
}

function checkNode(dependsOn: string[]): NodeSpec {
  return { id: 'check', kind: 'program', action: 'graph.command', dependsOn, input: { command: 'node', args: ['test/check.js'] } };
}

test('credential aliases resolving to the same actual key share one limit', async () => {
  for (const aliasing of ['same-ref', 'same-value'] as const) {
    const root = await temp(`alias-${aliasing}`);
    const project = await gitProject(root);
    const provider = await trackingProvider({ delayMs: 250 });
    const credentials = aliasing === 'same-ref'
      ? { 'cred-a': { secretRef: 'KEY_A' }, 'cred-b': { secretRef: 'KEY_A' } }
      : { 'cred-a': { secretRef: 'KEY_A' }, 'cred-b': { secretRef: 'KEY_B' } };
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      models: { entries: [
        { id: 'alpha', provider: 'p-alpha', grade: 'high', api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'cred-a' },
        { id: 'beta', provider: 'p-beta', grade: 'high', api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'cred-b' },
      ] },
      credentials,
      limits: { credentials: { 'cred-a': 1, 'cred-b': 1 } },
    }));
    const daemon = await startGraphDaemon({
      configPath, stateDir: join(root, 'state'), webDir: join(process.cwd(), 'dist', 'web'), port: 0, mode: 'execute',
      env: { KEY_A: 'one-actual-key', KEY_B: 'one-actual-key' }, log: () => undefined,
    });
    cleanup.push(() => daemon.close());
    const { taskId } = await daemon.server.runtime.user.begin({ projectId: 'p', request: `alias ${aliasing}`, requestId: 'begin' });
    // Complete the discussion-only master node the same way a real confirmation would.
    await daemon.server.runtime.host.drive();
    await daemon.server.runtime.supervisor(taskId).propose({
      requirementVersion: 1, summary: 'aliases',
      acceptance: [{ id: 'works', description: 'works', checkNode: 'check' }],
      nodes: [
        { id: 'workA', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'alpha' },
        { id: 'workB', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'beta' },
        checkNode(['workA', 'workB']),
      ],
    }, 'proposal');
    await daemon.server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
    await daemon.server.runtime.host.drive();
    await waitFor(() => provider.state.requests.length === 3, 15_000);
    expect(provider.state.requests).toHaveLength(3);
    expect(provider.state.requests.every(request => request.authorization === 'Bearer one-actual-key')).toBe(true);
    expect(provider.state.maxInFlight).toBe(1);
    const view = await daemon.server.runtime.user.task(taskId).view();
    expect(view.nodes.filter(node => ['workA', 'workB', 'check'].includes(node.id)).map(node => node.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(view.evidence.filter(evidence => evidence.acceptanceId === 'works' && evidence.valid)).toHaveLength(1);
    const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
    const startup = await (await fetch(`${daemon.url}/api/startup`, { headers: { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '' } })).json() as { limitAliases?: Record<string, string> };
    expect(JSON.stringify(startup)).not.toContain('one-actual-key');
    expect(startup.limitAliases).toMatchObject({ 'cred-b': 'cred-a' });
    await daemon.close();
  }
}, 60_000);

test('ten waiters on key A do not block an independent key B', async () => {
  const root = await temp('independent-key');
  const provider = await trackingProvider({ delayMs: 50 });
  const scheduler = createModelScheduler();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const piModel = (id: string, name: string) => ({ id, name, provider: name, api: 'openai-completions' as const, baseUrl: provider.baseUrl, reasoning: false, input: ['text' as const], contextWindow: 32_000, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  modelRuntime.registerProvider('p-a', { baseUrl: provider.baseUrl, api: 'openai-completions', apiKey: 'key-a', models: [piModel('a', 'p-a')] });
  modelRuntime.registerProvider('p-b', { baseUrl: provider.baseUrl, api: 'openai-completions', apiKey: 'key-b', models: [piModel('b', 'p-b')] });
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: {
      entries: [
        { id: 'a', provider: 'p-a', grade: 'high', api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'cred-a' },
        { id: 'b', provider: 'p-b', grade: 'high', api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'cred-b' },
      ],
      apiKey: 'unused', modelRuntime,
      modelScheduler: scheduler,
      credentialFor: entry => entry.id === 'a'
        ? { credentialId: 'cred-a', apiKey: 'key-a', limit: 1 }
        : { credentialId: 'cred-b', apiKey: 'key-b' },
    },
    actions: {
      check: {
        kind: 'program',
        prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: join(root, 'ok'), digest: 'c'.repeat(64) } }] }),
      },
    },
  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId } = await server.runtime.user.begin({ projectId: 'p', request: 'waiters', requestId: 'begin' });
  const nodes: NodeSpec[] = [
    ...Array.from({ length: 10 }, (_unused, index) => ({ id: `a${index}`, kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'a' })),
    { id: 'b', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'b' },
    checkNode([...Array.from({ length: 10 }, (_unused, index) => `a${index}`), 'b']),
  ];
  await server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'waiters',
    acceptance: [{ id: 'works', description: 'works', checkNode: 'check' }],
    nodes,
  }, 'proposal');
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });

  const held = await scheduler.acquire({ credentialId: 'cred-a', limit: 1 });
  const driving = server.runtime.host.drive();
  await waitFor(() => scheduler.queued() === 10, 15_000);
  // The independent key must send while A is still fully queued.
  await waitFor(() => provider.state.requests.some(request => request.authorization === 'Bearer key-b'), 15_000);
  expect(provider.state.requests.some(request => request.authorization === 'Bearer key-a')).toBe(false);
  await waitFor(async () => (await server.runtime.user.task(taskId).view()).nodes.find(node => node.id === 'b')?.status === 'succeeded', 15_000);
  await server.runtime.user.task(taskId).pause('pause-waiters');
  held();
  await driving;
  expect(scheduler.active()).toBe(0);
  expect(provider.state.maxByKey.get('Bearer key-a') ?? 0).toBeLessThanOrEqual(1);
}, 60_000);

test('tasks record the effective revision, not a saved-but-unrestarted one', async () => {
  const root = await temp('revision');
  const web = join(root, 'web');
  await mkdir(web, { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><html><body><div id="root">Graph</div></body></html>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }], credentials: {}, limits: {} }, null, 2));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const cookie = home.headers.get('set-cookie') ?? '';
  const headers = { origin: daemon.url, cookie, 'content-type': 'application/json' };
  const saved = await fetch(`${daemon.url}/api/config`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 0, document: { version: 1, projects: [{ id: 'p', root }], credentials: {}, limits: {} } }) });
  expect(await saved.json()).toMatchObject({ revision: 1, restartRequired: true });
  const first = await (await fetch(`${daemon.url}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'p', request: 'before restart', requestId: 'begin-1' }) })).json() as { taskId: string };
  const firstEvents = await (await fetch(`${daemon.url}/api/tasks/${first.taskId}/events?after=0`, { headers })).json() as { type: string; data: { configRevision?: number } }[];
  expect(firstEvents.find(event => event.type === 'task.created')?.data.configRevision).toBe(0);
  await daemon.close();
  const restarted = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined });
  cleanup.push(() => restarted.close());
  const home2 = await fetch(restarted.url, { headers: { origin: restarted.url } });
  const headers2 = { origin: restarted.url, cookie: home2.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const second = await (await fetch(`${restarted.url}/api/tasks`, { method: 'POST', headers: headers2, body: JSON.stringify({ projectId: 'p', request: 'after restart', requestId: 'begin-2' }) })).json() as { taskId: string };
  const secondEvents = await (await fetch(`${restarted.url}/api/tasks/${second.taskId}/events?after=0`, { headers: headers2 })).json() as { type: string; data: { configRevision?: number } }[];
  expect(secondEvents.find(event => event.type === 'task.created')?.data.configRevision).toBe(1);
});

test('a project removed from the config keeps its history but cannot receive new tasks', async () => {
  const root = await temp('project-removal');
  const web = join(root, 'web');
  await mkdir(web, { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><html><body><div id="root">Graph</div></body></html>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'keep', root }, { id: 'drop', root }], credentials: {}, limits: {} }, null, 2));
  let daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined });
  cleanup.push(() => daemon.close().catch(() => undefined));
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const first = await fetch(`${daemon.url}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'drop', request: 'historical', requestId: 'begin-1' }) });
  expect(first.status).toBe(200);
  await daemon.close();
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'keep', root }], credentials: {}, limits: {} }, null, 2));
  daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined });
  cleanup.push(() => daemon.close().catch(() => undefined));
  const home2 = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers2 = { origin: daemon.url, cookie: home2.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const settings = await (await fetch(`${daemon.url}/api/settings`, { headers: headers2 })).json() as { projects: { id: string }[] };
  expect(settings.projects.map(project => project.id)).toEqual(['keep']);
  const tasks = await (await fetch(`${daemon.url}/api/tasks`, { headers: headers2 })).json() as { id: string }[];
  expect(tasks).toHaveLength(1);
  const refused = await fetch(`${daemon.url}/api/tasks`, { method: 'POST', headers: headers2, body: JSON.stringify({ projectId: 'drop', request: 'no more', requestId: 'begin-2' }) });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ code: 'invalid_input' });
  const stillThere = await (await fetch(`${daemon.url}/api/tasks/${(tasks[0]!).id}`, { headers: headers2 })).json() as { projectId: string };
  expect(stillThere.projectId).toBe('drop');
});

test('a retry re-acquires the slot only after releasing it for the backoff', async () => {
  const scheduler = createModelScheduler();
  const closed = createNetServer();
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', () => resolve()));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>(resolve => closed.close(() => resolve()));
  const model = {
    id: 'local', name: 'local', provider: 'graph-openai', api: 'openai-completions' as const,
    baseUrl: `http://127.0.0.1:${port}/v1`, reasoning: false, input: ['text' as const], contextWindow: 32_000, maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let dispatches = 0;
  const broker = { dispatch<T>(_id: string, _reservation: number, send: () => T): T { dispatches += 1; return send(); }, settle() { /* usage not recorded in this probe */ } };
  const slot = { acquire: (signal?: AbortSignal) => scheduler.acquire({ credentialId: 'cred', limit: 1 }, signal) };
  const stream = controlledOpenAIStream(broker, 'key', slot);
  const running = (async () => {
    const events = await stream(model, { messages: [{ role: 'user', content: 'x', timestamp: Date.now() }] });
    await events.result();
  })();
  // During the first backoff the slot must be free for another acquisition.
  await waitFor(() => dispatches === 1, 10_000);
  await waitFor(() => scheduler.active('cred') === 0, 5_000);
  const other = await scheduler.acquire({ credentialId: 'cred', limit: 1 });
  expect(scheduler.active('cred')).toBe(1);
  other();
  await running;
  expect(dispatches).toBe(3);
  expect(scheduler.active('cred')).toBe(0);
}, 30_000);
