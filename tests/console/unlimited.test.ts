import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function setup(plans: ResponsePlan[], tokens?: number | null, contextWindow = 32000) {
  const root = await mkdtemp(join(tmpdir(), 'graph-unlimited-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer(plans); cleanup.push(() => provider.close());
  const options: Parameters<typeof openTaskRuntime>[0] = { stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    ...(tokens !== undefined ? { limits: { defaultBudgetTokens: tokens } } : {}),
    models: { apiKey: 'local-only', modelRuntime: provider.runtime, entries: [{ id: 'local', provider: provider.model.provider,
      grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow, maxTokens: 256 }] },
  };
  let runtime = await openTaskRuntime(options); cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Unlimited work', requestId: 'begin' });
  const { graphId } = await runtime.supervisor(owner.taskId).graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2,
    name: 'Native quota', protocols: { job: { type: 'object' } }, nodes: { work: { recipe: 'worker@1', model: 'local',
      task: 'Reply to this input.', inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {} } }, modules: {}, edges: {},
  }) }) as { graphId: string };
  return {
    get runtime() { return runtime; }, provider, graphId,
    async send(value: string) {
      await runtime.supervisor(owner.taskId).graphSend({ graphId, nodeId: 'work', input: 'job', value: { message: value } });
      await runtime.host.drive();
    },
    async retry() {
      const main = runtime.supervisor(owner.taskId);
      const queue = await main.graphInspect({ graphId, query: 'queue' }) as { items: { seq: number; state: string }[] };
      const pending = queue.items.find(item => item.state !== 'done')!;
      await main.graphControl({ graphId, action: 'retry', seq: pending.seq }); await runtime.host.drive();
    },
    async complete() {
      await runtime.supervisor(owner.taskId).graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
      return runtime.user.task(graphId).view();
    },
    async reopen() { await runtime.close(); runtime = await openTaskRuntime(options); },
  };
}

test('a new native instance is unlimited and keeps running past the legacy 20M threshold', async () => {
  const usage = { prompt_tokens: 20000001, completion_tokens: 0 };
  const graph = await setup([{ text: 'First reply.', usage }, { text: 'Second reply.', usage }], undefined, 100000000);
  await graph.send('First input');
  const first = graph.runtime.nodeRun(graph.graphId, 'work').instance!;
  expect(first).toMatchObject({ used: 20000001, budget: null, unlimited: true });
  await graph.send('Second input');
  expect(graph.provider.requests).toHaveLength(2);
  expect(graph.runtime.nodeRun(graph.graphId, 'work').instance).toMatchObject({ id: first.id, used: 40000002, budget: null, unlimited: true });
  const view = await graph.complete(); expect(view.phase).toBe('completed');
  expect(view.questions.filter(question => question.kind === 'budget')).toHaveLength(0);
}, 30000);

test('a finite native default blocks and an explicit user policy change closes its budget question without replay', async () => {
  const graph = await setup([{ text: 'Authorized reply.' }], 1);
  await graph.send('Retained budget input');
  expect(graph.provider.requests).toHaveLength(0);
  const task = graph.runtime.user.task(graph.graphId);
  expect((await task.view()).questions).toMatchObject([{ kind: 'budget', nodeId: 'work', status: 'open' }]);
  const receipt = await task.setBudget({ nodeId: 'work', tokens: null, requestId: 'unlimited-work' });
  expect(await task.setBudget({ nodeId: 'work', tokens: null, requestId: 'unlimited-work' })).toEqual(receipt);
  expect((await task.view()).questions.filter(question => question.status === 'open')).toEqual([]);
  expect(graph.runtime.nodeRun(graph.graphId, 'work').instance).toMatchObject({ budget: 1, unlimited: false, authorizedBudget: { unlimited: true } });
  await graph.runtime.host.drive(); expect(graph.provider.requests).toHaveLength(0);
  await graph.retry();
  expect(graph.provider.requests).toHaveLength(1);
  expect(JSON.stringify(graph.provider.requests[0])).toContain('Retained budget input');
  expect(graph.runtime.nodeRun(graph.graphId, 'work').instance).toMatchObject({ budget: null, unlimited: true });
  expect((await graph.complete()).phase).toBe('completed');
}, 30000);

test('restart preserves a native finite authorization, its instance, session and cumulative usage', async () => {
  const graph = await setup([{ text: 'Before restart.' }, { text: 'After restart.' }], 300000);
  await graph.send('First input');
  const before = graph.runtime.nodeRun(graph.graphId, 'work');
  expect(before.node.status).toBe('succeeded'); expect(before.session).not.toBeNull();
  await graph.runtime.user.task(graph.graphId).setBudget({ nodeId: 'work', tokens: 400000, requestId: 'authorize' });
  await graph.reopen();
  const reopened = graph.runtime.nodeRun(graph.graphId, 'work');
  expect(reopened.instance).toMatchObject({ id: before.instance!.id, used: before.instance!.used, budget: 300000, unlimited: false, authorizedBudget: { budget: 400000, unlimited: false } });
  await graph.send('Second input');
  const after = graph.runtime.nodeRun(graph.graphId, 'work');
  expect(after.instance).toMatchObject({ id: before.instance!.id, budget: 400000, unlimited: false });
  expect(after.session!.sessionId).toBe(before.session!.sessionId);
  expect(after.instance!.used).toBe(before.instance!.used + 50);
  expect(JSON.stringify(graph.provider.requests[1])).toContain('Before restart.');
  expect((await graph.complete()).phase).toBe('completed');
}, 30000);

test('unlimited native instances estimate missing provider usage and complete without a budget question', async () => {
  const graph = await setup([{ text: 'Reply without provider usage.', usage: null }]);
  await graph.send('Missing usage');
  const run = graph.runtime.nodeRun(graph.graphId, 'work');
  expect(run.node.status).toBe('succeeded'); expect(run.instance!.used).toBeGreaterThan(0);
  expect(run.invocations).toMatchObject([{ usageSource: 'estimated' }]);
  expect((await graph.complete()).phase).toBe('completed');
  expect((await graph.runtime.user.task(graph.graphId).view()).questions).toEqual([]);
}, 30000);

test('a finite native missing-usage hold survives restart and policy changes until explicit reconciliation', async () => {
  const graph = await setup([{ text: 'Unmetered reply.', usage: null }, { text: 'After reconciliation.' }], 300000);
  await graph.send('Missing finite usage');
  expect(graph.provider.requests).toHaveLength(1);
  const before = graph.runtime.nodeRun(graph.graphId, 'work');
  expect(before.node.status).toBe('blocked'); expect(before.instance!.used).toBe(0);
  if (!before.instance || !('reserved' in before.instance)) throw new Error('Native budget ledger is missing');
  const held = before.instance.reserved; expect(held).toBeGreaterThan(0);
  await graph.reopen();
  await graph.runtime.user.task(graph.graphId).setBudget({ nodeId: 'work', tokens: 600000, requestId: 'more-quota' });
  await graph.retry();
  expect(graph.provider.requests).toHaveLength(1);
  expect(graph.runtime.nodeRun(graph.graphId, 'work').instance).toMatchObject({ reserved: held });
  const main = graph.runtime.supervisor(graph.graphId);
  const calls = await main.graphInspect({ graphId: graph.graphId, query: 'provider_calls' }) as { id: string; state: string; usage: unknown }[];
  expect(calls).toMatchObject([{ state: 'unknown', usage: null }]);
  await main.graphControl({ graphId: graph.graphId, action: 'reconcile_usage', callId: calls[0]!.id,
    usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } });
  await graph.retry();
  expect(graph.provider.requests).toHaveLength(2);
  expect(graph.runtime.nodeRun(graph.graphId, 'work').instance).toMatchObject({ used: 100, reserved: 0 });
  expect((await graph.complete()).phase).toBe('completed');
}, 30000);

test('an invalid default budget is rejected instead of guessed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-unlimited-invalid-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await expect(openTaskRuntime({ stateDir: join(root, 'state'), limits: { defaultBudgetTokens: 0 } })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(openTaskRuntime({ stateDir: join(root, 'state'), limits: { defaultBudgetTokens: -1 } })).rejects.toMatchObject({ code: 'invalid_input' });
}, 30000);
