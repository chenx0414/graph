import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

function child(file: string, args: string[]) {
  const process = fork(fileURLToPath(new URL(`../fixtures/m1/${file}`, import.meta.url)), args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  process.stderr!.on('data', data => { stderr += data; });
  cleanup.push(async () => { if (process.exitCode === null && process.signalCode === null) { process.kill('SIGKILL'); await once(process, 'exit'); } });
  return { process, message: new Promise<unknown>((resolve, reject) => {
    process.once('message', resolve); process.once('error', reject);
    process.once('exit', code => reject(new Error(`Child exited ${code}: ${stderr}`)));
  }) };
}
async function kill(process: ChildProcess) { process.kill('SIGKILL'); await once(process, 'exit'); }

test('one daemon owns disk state across processes, and the OS releases ownership after a hard kill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-owner-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const holder = child('owner.ts', [root]);
  expect(await holder.message).toEqual({ type: 'ready' });
  await expect(openTaskRuntime({ stateDir: root })).rejects.toMatchObject({ code: 'owner_busy' });
  const contender = child('owner.ts', [root]);
  expect(await contender.message).toEqual({ type: 'error', code: 'owner_busy' });
  await kill(holder.process);
  const recovered = await openTaskRuntime({ stateDir: root });
  cleanup.push(() => recovered.close());
  await expect(openTaskRuntime({ stateDir: root })).rejects.toMatchObject({ code: 'owner_busy' });
  await recovered.close();
  const next = child('owner.ts', [root]);
  expect(await next.message).toEqual({ type: 'ready' });
});

interface CrashState { graphId: string; ownerId: string; instanceId: string; seq: number; executionId: string; callId: string | null }
const usage = { input: 25, output: 10, cacheRead: 15, cacheWrite: 0 };

async function crashed(stage: 'intent' | 'dispatched' | 'submitted', full = false) {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-crash-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const plans: ResponsePlan[] = [{ text: 'Original history survives.' }];
  if (stage === 'submitted') plans.push({ tools: [{ id: 'submit-result', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { result: 'Retained output' } } } }) }] });
  if (stage !== 'intent') plans.push({ text: 'Interrupted response', beforeReply: () => held });
  plans.push({ text: 'Recovered without losing history.' });
  const provider = await openaiServer(plans);
  cleanup.push(async () => { release(); await provider.close(); });
  const worker = child('crash.ts', [root, stage, provider.model.baseUrl, ...(full ? ['full'] : [])]);
  const state = await worker.message as CrashState;
  // The persisted send intent precedes the actual HTTP request. Crash after
  // the server has observed that request, rather than racing that boundary.
  await expect.poll(() => provider.requests.length).toBe(stage === 'intent' ? 1 : stage === 'submitted' ? 3 : 2);
  await kill(worker.process);
  // The process boundary has now vanished. Reopening uses the persisted native
  // executions/calls, never a legacy ActionAdapter reconciliation callback.
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    limits: { defaultBudgetTokens: 20_000_000 }, ...(full ? { access: () => fullAccessPolicy() } : {}),
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
  });
  cleanup.push(() => runtime.close());
  return { root, provider, runtime, main: runtime.supervisor(state.ownerId), ...state };
}

test.each(['intent', 'dispatched'] as const)('hard restart retains a native %s input and the original budget/history until explicit recovery', async stage => {
  const fixture = await crashed(stage);
  const { runtime, main, graphId, callId } = fixture;
  const restored = runtime.nodeRun(graphId, 'work');
  expect(restored.instance).toMatchObject({ id: fixture.instanceId, used: 50 });
  expect(restored.operations.at(-1)).toMatchObject({ state: 'blocked', workerActive: false });
  await expect(main.graphInspect({ graphId, query: 'queue' })).resolves.toMatchObject({ items: [
    { state: 'done' }, { seq: fixture.seq, state: 'queued', payload: { text: 'Continue the original assignment' } },
  ] });
  const sentBefore = fixture.provider.requests.length;
  await runtime.host.drive();
  expect(fixture.provider.requests).toHaveLength(sentBefore);
  if (stage === 'dispatched') {
    expect(restored.invocations.at(-1)).toMatchObject({ id: callId, state: 'unknown', usage: null });
    expect(restored.instance && 'reserved' in restored.instance ? restored.instance.reserved : undefined).toBeGreaterThan(0);
    await main.graphControl({ graphId, action: 'reconcile_usage', callId: callId!, usage });
    await main.graphControl({ graphId, action: 'reconcile_usage', callId: callId!, usage });
    expect(runtime.nodeRun(graphId, 'work').instance!.used).toBe(100);
  } else {
    expect(restored.invocations).toHaveLength(1);
    expect(restored.instance).toMatchObject({ reserved: 0 });
  }
  await main.graphControl({ graphId, nodeId: 'work', action: 'resume' });
  await runtime.host.drive();
  const after = runtime.nodeRun(graphId, 'work');
  expect(after.node.status).toBe('succeeded');
  expect(after.instance).toMatchObject({ id: fixture.instanceId, used: stage === 'intent' ? 100 : 150, reserved: 0 });
  expect(fixture.provider.requests).toHaveLength(sentBefore + 1);
  expect(JSON.stringify(fixture.provider.requests.at(-1))).toContain('Original history survives.');
  await expect(main.graphInspect({ graphId, query: 'executions' })).resolves.toMatchObject({ items: [
    { state: 'completed' }, { id: fixture.executionId, state: 'completed', retriesUsed: 0 },
  ] });
}, 30000);

test('restart after native submit retains the output and reconciles missing usage without replaying the original input', async () => {
  const fixture = await crashed('submitted');
  const { runtime, main, graphId, callId } = fixture;
  const restored = runtime.nodeRun(graphId, 'work');
  expect(restored.operations.at(-1)).toMatchObject({ state: 'failed', workerActive: false });
  expect(restored.instance).toMatchObject({ used: 100 });
  expect(restored.instance && 'reserved' in restored.instance ? restored.instance.reserved : undefined).toBeGreaterThan(0);
  const outputs = await main.graphInspect({ graphId, query: 'results' });
  expect(outputs).toMatchObject([{ value: { result: 'Retained output' } }]);
  await expect(main.graphControl({ graphId, action: 'retry', seq: fixture.seq })).rejects.toMatchObject({ code: 'invalid_queue' });
  await main.graphControl({ graphId, action: 'reconcile_usage', callId: callId!, usage });
  await main.graphControl({ graphId, nodeId: 'work', action: 'resume' });
  await runtime.host.drive();
  expect(fixture.provider.requests).toHaveLength(3);
  expect(runtime.nodeRun(graphId, 'work').instance).toMatchObject({ id: fixture.instanceId, used: 150, reserved: 0 });
  await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toEqual(outputs);
  await expect(main.graphInspect({ graphId, query: 'queue' })).resolves.toMatchObject({ items: [{ state: 'done' }, { seq: fixture.seq, state: 'failed' }] });
}, 30000);

test('full access does not erase unknown native usage or automatically replay an interrupted send', async () => {
  const fixture = await crashed('dispatched', true);
  const { runtime, main, graphId, callId } = fixture;
  const before = runtime.nodeRun(graphId, 'work');
  expect(before.invocations.at(-1)).toMatchObject({ state: 'unknown', usage: null });
  expect(before.instance && 'reserved' in before.instance ? before.instance.reserved : undefined).toBeGreaterThan(0);
  await runtime.host.drive();
  expect(fixture.provider.requests).toHaveLength(2);
  expect(runtime.nodeRun(graphId, 'work').instance!.used).toBe(50);
  await main.graphControl({ graphId, action: 'reconcile_usage', callId: callId!, usage });
  await main.graphControl({ graphId, nodeId: 'work', action: 'resume' });
  await runtime.host.drive();
  expect(fixture.provider.requests).toHaveLength(3);
  expect(runtime.nodeRun(graphId, 'work').instance).toMatchObject({ id: fixture.instanceId, used: 150, reserved: 0 });
}, 30000);
