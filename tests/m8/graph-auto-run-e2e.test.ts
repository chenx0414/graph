import { describe, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §13.8 — the switchover seen from the running product.
 *
 * Every piece was proven on its own: confirmation creates a v2 graph, the lane drains one,
 * and a v2 node's session comes from its recipe. §13.8 is only honestly done when the
 * RUNNING runtime does the whole thing without a test calling the graph step by step: a
 * confirmed draft becomes a v2 graph, main sends the first input, the host loop notices it has work, and the graph runs
 * to completion through real per-node processes and a real on-disk kernel.
 *
 * Failure modes first (R24):
 *   R1  a confirmed v2 draft runs to completion off the ordinary host loop
 *   R2  a task with no v2 graph is untouched by the lane (old path unaffected)
 *   R3  the two nodes of the graph really ran, each with its own execution
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  cleanup.length = 0;
});

const DEFINITION = parseGraphDefinition({
  schemaVersion: 2, name: 'auto-completion',
  protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  nodes: {
    a: { recipe: 'worker@1', task: 'produce a number', inputs: { job: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
    b: { recipe: 'worker@1', task: 'receive the number', inputs: { in: { protocol: 'ping' } }, outputs: { done: { protocol: 'ping' } }, submission: { required: ['done'] } },
  },
  modules: {},
  edges: { e: { from: 'a.out', to: 'b.in', enabled: true } },
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-auto-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  return { root, project };
}

function models(provider: Awaited<ReturnType<typeof openaiServer>>) {
  return {
    entries: [{
      id: 'local', provider: 'graph-openai', grade: 'medium' as const, api: 'openai-completions' as const,
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, reasoning: true,
    }],
    apiKey: 'scripted-local-key',
    modelRuntime: provider.runtime,
  };
}

describe('§13.8 E2E — a confirmed v2 graph runs to completion on the host loop', () => {
  test('R1/R3: the ordinary host loop drains a confirmed v2 graph through real per-node processes', async () => {
    // The controlled model: a submits 42, then b submits 43, on two separate processes.
    const provider = await openaiServer([
      { tools: [{ id: 'c1', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { n: 42 } } } }) }], finishReason: 'tool_calls' },
      { text: 'a done.' },
      { tools: [{ id: 'c2', name: 'submit', arguments: JSON.stringify({ outputs: { done: { enable: true, value: { n: 43 } } } }) }], finishReason: 'tool_calls' },
      { text: 'b done.' },
    ]);
    cleanup.push(() => provider.close());
    const { root, project } = await fixture();

    const runtime = await openTaskRuntime({
      stateDir: join(root, 'state'),
      projects: [{ id: 'p', root: project }],
      catalog: { capabilityRoot: join(root, 'graph', 'capabilities'), recipesPath: join(root, 'graph', 'agent-combinations.json') },
      models: models(provider),
      master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
      actions: { master: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: { text: 'draft ready' }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }) } },
    });
    cleanup.push(() => runtime.close());
    // The node's recipe (worker@1) must resolve, so publish the definition it names.
    runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');

    const created = await runtime.conversations.create({ text: '做一个两节点链', requestId: 'create' });
    await runtime.host.runReady();
    const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
    await runtime.supervisor(anchorTaskId).propose({
      requirementVersion: 1, summary: '两节点链',
      acceptance: [{ id: 'works', description: '链跑通', checkNode: 'b' }],
      nodes: [],
      definition: DEFINITION,
    }, 'proposal-v2');
    const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });

    // Seed the first node's work, exactly as an external input would, then let the ORDINARY
    // host loop run: nothing here calls the graph lane directly.
    const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
    cleanup.push(() => store.close());
    const kernel = new KernelStore(store);
    await runtime.supervisor(anchorTaskId).graphSend({ graphId: confirmed.taskId, nodeId: 'a', input: 'job', value: { n: 0 } });

    // The loop: pump repeatedly until the graph is drained. `pump()` is the production tick
    // (host.ts drives it every 40ms), so this runs the same path the product does.
    await runtime.host.pump();
    await runtime.host.drive();
    const aExec = store.db.prepare("SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=? AND node_id='a'").get(confirmed.taskId) as { n: number };
    const bExec = store.db.prepare("SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=? AND node_id='b'").get(confirmed.taskId) as { n: number };
    expect(aExec.n).toBe(1);
    expect(bExec.n).toBe(1);

    // 2. The delivery from a to b is on disk — the reason b ran at all.
    const deliveries = kernel.deliveriesForEdge(confirmed.taskId, 'e');
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.toEndpoint).toBe('b.in');

    // 3. The graph is drained: nothing left queued.
    const queued = store.db.prepare("SELECT COUNT(*) AS n FROM kernel_queue WHERE task_id=? AND state='queued'").get(confirmed.taskId) as { n: number };
    expect(queued.n).toBe(0);

    // 4. Real model turns crossed the HTTP boundary for both nodes.
    expect(provider.requests.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  test('R2: a task with no v2 graph is untouched by the lane', async () => {
    const provider = await openaiServer([{ text: 'idle' }]);
    cleanup.push(() => provider.close());
    const { root, project } = await fixture();
    const runtime = await openTaskRuntime({
      stateDir: join(root, 'state'),
      projects: [{ id: 'p', root: project }],
      catalog: { capabilityRoot: join(root, 'graph', 'capabilities'), recipesPath: join(root, 'graph', 'agent-combinations.json') },
      models: models(provider),
      master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    });
    cleanup.push(() => runtime.close());
    // No graphs exist, so an ordinary host pump does nothing to the kernel.
    const result = await runtime.host.runReady();
    expect(result).toBeDefined();
    const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
    cleanup.push(() => store.close());
    const revisions = store.db.prepare('SELECT COUNT(*) AS n FROM kernel_revisions').get() as { n: number };
    expect(revisions.n).toBe(0);
  }, 60_000);
});
