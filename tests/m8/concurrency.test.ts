import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import type { Model } from '@earendil-works/pi-ai';
import { controlledOpenAIStream } from '../../src/runtime/controlled-openai.ts';
import { createModelScheduler, type SlotRequest } from '../../src/runtime/model-scheduler.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import type { SendGate } from '../../src/runtime/controlled-openai.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

function sleep(milliseconds: number) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await sleep(10);
  }
}

function gate() {
  const state = { dispatches: 0 };
  const sendGate: SendGate = {
    dispatch(_id, _reservation, send) { state.dispatches += 1; return send(); },
    settle() { /* usage accounting is exercised elsewhere */ },
  };
  return { gate: sendGate, state };
}

/** Streaming provider that tracks real concurrency per credential header. */
async function provider(options: { bodyDelayMs?: number; status?: number } = {}) {
  const state = { inFlight: 0, maxInFlight: 0, requests: 0, byKey: new Map<string, number>(), maxByKey: new Map<string, number>(), maxGroup: 0 };
  const group = new Map<string, number>();
  const server = createServer(async (request, response) => {
    state.requests += 1;
    const key = request.headers.authorization ?? '';
    const groupKey = key.includes('shared') ? 'shared' : key;
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const keyCount = (state.byKey.get(key) ?? 0) + 1;
    state.byKey.set(key, keyCount);
    state.maxByKey.set(key, Math.max(state.maxByKey.get(key) ?? 0, keyCount));
    const groupCount = (group.get(groupKey) ?? 0) + 1;
    group.set(groupKey, groupCount);
    state.maxGroup = Math.max(state.maxGroup, groupCount);
    for await (const _chunk of request) { /* drain the request body */ }
    if (options.status) {
      response.writeHead(options.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'synthetic failure' } }));
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`);
      await sleep(options.bodyDelayMs ?? 0);
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
      response.end('data: [DONE]\n\n');
    }
    state.inFlight -= 1;
    state.byKey.set(key, (state.byKey.get(key) ?? 1) - 1);
    group.set(groupKey, (group.get(groupKey) ?? 1) - 1);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const model = (): Model<'openai-completions'> => ({
    id: 'local', name: 'local', provider: 'graph-openai', api: 'openai-completions', baseUrl,
    reasoning: false, input: ['text'], contextWindow: 32_000, maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  return { state, model };
}

function slotFor(scheduler: ReturnType<typeof createModelScheduler>, request: SlotRequest) {
  return { acquire: (signal?: AbortSignal) => scheduler.acquire(request, signal) };
}

async function send(stream: ReturnType<typeof controlledOpenAIStream>, model: Model<'openai-completions'>) {
  const events = await stream(model, { messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }] });
  const result = await events.result();
  return result.stopReason;
}

test('one credential never exceeds its cap across aliases and models', async () => {
  const scheduler = createModelScheduler();
  const { state, model } = await provider({ bodyDelayMs: 120 });
  const request: SlotRequest = { credentialId: 'cred-1', limit: 2 };
  const running = Array.from({ length: 5 }, (_unused, index) =>
    send(controlledOpenAIStream(gate().gate, `alias-${index}`, slotFor(scheduler, request)), model()));
  const reasons = await Promise.all(running);
  expect(reasons.every(reason => reason === 'stop')).toBe(true);
  expect(state.maxInFlight).toBeLessThanOrEqual(2);
  expect(state.requests).toBe(5);
  expect(scheduler.active('cred-1')).toBe(0);
  expect(scheduler.queued()).toBe(0);
});

test('independent credentials run in parallel while a shared group caps their total', async () => {
  const scheduler = createModelScheduler();
  const { state, model } = await provider({ bodyDelayMs: 120 });
  await Promise.all(['shared-a', 'shared-b'].map(key =>
    send(controlledOpenAIStream(gate().gate, key, slotFor(scheduler, { credentialId: key, sharedGroupId: 'group', groupLimit: 2 })), model())));
  expect(state.maxGroup).toBeLessThanOrEqual(2);
  await Promise.all(['key-a', 'key-b'].map(key =>
    send(controlledOpenAIStream(gate().gate, key, slotFor(scheduler, { credentialId: key, limit: 1 })), model())));
  expect(state.maxInFlight).toBe(2);
  expect(state.maxByKey.get('Bearer key-a')).toBe(1);
  expect(state.maxByKey.get('Bearer key-b')).toBe(1);
  expect(scheduler.active()).toBe(0);
});

test('a slot is held until the response body ends, not until the headers arrive', async () => {
  const scheduler = createModelScheduler();
  const { model } = await provider({ bodyDelayMs: 300 });
  const stream = controlledOpenAIStream(gate().gate, 'key', slotFor(scheduler, { credentialId: 'cred', limit: 1 }));
  const first = send(stream, model());
  await waitFor(() => scheduler.active('cred') === 1);
  const waiting = scheduler.acquire({ credentialId: 'cred', limit: 1 });
  await waitFor(() => scheduler.queued() === 1);
  await sleep(120);
  // Headers and the first chunk have arrived, but the body is still open.
  expect(scheduler.active('cred')).toBe(1);
  expect(scheduler.queued()).toBe(1);
  expect(await first).toBe('stop');
  const release = await waiting;
  await waitFor(() => scheduler.active('cred') === 1);
  release();
  await waitFor(() => scheduler.active('cred') === 0);
});

test('failures, gate refusals and aborted waits release the slot', async () => {
  const scheduler = createModelScheduler();
  const failing = await provider({ status: 500 });
  const gateState = gate();
  expect(await send(controlledOpenAIStream(gateState.gate, 'key', slotFor(scheduler, { credentialId: 'cred', limit: 1 })), failing.model())).toBe('error');
  expect(scheduler.active('cred')).toBe(0);
  expect(failing.state.requests).toBe(1);

  const refusing = await provider();
  const refusingGate: SendGate = { dispatch() { throw new Error('Instance paused'); }, settle() { /* gate refusal */ } };
  expect(await send(controlledOpenAIStream(refusingGate, 'key', slotFor(scheduler, { credentialId: 'cred', limit: 1 })), refusing.model())).toBe('error');
  expect(refusing.state.requests).toBe(0);
  expect(scheduler.active('cred')).toBe(0);

  const controller = new AbortController();
  const pending = scheduler.acquire({ credentialId: 'held', limit: 1 });
  const blocked = scheduler.acquire({ credentialId: 'held', limit: 1 }, controller.signal);
  controller.abort();
  await expect(blocked).rejects.toMatchObject({ name: 'AbortError' });
  (await pending)();
  expect(scheduler.queued()).toBe(0);
});

test('a retry passes the gate again and the slot is released afterwards', async () => {
  const scheduler = createModelScheduler();
  // A provably closed port gives a retryable ECONNREFUSED.
  const closed = createNetServer();
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', () => resolve()));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>(resolve => closed.close(() => resolve()));
  const unreachable: Model<'openai-completions'> = { ...(await provider()).model(), baseUrl: `http://127.0.0.1:${port}/v1` };
  const broker = gate();
  const retrying = controlledOpenAIStream(broker.gate, 'key', slotFor(scheduler, { credentialId: 'cred', limit: 1 }));
  expect(await send(retrying, unreachable)).toBe('error');
  expect(broker.state.dispatches).toBe(3);
  expect(scheduler.active('cred')).toBe(0);
});

test('a restarted scheduler starts empty and never inherits stale occupancy', async () => {
  const before = createModelScheduler();
  void before.acquire({ credentialId: 'cred', limit: 1 });
  expect(before.active('cred')).toBe(1);
  // Process restart: in-flight verification stays with the task gate and
  // unknown-usage rules; slot counters must not lock the new process.
  const after = createModelScheduler();
  expect(after.active()).toBe(0);
  const release = await after.acquire({ credentialId: 'cred', limit: 1 });
  expect(after.active('cred')).toBe(1);
  release();
  expect(after.active('cred')).toBe(0);
});

test('a queued runtime send re-checks the pause gate and releases the slot without sending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m8-queue-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const providerFixture = await openaiServer([{ text: 'never sent' }]);
  cleanup.push(() => providerFixture.close());
  const scheduler = createModelScheduler();
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: providerFixture.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'unused',
      modelRuntime: providerFixture.runtime,
      credentialFor: () => ({ credentialId: 'cred', apiKey: 'key', limit: 1 }),
      modelScheduler: scheduler,
    },
    actions: {
      check: {
        kind: 'program',
        prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: join(root, 'ok'), digest: 'a'.repeat(64) } }] }),
      },
    },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Queued send', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Queued send',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });

  const held = await scheduler.acquire({ credentialId: 'cred', limit: 1 });
  const driving = runtime.host.drive();
  await waitFor(() => scheduler.queued() === 1);
  // A waiting slot must not block user-facing queries.
  const view = await runtime.user.task(taskId).view();
  expect(view.nodes.find(node => node.id === 'work')).toBeDefined();
  await runtime.user.task(taskId).pause('pause-queued');
  held();
  await driving;
  await waitFor(() => scheduler.active('cred') === 0);
  expect(providerFixture.requests).toHaveLength(0);
  const paused = await runtime.user.task(taskId).view();
  // Nothing was sent and nothing was billed for the queued operation.
  expect(paused.invocations).toHaveLength(0);
  expect(paused.operations.every(operation => !operation.workerActive)).toBe(true);
});
