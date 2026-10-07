import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { expect, test } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { TaskStore } from '../../src/core/store.ts';

/**
 * Issue #1 HB-284: a v2 node needs a token budget of its own.
 *
 * The old executor meters through the `instances` table, and `instances` carries
 * `FOREIGN KEY(task_id,node_id) REFERENCES nodes(task_id,id)`. A v2 node has no row in
 * `nodes`, so it cannot have an `instances` row either — metering is structurally bound to
 * the old kernel, and a v2 node could spend without limit.
 *
 * The budget therefore lives on the kernel's own node state instead, keyed by the same
 * `instance_id` the node was admitted with.
 *
 * Failure modes first (R24):
 *   B1  a node starts with its declared budget and nothing used or reserved
 *   B2  a reservation is held while work is in flight and released when it settles
 *   B3  committed usage is counted once, and re-committing the same total is idempotent
 *   B4  a reservation beyond the budget is refused, and the node is left unreserved
 *   B5  an unlimited node is never refused
 */

const definition = {
  schemaVersion: 2 as const,
  name: 'metered',
  protocols: { out: { type: 'object' as const, required: ['v'], properties: { v: { type: 'string' } } } },
  nodes: {
    a: { recipe: 'worker@1', task: 'a', inputs: {}, outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } },
    b: { recipe: 'worker@1', task: 'b', inputs: {}, outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } },
  },
  modules: {}, edges: {}, inputs: {}, outputs: {},
};

const withRuntime = async (action: (store: TaskStore, kernel: KernelStore, taskId: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'graph-v2-budget-'));
  await mkdir(join(root, 'state'), { recursive: true });
  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  try {
    store.db.prepare("INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','{}')").run();
    store.db.prepare("INSERT INTO tasks(id,project_id,request,phase,created_seq) VALUES('t1','p1','work','running',1)").run();
    const kernel = new KernelStore(store);
    kernel.insertRevision('t1', definition as never, 'metered', 1);
    kernel.admitNode('t1', 1, 'a', { instanceId: 'inst-a' });
    kernel.admitNode('t1', 1, 'b', { instanceId: 'inst-b' });
    await action(store, kernel, 't1');
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
};

test('B1: an admitted node carries its declared budget, with nothing used or reserved', async () => {
  await withRuntime(async (_store, kernel) => {
    expect(kernel.budgetState('t1', 'a', { budget: 1000, unlimited: false }))
      .toEqual({ budget: 1000, unlimited: false, used: 0, reserved: 0 });
  });
});

test('B2: a reservation is held while work is in flight and released when it settles', async () => {
  await withRuntime(async (_store, kernel) => {
    kernel.reserveNodeTokens('t1', 'a', { budget: 1000, unlimited: false }, 400);
    expect(kernel.budgetState('t1', 'a', { budget: 1000, unlimited: false }).reserved).toBe(400);
    kernel.releaseNodeTokens('t1', 'a', 400);
    expect(kernel.budgetState('t1', 'a', { budget: 1000, unlimited: false }).reserved).toBe(0);
  });
});

test('B3: committed usage counts once, and re-committing the same total is idempotent', async () => {
  await withRuntime(async (_store, kernel) => {
    kernel.commitNodeUsage('t1', 'a', 120);
    kernel.commitNodeUsage('t1', 'a', 120);
    expect(kernel.budgetState('t1', 'a', { budget: 1000, unlimited: false }).used).toBe(120);
    kernel.commitNodeUsage('t1', 'a', 180);
    expect(kernel.budgetState('t1', 'a', { budget: 1000, unlimited: false }).used).toBe(180);
  });
});

test('B4: a reservation beyond the budget is refused and leaves nothing reserved', async () => {
  await withRuntime(async (_store, kernel) => {
    const budget = { budget: 500, unlimited: false };
    kernel.reserveNodeTokens('t1', 'a', budget, 300);
    expect(() => kernel.reserveNodeTokens('t1', 'a', budget, 300)).toThrow(/budget/i);
    // The refused reservation must not have been taken: the first one still stands alone.
    expect(kernel.budgetState('t1', 'a', budget).reserved).toBe(300);
  });
});

test('B5: an unlimited node is never refused', async () => {
  await withRuntime(async (_store, kernel) => {
    const budget = { budget: 0, unlimited: true };
    kernel.reserveNodeTokens('t1', 'b', budget, 10_000_000);
    expect(kernel.budgetState('t1', 'b', budget).reserved).toBe(10_000_000);
  });
});

test('nodes meter independently of one another', async () => {
  await withRuntime(async (_store, kernel) => {
    const budget = { budget: 500, unlimited: false };
    kernel.commitNodeUsage('t1', 'a', 400);
    expect(kernel.budgetState('t1', 'b', budget).used).toBe(0);
    expect(() => kernel.reserveNodeTokens('t1', 'a', budget, 200)).toThrow(/budget/i);
  });
});
// Native host wiring must preserve the same finite/unlimited evidence policy as
// the existing model adapter; the provider deliberately supplies no token counts.
test('native unlimited turns estimate absent usage while finite turns retain an unknown hold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-missing-usage-'));
  const plans = (path: string) => [
    { usage: null, tools: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path, content: 'actual tool output' }) }] },
    { usage: null, text: 'Finished after the file tool.' },
  ];
  const unlimited = await openaiServer(plans('unlimited.txt'));
  const finite = await openaiServer(plans('finite.txt'));
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
    runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], access: () => fullAccessPolicy(),
      catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
      models: { apiKey: 'local-only', modelRuntime: unlimited.runtime, entries: [
        ...([['unlimited', unlimited], ['finite', finite]] as const).map(([id, provider]) => ({ id, provider: provider.model.provider,
          grade: 'medium' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })),
      ] },
    });
    runtime.catalog.publishDefinition('writer', { recommendedGrade: 'medium' }, 'writer');
    const parent = await runtime.user.begin({ projectId: 'p', request: 'missing usage policy', requestId: 'begin' });
    const main = runtime.supervisor(parent.taskId);
    const node = (model: string, tokens: number | null) => ({ recipe: 'writer@1', model, task: 'Write a file and report completion.',
      inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {}, budget: { tokens } });
    const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'missing usage', protocols: { data: { type: 'object' } },
      nodes: { unlimited: node('unlimited', null), finite: node('finite', 200000) }, modules: {}, edges: {} }) }) as { graphId: string };
    await main.graphSend({ graphId, nodeId: 'unlimited', input: 'job', value: {} });
    await main.graphSend({ graphId, nodeId: 'finite', input: 'job', value: {} });
    await runtime.host.drive();
    expect(unlimited.requests).toHaveLength(2);
    expect(runtime.nodeRun(graphId, 'unlimited').node.status).toBe('succeeded');
    expect(await readFile(join(root, 'unlimited.txt'), 'utf8')).toBe('actual tool output');
    const calls = await main.graphInspect({ graphId, query: 'provider_calls' }) as { nodeId: string; state: string; usage: { usageSource: string; input: number; output: number } | null }[];
    const estimated = calls.filter(call => call.nodeId === 'unlimited');
    expect(estimated).toHaveLength(2);
    for (const call of estimated) {
      expect(call.state).toBe('settled'); expect(call.usage?.usageSource).toBe('estimated');
      expect(call.usage!.input).toBeGreaterThan(0); expect(call.usage!.output).toBeGreaterThan(0);
    }
    expect(finite.requests).toHaveLength(1);
    expect(calls.filter(call => call.nodeId === 'finite')).toMatchObject([{ state: 'unknown', usage: null }]);
    const failed = await main.graphInspect({ graphId, query: 'queue' }) as { items: { nodeId: string; state: string }[] };
    expect(failed.items.find(item => item.nodeId === 'finite')?.state).toBe('queued');
    expect(runtime.nodeRun(graphId, 'finite').node.status).toBe('blocked');
  } finally {
    await runtime?.close(); await finite.close(); await unlimited.close(); await rm(root, { recursive: true, force: true });
  }
}, 30000);
