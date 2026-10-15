import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { InMemoryCredentialStore, normalizeContext } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openGraphServer } from '../../src/server/host.ts';
import { createModelScheduler } from '../../src/runtime/model-scheduler.ts';
import { controlledOpenAIStream } from '../../src/runtime/controlled-openai.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';

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

/** Use main's native interface path, without inferred dependencies or fabricated check evidence. */
async function startWorkers(runtime: Awaited<ReturnType<typeof openTaskRuntime>>, projectId: string, models: Record<string, string>, onOwner?: (id: string) => void) {
  const owner = await runtime.user.begin({ projectId, request: 'Provider admission contracts', requestId: 'begin' });
  onOwner?.(owner.taskId);
  const main = runtime.supervisor(owner.taskId);
  const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({
    schemaVersion: 2, name: 'Provider admission', protocols: { job: { type: 'object' } },
    nodes: Object.fromEntries(Object.entries(models).map(([id, model]) => [id, {
      recipe: 'coder@1', model, task: 'Reply to the explicit input.', inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {},
    }])), modules: {}, edges: {},
  }) }) as { graphId: string };
  for (const nodeId of Object.keys(models)) await main.graphSend({ graphId, nodeId, input: 'job', value: { request: nodeId } });
  return graphId;
}



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

  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const graphId = await startWorkers(server.runtime, 'p', { ...Object.fromEntries(Array.from({ length: 10 }, (_unused, index) => [`a${index}`, 'a'])), b: 'b' });

  const held = await scheduler.acquire({ credentialId: 'cred-a', limit: 1 });
  const driving = server.runtime.host.drive();
  await waitFor(() => scheduler.queued() === 10, 15_000);
  // The independent key must send while A is still fully queued.
  await waitFor(() => provider.state.requests.some(request => request.authorization === 'Bearer key-b'), 15_000);
  expect(provider.state.requests.some(request => request.authorization === 'Bearer key-a')).toBe(false);
  await waitFor(async () => (await server.runtime.user.task(graphId).view()).nodes.find(node => node.id === 'b')?.status === 'succeeded', 15_000);
  await server.runtime.user.task(graphId).pause('pause-waiters');
  held();
  await driving;
  expect(scheduler.active()).toBe(0);
  expect(provider.state.maxByKey.get('Bearer key-a') ?? 0).toBeLessThanOrEqual(1);
}, 60_000);





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

  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const graphId = await startWorkers(server.runtime, 'p', Object.fromEntries(Array.from({ length: 20 }, (_unused, index) => [`a${index}`, 'a'])));

  const holds = await Promise.all(Array.from({ length: 20 }, () => scheduler.acquire({ credentialId: 'cred-a', apiKey: 'key-a', limit: 20 })));
  const driving = server.runtime.host.drive();
  await waitFor(() => scheduler.queued() === 20, 30_000);
  expect(provider.state.requests).toHaveLength(0);
  for (const release of holds) release();
  await waitFor(() => provider.state.requests.length === 20, 90_000);
  // The key may run 20 in flight, but the global Agent limit is independent.
  expect(provider.state.maxInFlight).toBeLessThanOrEqual(10);
  await driving;
  const view = await server.runtime.user.task(graphId).view();
  expect(view.nodes.filter(node => node.id.startsWith('a')).every(node => node.status === 'succeeded')).toBe(true);
  expect(scheduler.active()).toBe(0);
}, 180_000);



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

  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const graphId = await startWorkers(server.runtime, 'p', Object.fromEntries(Array.from({ length: 20 }, (_unused, index) => [`a${index}`, 'a'])));

  const holds = await Promise.all(Array.from({ length: 20 }, () => scheduler.acquire({ credentialId: 'cred-a', apiKey: 'key-a', limit: 20 })));
  const driving = server.runtime.host.drive();
  await waitFor(() => scheduler.queued() === 20, 30_000);
  await server.runtime.user.task(graphId).pause('pause-queued');
  for (const release of holds) release();
  await driving;
  await waitFor(() => scheduler.active() === 0 && scheduler.queued() === 0, 15_000);
  const paused = await server.runtime.user.task(graphId).view();
  expect(provider.state.requests).toHaveLength(0);
  expect(paused.nodes.filter(node => node.id.startsWith('a')).every(node => node.status !== 'succeeded')).toBe(true);
  expect(paused.invocations).toHaveLength(0);
  for (const node of paused.nodes) {
    const run = server.runtime.nodeRun(graphId, node.id);
    expect(run.instance!.used).toBe(0);
    expect(run.operations).toHaveLength(1);
    expect(run.operations[0]).toMatchObject({ state: 'blocked', retries_used: 0, workerActive: false, reserved: 0 });
  }

  await server.runtime.user.task(graphId).resume('resume-queued');
  await server.runtime.host.drive();
  await waitFor(() => provider.state.requests.length === 20, 60_000);
  await waitFor(async () => {
    const view = await server.runtime.user.task(graphId).view();
    return view.nodes.every(node => node.status === 'succeeded');
  }, 60_000);
  expect(provider.state.maxInFlight).toBeLessThanOrEqual(10);
  expect(scheduler.active()).toBe(0);
}, 180_000);

const write = (path: string, content: string, unknown = false): ResponsePlan => ({
  ...(unknown ? { usage: null } : {}), tools: [{ id: path, name: 'write_file', arguments: JSON.stringify({ path, content }) }],
});

async function partialWork(plans: ResponsePlan[], pauseAfterWrite = false) {
  const root = await temp('native-partial'); const project = join(root, 'project'); await mkdir(project);
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  const provider = await openaiServer(plans); cleanup.push(() => provider.close());
  const baseScheduler = createModelScheduler(); let acquisitions = 0; let graphId = '';
  let runtime!: Awaited<ReturnType<typeof openTaskRuntime>>;
  const modelScheduler = { ...baseScheduler, acquire: async (request: Parameters<typeof baseScheduler.acquire>[0], signal?: AbortSignal) => {
    if (++acquisitions === 2 && pauseAfterWrite) await runtime.user.task(graphId).pause('pause-after-write');
    return baseScheduler.acquire(request, signal);
  } };
  runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }],
    limits: { defaultBudgetTokens: 20000000 }, catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }],
      apiKey: 'local-only', modelRuntime: provider.runtime, modelScheduler, credentialFor: () => ({ credentialId: 'cred', apiKey: 'local-only', limit: 2 }) },
  }); cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  let ownerId = '';
  graphId = await startWorkers(runtime, 'p', { work: 'local' }, id => { ownerId = id; });
  const main = runtime.supervisor(ownerId);
  return { runtime, provider, project, graphId, main, task: runtime.user.task(graphId),
    run: () => runtime.nodeRun(graphId, 'work'), calls: () => main.graphInspect({ graphId, query: 'provider_calls' }),
    queue: () => main.graphInspect({ graphId, query: 'queue' }),
  };
}

test('a pause after partial work preserves the real file and continues the same execution and session', async () => {
  const f = await partialWork([write('partial.txt', 'partial output'), { text: 'Work complete after resume' }], true);
  await f.runtime.host.drive(); const before = f.run();
  expect(f.provider.requests).toHaveLength(1);
  expect(before.node.status).toBe('idle'); expect(before.instance!.used).toBe(50);
  expect(before.operations).toHaveLength(1);
  expect(before.operations[0]).toMatchObject({ state: 'blocked', workerActive: false, reserved: 0, retries_used: 0 });
  expect(before.invocations[0]!.usage).toMatchObject({ input: 25, output: 10, cacheRead: 15 });
  expect(await readFile(join(f.project, 'partial.txt'), 'utf8')).toBe('partial output');
  await f.task.resume('resume-partial'); await f.runtime.host.drive(); const after = f.run();
  expect(f.provider.requests).toHaveLength(2); expect(after.node.status).toBe('succeeded');
  expect(after.instance).toMatchObject({ id: before.instance!.id, used: 100 });
  expect(after.session!.sessionId).toBe(before.session!.sessionId);
  expect(after.operations).toMatchObject([{ id: before.operations[0]!.id, state: 'completed', retries_used: 0 }]);
  expect(await readFile(join(f.project, 'partial.txt'), 'utf8')).toBe('partial output');
  expect(JSON.stringify(f.provider.requests[1])).toContain('write_file');
}, 60000);
