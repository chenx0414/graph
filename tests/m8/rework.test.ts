import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { InMemoryCredentialStore, normalizeContext } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { startGraphDaemon, type GraphDaemon } from '../../src/server/start.ts';
import { openGraphServer } from '../../src/server/host.ts';
import { createModelScheduler } from '../../src/runtime/model-scheduler.ts';
import { controlledOpenAIStream } from '../../src/runtime/controlled-openai.ts';
import { git } from '../../src/git/git.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
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
    // The daemon only ever serves a console this test never opens. A stub keeps the suite
    // independent of the repository build output, which a fresh checkout does not have.
    const web = join(root, 'web');
    await mkdir(web, { recursive: true });
    await writeFile(join(web, 'index.html'), '<!doctype html><html><body><div id="root">Graph</div></body></html>');
    const daemon = await startGraphDaemon({
      configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir: web, port: 0, mode: 'execute',
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

test('tasks record the effective revision immediately after a hot apply', async () => {
  const root = await temp('revision');
  const web = join(root, 'web');
  await mkdir(web, { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><html><body><div id="root">Graph</div></body></html>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }], credentials: {}, limits: {} }, null, 2));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const cookie = home.headers.get('set-cookie') ?? '';
  const headers = { origin: daemon.url, cookie, 'content-type': 'application/json' };
  const saved = await fetch(`${daemon.url}/api/config`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 0, document: { version: 1, projects: [{ id: 'p', root }], credentials: {}, limits: {} } }) });
  expect(await saved.json()).toMatchObject({ revision: 1, effectiveRevision: 1, applied: true, restartRequired: false });
  const first = await (await fetch(`${daemon.url}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'p', request: 'before restart', requestId: 'begin-1' }) })).json() as { taskId: string };
  const firstEvents = await (await fetch(`${daemon.url}/api/tasks/${first.taskId}/events?after=0`, { headers })).json() as { type: string; data: { configRevision?: number } }[];
  // The save was applied to this daemon, so the very next task records the new revision.
  expect(firstEvents.find(event => event.type === 'task.created')?.data.configRevision).toBe(1);
  await daemon.close();
  const restarted = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined });
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
    const events = await stream(model, normalizeContext({ messages: [{ role: 'user', content: 'x', timestamp: Date.now() }] }));
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

test('resumed waiters re-acquire the global Agent execution slot', async () => {
  const root = await temp('resume-cap');
  const provider = await trackingProvider({ delayMs: 1_000 });
  const scheduler = createModelScheduler();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const piModel = { id: 'a', name: 'p-a', provider: 'p-a', api: 'openai-completions' as const, baseUrl: provider.baseUrl, reasoning: false, input: ['text' as const], contextWindow: 32_000, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  modelRuntime.registerProvider('p-a', { baseUrl: provider.baseUrl, api: 'openai-completions', apiKey: 'key-a', models: [piModel] });
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: {
      entries: [{ id: 'a', provider: 'p-a', grade: 'high', api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'cred-a' }],
      apiKey: 'unused', modelRuntime, modelScheduler: scheduler,
      credentialFor: () => ({ credentialId: 'cred-a', apiKey: 'key-a', limit: 20 }),
    },
    actions: {
      check: {
        kind: 'program',
        prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: join(root, 'ok'), digest: 'd'.repeat(64) } }] }),
      },
    },
  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId } = await server.runtime.user.begin({ projectId: 'p', request: 'resume cap', requestId: 'begin' });
  const nodes: NodeSpec[] = [
    ...Array.from({ length: 20 }, (_unused, index) => ({ id: `a${index}`, kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'a' })),
    checkNode(Array.from({ length: 20 }, (_unused, index) => `a${index}`)),
  ];
  await server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'resume cap',
    acceptance: [{ id: 'works', description: 'works', checkNode: 'check' }],
    nodes,
  }, 'proposal');
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });

  const holds = await Promise.all(Array.from({ length: 20 }, () => scheduler.acquire({ credentialId: 'cred-a', apiKey: 'key-a', limit: 20 })));
  const driving = server.runtime.host.drive();
  await waitFor(() => scheduler.queued() === 20, 30_000);
  expect(provider.state.requests).toHaveLength(0);
  for (const release of holds) release();
  await waitFor(() => provider.state.requests.length === 20, 90_000);
  // The key may run 20 in flight, but the global Agent limit is independent.
  expect(provider.state.maxInFlight).toBeLessThanOrEqual(10);
  await driving;
  const view = await server.runtime.user.task(taskId).view();
  expect(view.nodes.filter(node => node.id.startsWith('a')).every(node => node.status === 'succeeded')).toBe(true);
  expect(scheduler.active()).toBe(0);
}, 180_000);

test('conflicting alias groups are refused at save time and a hand-edited conflict still starts view-only', async () => {
  const root = await temp('alias-conflict');
  const web = join(root, 'web');
  await mkdir(web, { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><html><body><div id="root">Graph</div></body></html>');
  const configPath = join(root, 'graph.config.json');
  const model = (id: string, credentialId: string) => ({ id, provider: `p-${id}`, grade: 'high', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', contextWindow: 32_000, maxTokens: 256, credentialId });
  const valid = {
    version: 1,
    projects: [{ id: 'p', root }],
    models: { entries: [model('alpha', 'cred-a'), model('beta', 'cred-b')] },
    credentials: { 'cred-a': { secretRef: 'KEY_A', sharedLimitGroupId: 'g1' }, 'cred-b': { secretRef: 'KEY_B', sharedLimitGroupId: 'g1' } },
    limits: { credentials: { 'cred-a': 1, 'cred-b': 1 }, sharedGroups: { g1: 2 } },
  };
  await writeFile(configPath, JSON.stringify(valid, null, 2));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), webDir: web, port: 0, mode: 'view', env: { KEY_A: 'same-key', KEY_B: 'same-key' }, log: () => undefined });
  cleanup.push(() => daemon.close().catch(() => undefined));
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const beforeBytes = await readFile(configPath, 'utf8');
  const conflicts = [
    { ...valid, credentials: { 'cred-a': { secretRef: 'KEY_A', sharedLimitGroupId: 'g1' }, 'cred-b': { secretRef: 'KEY_B', sharedLimitGroupId: 'g2' } }, limits: { credentials: { 'cred-a': 1, 'cred-b': 1 }, sharedGroups: { g1: 2, g2: 3 } } },
    { ...valid, credentials: { 'cred-a': { secretRef: 'KEY_A', sharedLimitGroupId: 'g1' }, 'cred-b': { secretRef: 'KEY_A', sharedLimitGroupId: 'g2' } }, limits: { credentials: { 'cred-a': 1, 'cred-b': 1 }, sharedGroups: { g1: 2, g2: 3 } } },
  ];
  for (const document of conflicts) {
    const refused = await fetch(`${daemon.url}/api/config`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 0, document }) });
    expect(refused.status).toBe(400);
    const body = await refused.json() as { code: string; field?: string };
    expect(body.code).toBe('invalid_config');
    expect(body.field).toContain('sharedLimitGroupId');
    expect(await readFile(configPath, 'utf8')).toBe(beforeBytes);
    expect((await (await fetch(`${daemon.url}/api/config`, { headers })).json() as { revision: number }).revision).toBe(0);
  }
  // A fixed document saves and restarts cleanly.
  const fixed = await fetch(`${daemon.url}/api/config`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 0, document: valid }) });
  expect(fixed.status).toBe(200);
  await daemon.close();

  // A hand-edited conflict must not stop the console; execute mode still refuses it.
  const handEdited = JSON.stringify(conflicts[0], null, 2);
  await writeFile(configPath, handEdited);
  const viewOnly = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), webDir: web, port: 0, mode: 'view', env: { KEY_A: 'same-key', KEY_B: 'same-key' }, log: () => undefined });
  cleanup.push(() => viewOnly.close().catch(() => undefined));
  const home2 = await fetch(viewOnly.url, { headers: { origin: viewOnly.url } });
  const startup = await (await fetch(`${viewOnly.url}/api/startup`, { headers: { origin: viewOnly.url, cookie: home2.headers.get('set-cookie') ?? '' } })).json() as { configured: boolean; enabledModelCount: number };
  expect(startup.configured).toBe(false);
  expect(startup.enabledModelCount).toBe(0);
  await viewOnly.close();
  await expect(startGraphDaemon({ configPath, stateDir: join(root, 'state'), webDir: web, port: 0, mode: 'execute', env: { KEY_A: 'same-key', KEY_B: 'same-key' }, log: () => undefined }))
    .rejects.toMatchObject({ code: 'invalid_config' });
  expect(await readFile(configPath, 'utf8')).toBe(handEdited);
}, 60_000);

test('a paused pre-send refusal is not a success and the nodes run after resume', async () => {
  const root = await temp('pause-refusal');
  const provider = await trackingProvider({ delayMs: 100 });
  const scheduler = createModelScheduler();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const piModel = { id: 'a', name: 'p-a', provider: 'p-a', api: 'openai-completions' as const, baseUrl: provider.baseUrl, reasoning: false, input: ['text' as const], contextWindow: 32_000, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  modelRuntime.registerProvider('p-a', { baseUrl: provider.baseUrl, api: 'openai-completions', apiKey: 'key-a', models: [piModel] });
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: {
      entries: [{ id: 'a', provider: 'p-a', grade: 'high', api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'cred-a' }],
      apiKey: 'unused', modelRuntime, modelScheduler: scheduler,
      credentialFor: () => ({ credentialId: 'cred-a', apiKey: 'key-a', limit: 20 }),
    },
    actions: {
      check: {
        kind: 'program',
        prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: join(root, 'ok'), digest: 'e'.repeat(64) } }] }),
      },
    },
  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId } = await server.runtime.user.begin({ projectId: 'p', request: 'pause refusal', requestId: 'begin' });
  const nodes: NodeSpec[] = [
    ...Array.from({ length: 20 }, (_unused, index) => ({ id: `a${index}`, kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'a' })),
    { id: 'check', kind: 'program', action: 'check', dependsOn: Array.from({ length: 20 }, (_unused, index) => `a${index}`) },
  ];
  await server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'pause refusal',
    acceptance: [{ id: 'works', description: 'works', checkNode: 'check' }],
    nodes,
  }, 'proposal');
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });

  const holds = await Promise.all(Array.from({ length: 20 }, () => scheduler.acquire({ credentialId: 'cred-a', apiKey: 'key-a', limit: 20 })));
  const driving = server.runtime.host.drive();
  await waitFor(() => scheduler.queued() === 20, 30_000);
  await server.runtime.user.task(taskId).pause('pause-queued');
  for (const release of holds) release();
  await driving;
  await waitFor(() => scheduler.active() === 0 && scheduler.queued() === 0, 15_000);
  const paused = await server.runtime.user.task(taskId).view();
  expect(provider.state.requests).toHaveLength(0);
  expect(paused.nodes.filter(node => node.id.startsWith('a')).every(node => node.status !== 'succeeded')).toBe(true);
  expect(paused.nodes.find(node => node.id === 'check')?.status).toBe('pending');
  expect(paused.operations.filter(operation => operation.nodeId.startsWith('a')).every(operation => operation.state === 'not_sent')).toBe(true);

  await server.runtime.user.task(taskId).resume('resume-queued');
  await server.runtime.host.drive();
  await waitFor(() => provider.state.requests.length === 20, 60_000);
  await waitFor(async () => {
    const view = await server.runtime.user.task(taskId).view();
    return view.nodes.every(node => node.status === 'succeeded');
  }, 60_000);
  expect(provider.state.maxInFlight).toBeLessThanOrEqual(10);
  expect(scheduler.active()).toBe(0);
}, 180_000);

test('a pause after partial work keeps the operation interrupted and resumable', async () => {
  const root = await temp('partial-pause');
  let task: { pause(requestId: string): Promise<unknown> } | undefined;
  const provider = await openaiServer([
    { tools: [{ id: 'write-1', name: 'write', arguments: JSON.stringify({ path: 'partial.txt', content: 'partial output' }) }] },
    { text: 'Work complete after resume' },
  ]);
  cleanup.push(() => provider.close());
  // Pause before the second model send, after the tool effect has happened.
  const baseScheduler = createModelScheduler();
  let acquisitions = 0;
  const modelScheduler = {
    ...baseScheduler,
    acquire: async (request: Parameters<typeof baseScheduler.acquire>[0], signal?: AbortSignal) => {
      acquisitions += 1;
      if (acquisitions === 2) await task!.pause('pause-after-tool-effect');
      return baseScheduler.acquire(request, signal);
    },
  };
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime, modelScheduler,
      credentialFor: () => ({ credentialId: 'cred', apiKey: 'scripted-local-key', limit: 2 }),
    },
    actions: {
      check: {
        kind: 'program',
        prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'synthetic', artifact: { path: join(root, 'ok'), digest: 'a'.repeat(64) } }] }),
      },
    },
  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const begun = await server.runtime.user.begin({ projectId: 'p', request: 'partial pause', requestId: 'begin' });
  const userTask = server.runtime.user.task(begun.taskId);
  task = userTask;
  await server.runtime.supervisor(begun.taskId).propose({
    requirementVersion: 1, summary: 'partial pause',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await userTask.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await server.runtime.host.drive();
  await waitFor(async () => (await userTask.view()).operations[0]?.state === 'interrupted', 15_000);

  const paused = await userTask.view();
  expect(provider.requests).toHaveLength(1);
  expect(paused.operations[0]).toMatchObject({ state: 'interrupted', workerActive: false, result: null, reserved: 0 });
  expect(paused.invocations[0]?.usage).toMatchObject({ input: 25, output: 10, cacheRead: 15 });
  expect(paused.nodes.find(node => node.id === 'work')).toMatchObject({ status: 'pending', used: 50 });
  expect(paused.nodes.find(node => node.id === 'check')?.status).toBe('pending');
  expect(paused.questions).toEqual([]);
  const partialTree = paused.operations.filter(operation => operation.nodeId === 'work').at(-1)!.workspace!;
  expect(await readFile(join(partialTree, 'partial.txt'), 'utf8')).toBe('partial output');

  await userTask.resume('resume-partial');
  await server.runtime.host.drive();
  const completed = await userTask.view();
  expect(provider.requests).toHaveLength(2);
  expect(completed.nodes.every(node => node.status === 'succeeded')).toBe(true);
  // Two real calls (first tool turn + resumed turn), each counted exactly once.
  expect(completed.nodes.find(node => node.id === 'work')?.used).toBe(100);
  const completedTree = completed.operations.filter(operation => operation.nodeId === 'work').at(-1)!.workspace!;
  expect(await readFile(join(completedTree, 'partial.txt'), 'utf8')).toBe('partial output');
}, 90_000);

async function interruptedUnknown(check: 'usage' | 'reconcile') {
  const root = await temp(`unknown-${check}`);
  const provider = await openaiServer([
    { usage: null, tools: [{ id: 'write-1', name: 'write', arguments: JSON.stringify({ path: 'partial.txt', content: 'partial output' }) }] },
    { text: 'Work complete after release' },
  ]);
  cleanup.push(() => provider.close());
  let task: { pause(requestId: string): Promise<unknown> } | undefined;
  const baseScheduler = createModelScheduler();
  let acquisitions = 0;
  const modelScheduler = {
    ...baseScheduler,
    acquire: async (request: Parameters<typeof baseScheduler.acquire>[0], signal?: AbortSignal) => {
      acquisitions += 1;
      if (acquisitions === 2) await task!.pause('pause-unknown-after-effect');
      return baseScheduler.acquire(request, signal);
    },
  };
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    limits: { defaultBudgetTokens: 20_000_000 },
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime, modelScheduler,
      credentialFor: () => ({ credentialId: 'cred', apiKey: 'scripted-local-key', limit: 2 }),
    },
    actions: {
      check: {
        kind: 'program',
        prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'synthetic', artifact: { path: join(root, 'ok'), digest: 'a'.repeat(64) } }] }),
      },
    },
  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const begun = await server.runtime.user.begin({ projectId: 'p', request: `unknown ${check}`, requestId: 'begin' });
  const userTask = server.runtime.user.task(begun.taskId);
  task = userTask;
  await server.runtime.supervisor(begun.taskId).propose({
    requirementVersion: 1, summary: 'unknown usage pause',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await userTask.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await server.runtime.host.drive();
  await waitFor(async () => {
    const view = await userTask.view();
    return view.operations[0]?.state === 'interrupted' && view.questions.some(question => question.kind === 'unknown_usage' && question.status === 'open');
  }, 15_000);
  const question = (await userTask.view()).questions.find(item => item.kind === 'unknown_usage' && item.status === 'open')!;
  if (check === 'usage') {
    await userTask.answer(question.id, { type: 'usage', usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 }, proof: 'synthetic provider bill' }, 'answer-usage');
  } else {
    await userTask.answer(question.id, { type: 'reconcile_usage', proof: 'provider exposes no usage' }, 'answer-reconcile');
  }
  const answered = await userTask.view();
  expect(answered.questions.filter(item => item.status === 'open')).toEqual([]);
  expect(answered.nodes.find(node => node.id === 'work')).toMatchObject({ status: 'pending', used: check === 'usage' ? 50 : 0 });
  await expect(userTask.answer(question.id, { type: 'reconcile_usage', proof: 'duplicate' }, 'answer-again')).rejects.toMatchObject({ code: 'invalid_question' });

  await userTask.resume('resume-after-answer');
  await server.runtime.host.drive();
  const completed = await userTask.view();
  expect(completed.nodes.every(node => node.status === 'succeeded')).toBe(true);
  expect(provider.requests).toHaveLength(2);
  // The unknown invocation is either recorded (50) or kept unknown; the resumed
  // call adds its own 50 exactly once.
  expect(completed.nodes.find(node => node.id === 'work')?.used).toBe(check === 'usage' ? 100 : 50);
}

test('interrupted unknown usage can be recorded or released and then resumes', async () => {
  await interruptedUnknown('usage');
  await interruptedUnknown('reconcile');
}, 120_000);

async function interruptedMixed(check: 'usage' | 'reconcile') {
  const root = await temp(`mixed-${check}`);
  const provider = await openaiServer([
    { tools: [{ id: 'write-1', name: 'write', arguments: JSON.stringify({ path: 'partial.txt', content: 'partial output' }) }] },
    { usage: null, tools: [{ id: 'write-2', name: 'write', arguments: JSON.stringify({ path: 'second.txt', content: 'second turn' }) }] },
    { text: 'Work complete after release' },
  ]);
  cleanup.push(() => provider.close());
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    limits: { defaultBudgetTokens: 20_000_000 },
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime,
      credentialFor: () => ({ credentialId: 'cred', apiKey: 'scripted-local-key', limit: 2 }),
    },
    actions: {
      check: {
        kind: 'program',
        prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'synthetic', artifact: { path: join(root, 'ok'), digest: 'a'.repeat(64) } }] }),
      },
    },
  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const begun = await server.runtime.user.begin({ projectId: 'p', request: `mixed ${check}`, requestId: 'begin' });
  const userTask = server.runtime.user.task(begun.taskId);
  await server.runtime.supervisor(begun.taskId).propose({
    requirementVersion: 1, summary: 'mixed usage pause',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await userTask.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await server.runtime.host.drive();
  await waitFor(async () => {
    const view = await userTask.view();
    return view.operations[0]?.state === 'interrupted' && view.questions.some(question => question.kind === 'unknown_usage' && question.status === 'open');
  }, 20_000);
  const before = await userTask.view();
  const partialTree = before.operations.filter(operation => operation.nodeId === 'work').at(-1)!.workspace!;
  expect(await readFile(join(partialTree, 'partial.txt'), 'utf8')).toBe('partial output');
  expect(before.invocations.filter(invocation => invocation.usage === null)).toHaveLength(1);
  // The known model call is preserved; the zero-usage tool invocation adds nothing.
  expect(before.invocations.some(invocation => invocation.usage !== null && invocation.usage.input > 0)).toBe(true);
  expect(before.nodes.find(node => node.id === 'work')?.used).toBe(0);
  const question = before.questions.find(item => item.kind === 'unknown_usage' && item.status === 'open')!;
  if (check === 'usage') {
    await userTask.answer(question.id, { type: 'usage', usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 }, proof: 'synthetic provider bill' }, 'mixed-usage');
  } else {
    await userTask.answer(question.id, { type: 'reconcile_usage', proof: 'provider exposes no usage' }, 'mixed-reconcile');
  }
  const answered = await userTask.view();
  expect(answered.questions.filter(item => item.status === 'open')).toEqual([]);
  // Known invocations are applied once; the unknown one is either recorded or kept unknown.
  expect(answered.nodes.find(node => node.id === 'work')?.used).toBe(check === 'usage' ? 100 : 50);
  await server.runtime.host.drive();
  const completed = await userTask.view();
  expect(completed.nodes.every(node => node.status === 'succeeded')).toBe(true);
  expect(completed.nodes.find(node => node.id === 'work')?.used).toBe(check === 'usage' ? 150 : 100);
  const completedTree = completed.operations.filter(operation => operation.nodeId === 'work').at(-1)!.workspace!;
  expect(await readFile(join(completedTree, 'partial.txt'), 'utf8')).toBe('partial output');
}

test('mixed known and unknown usage can be reconciled and continue', async () => {
  await interruptedMixed('usage');
  await interruptedMixed('reconcile');
}, 120_000);

async function interruptedRework(check: 'usage' | 'reconcile') {
  const root = await temp(`rework-${check}`);
  const provider = await openaiServer([
    { text: 'first incomplete implementation' },
    { usage: null, tools: [{ id: 'fix-1', name: 'write', arguments: JSON.stringify({ path: 'fix.txt', content: 'fix' }) }] },
    { text: 'real second round completion' },
  ]);
  cleanup.push(() => provider.close());
  let checks = 0;
  const successorInputs: { dependencies: unknown; inputVersions: unknown }[] = [];
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    limits: { defaultBudgetTokens: 20_000_000 },
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime,
      credentialFor: () => ({ credentialId: 'cred', apiKey: 'scripted-local-key', limit: 2 }),
    },
    actions: {
      check: {
        kind: 'program',
        prepare: async operation => async () => {
          checks += 1;
          if (checks === 1) return { outcome: 'completed', output: { kind: 'verification', outcome: 'rework', subjects: [], reports: [], blockers: [{ id: 'needs-fix', reason: 'synthetic rework required', evidence: [] }] } };
          successorInputs.push({ dependencies: operation.dependencies, inputVersions: operation.inputVersions });
          return { outcome: 'completed', output: { passed: true }, evidence: [{ acceptanceId: 'ok', summary: 'synthetic observing check', artifact: { path: join(root, 'ok'), digest: 'a'.repeat(64) } }] };
        },
      },
    },
  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const begun = await server.runtime.user.begin({ projectId: 'p', request: `rework ${check}`, requestId: 'begin' });
  const userTask = server.runtime.user.task(begun.taskId);
  await server.runtime.supervisor(begun.taskId).propose({
    requirementVersion: 1, summary: 'rework interrupted usage',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    loops: [{ from: 'check', to: 'work' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await userTask.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await server.runtime.host.drive();
  await waitFor(async () => {
    const view = await userTask.view();
    return view.operations.some(operation => operation.state === 'interrupted') && view.questions.some(question => question.kind === 'unknown_usage' && question.status === 'open');
  }, 20_000);
  const before = await userTask.view();
  const roundOne = before.operations.find(operation => operation.nodeId === 'work' && operation.state === 'succeeded')!;
  const roundTwo = before.operations.find(operation => operation.nodeId === 'work' && operation.state === 'interrupted')!;
  const work = before.nodes.find(node => node.id === 'work')!;
  expect(roundOne.activationId).not.toBe(roundTwo.activationId);
  expect(roundOne.result).toMatchObject({ outcome: 'completed', output: { text: 'first incomplete implementation' } });
  expect(roundTwo.result).toBeNull();
  expect(work.status).toBe('blocked');
  expect(work.outputVersion).toBe(1);
  expect(checks).toBe(1);
  const question = before.questions.find(item => item.kind === 'unknown_usage' && item.status === 'open')!;
  if (check === 'usage') {
    await userTask.answer(question.id, { type: 'usage', usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 }, proof: 'synthetic provider bill' }, 'rework-usage');
  } else {
    await userTask.answer(question.id, { type: 'reconcile_usage', proof: 'provider exposes no usage' }, 'rework-reconcile');
  }
  const answered = await userTask.view();
  // The interrupted round must stay pending for its own activation: the first
  // round's success is history and cannot satisfy the waiting dependency.
  expect(answered.questions.filter(item => item.status === 'open')).toEqual([]);
  expect(answered.phase).toBe('running');
  expect(answered.nodes.find(node => node.id === 'work')).toMatchObject({ status: 'pending', instanceId: work.instanceId, activationId: roundTwo.activationId, outputVersion: 1, used: check === 'usage' ? 100 : 50 });
  expect(answered.nodes.find(node => node.id === 'check')?.status).toBe('pending');
  expect(checks).toBe(1);
  await expect(userTask.answer(question.id, { type: 'reconcile_usage', proof: 'duplicate' }, 'rework-again')).rejects.toMatchObject({ code: 'invalid_question' });
  expect((await userTask.view()).nodes.find(node => node.id === 'work')?.used).toBe(check === 'usage' ? 100 : 50);

  await server.runtime.host.drive();
  const completed = await userTask.view();
  expect(completed.phase).toBe('completed');
  expect(provider.requests).toHaveLength(3);
  expect(checks).toBe(2);
  expect(successorInputs).toHaveLength(1);
  expect(successorInputs[0]!.dependencies).toMatchObject({ work: { text: 'real second round completion' } });
  expect(successorInputs[0]!.inputVersions).toMatchObject({ work: [{ activationId: roundTwo.activationId, outputVersion: 2 }] });
  expect(completed.nodes.find(node => node.id === 'work')).toMatchObject({ status: 'succeeded', instanceId: work.instanceId, outputVersion: 2, used: check === 'usage' ? 150 : 100 });
  expect(completed.invocations.filter(invocation => invocation.operationId === roundTwo.id && invocation.usage === null)).toHaveLength(check === 'usage' ? 0 : 1);
  expect(completed.operations.some(operation => operation.id === roundOne.id && operation.state === 'succeeded')).toBe(true);
}

test('a rework round interrupted for unknown usage continues instead of reusing the previous success', async () => {
  await interruptedRework('usage');
  await interruptedRework('reconcile');
}, 180_000);
