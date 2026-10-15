import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// One held real send exposes the reservation; a different native node must keep its own ledger.
test('native node quotas hold and release reservations, charge each accepted turn once and refuse only the exhausted node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-budget-ledger-'));
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const finite = await openaiServer([
    { text: 'First finite answer', beforeReply: async () => { entered(); await held; } },
    { text: 'Second finite answer' }, { text: 'Exact remaining reservation fits' },
  ]);
  const unlimited = await openaiServer([{ text: 'Unlimited independent answer', usage: { prompt_tokens: 20_000_001, completion_tokens: 0 } }]);
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  let drive: Promise<unknown> | undefined;
  try {
    await mkdir(join(root, 'capabilities'));
    runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
      catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
      models: { apiKey: 'synthetic-only', modelRuntime: finite.runtime, entries: ([['finite', finite], ['unlimited', unlimited]] as const).map(([id, provider]) => ({
        id, provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: id === 'finite' ? 32_000 : 100_000_000, maxTokens: 256,
      })) } });
    runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'Reply to the explicit input.');
    const parent = await runtime.user.begin({ projectId: 'p', request: 'Independent native budgets', requestId: 'begin' });
    const main = runtime.supervisor(parent.taskId);
    const node = (model: string, tokens: number | null) => ({ recipe: 'worker@1', model, task: 'Answer this job once.', budget: { tokens }, inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} });
    const { graphId } = await main.graphCreate({ definition: { schemaVersion: 2, name: 'Independent quotas', protocols: { data: { type: 'object' } },
      nodes: { finite: node('finite', 200_100), unlimited: node('unlimited', null) }, modules: {}, edges: {}, inputs: {}, outputs: {} } }) as { graphId: string };
    for (const id of ['finite', 'unlimited']) expect(runtime.nodeRun(graphId, id).instance).toMatchObject({ used: 0, reserved: 0 });
    const firstInput = { graphId, nodeId: 'finite', input: 'job', value: { label: 'first' } };
    await main.graphSend(firstInput);
    drive = runtime.host.drive();
    await Promise.race([arrived, drive.then(() => { throw new Error(`Execution ended before the expected held provider request: ${JSON.stringify(runtime!.nodeRun(graphId, 'finite'))}`); })]);
    const first = runtime.nodeRun(graphId, 'finite');
    expect(first.instance).toMatchObject({ budget: 200_100, unlimited: false, used: 0, reserved: 200_000 });
    const calls = await main.graphInspect({ graphId, query: 'provider_calls' }) as { nodeId: string; state: string; reserved: number }[];
    expect(calls).toMatchObject([{ nodeId: 'finite', state: 'inflight', reserved: expect.any(Number) }]);
    expect(calls[0]!.reserved).toBeGreaterThan(0);
    expect(runtime.nodeRun(graphId, 'unlimited').instance).toMatchObject({ used: 0, reserved: 0 });
    release(); await drive; drive = undefined;
    const firstSettled = runtime.nodeRun(graphId, 'finite');
    expect(firstSettled.instance).toMatchObject({ id: first.instance!.id, used: 50, reserved: 0 });
    expect(firstSettled.node.status).toBe('succeeded');
    await main.graphSend({ graphId, nodeId: 'unlimited', input: 'job', value: {} }); await runtime.host.drive();
    expect(runtime.nodeRun(graphId, 'unlimited').instance).toMatchObject({ used: 20_000_001, budget: null, unlimited: true, reserved: 0 });
    expect(runtime.nodeRun(graphId, 'finite').instance).toMatchObject({ used: 50, reserved: 0 });
    for (const [label, used] of [['second', 100], ['third', 150]] as const) {
      await main.graphSend({ graphId, nodeId: 'finite', input: 'job', value: { label } }); await runtime.host.drive();
      expect(runtime.nodeRun(graphId, 'finite').instance).toMatchObject({ id: first.instance!.id, used, reserved: 0 });
    }
    expect(finite.requests).toHaveLength(3);
    await main.graphSend({ graphId, nodeId: 'finite', input: 'job', value: { label: 'refused' } }); await runtime.host.drive();
    expect(finite.requests).toHaveLength(3);
    expect(runtime.nodeRun(graphId, 'finite')).toMatchObject({ node: { status: 'blocked' }, instance: { used: 150, reserved: 0 } });
    expect(runtime.nodeRun(graphId, 'unlimited')).toMatchObject({ node: { status: 'succeeded' }, instance: { used: 20_000_001, reserved: 0 } });
    expect((await runtime.user.task(graphId).view()).questions).toMatchObject([{ kind: 'budget', nodeId: 'finite', status: 'open' }]);
    expect(await main.graphInspect({ graphId, query: 'provider_calls' })).toHaveLength(4);
    await runtime.host.drive();
    expect(finite.requests).toHaveLength(3); expect(unlimited.requests).toHaveLength(1);
    expect(runtime.nodeRun(graphId, 'finite').instance!.used).toBe(150);
  } finally {
    release(); await drive?.catch(() => undefined); await runtime?.close();
    await finite.close(); await unlimited.close(); await rm(root, { recursive: true, force: true });
  }
}, 60_000);
