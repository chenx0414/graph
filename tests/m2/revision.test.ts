import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'graph-revision-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer([
    { tools: [{ id: 'output', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { text: 'Finished' } } } }) }] },
    { text: 'Finished' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    limits: { defaultBudgetTokens: 20_000_000 },
    models: { entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl,
      contextWindow: 32000, maxTokens: 256 }], apiKey: 'local-only', modelRuntime: provider.runtime } });
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Revise the graph', requestId: 'begin' });
  const main = runtime.supervisor(taskId);
  const node = { recipe: 'coder@1', model: 'local', task: 'work', inputs: { job: { protocol: 'data' } }, outputs: { out: { protocol: 'data' } }, submission: { required: ['out'] } };
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Revision', protocols: { data: { type: 'object' } },
    nodes: { work: node, extra: node }, modules: {}, edges: {},
  });
  const { graphId } = await main.graphCreate({ definition }) as { graphId: string };
  return { runtime, main, graphId, definition };
}

test('native revision preserves the finished instance, rejects a stale base, and cannot reopen a completed graph', async () => {
  const { runtime, main, graphId } = await setup();
  const instance = runtime.nodeRun(graphId, 'work').instance!.id;
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} }); await runtime.host.drive();
  expect(runtime.nodeRun(graphId, 'work').node.status).toBe('succeeded');
  const used = runtime.nodeRun(graphId, 'work').instance!.used;
  await expect(main.graphPatch({ graphId, baseRevision: 0, changes: { reason: 'Stale', patch: { name: 'stale' } } }))
    .rejects.toMatchObject({ code: 'stale_revision' });
  await expect(main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Update the next task', patch: { nodes: { work: { task: 'Next assignment' } } } } }))
    .resolves.toMatchObject({ revision: 2 });
  expect(runtime.nodeRun(graphId, 'work')).toMatchObject({ instance: { id: instance, used }, node: { status: 'succeeded' } });
  expect(runtime.nodeRun(graphId, 'work').operations).toHaveLength(1);
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  await expect(main.graphInspect({ graphId })).resolves.toMatchObject({ phase: 'completed', revision: 2 });
  await expect(main.graphPatch({ graphId, baseRevision: 2, changes: { reason: 'Reopen', patch: { name: 'reopened' } } }))
    .rejects.toMatchObject({ code: 'invalid_graph' });
});

test('native revision cannot weaken declared final acceptance', async () => {
  const { main, graphId } = await setup();
  await main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Declare the user gate', patch: {
    acceptance: [{ id: 'correctness', description: 'User accepts the result', kind: 'human' }],
  } } });
  await expect(main.graphPatch({ graphId, baseRevision: 2, changes: { reason: 'Drop the user gate', patch: { acceptance: [] } } }))
    .rejects.toMatchObject({ code: 'invalid_input' });
  const definition = await main.graphInspect({ graphId, query: 'revision' });
  expect(definition).toMatchObject({ acceptance: [{ id: 'correctness', description: 'User accepts the result', kind: 'human' }] });
  await expect(main.graphInspect({ graphId })).resolves.toMatchObject({ revision: 2 });
});

test('native revision cannot discard queued work by replacing its node', async () => {
  const { runtime, main, graphId, definition } = await setup();
  const instance = runtime.nodeRun(graphId, 'work').instance!.id;
  const receipt = await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { text: 'Keep this input' } }) as { queue: { seq: number } };
  const replacement = parseGraphDefinition({ ...definition, nodes: { extra: definition.nodes.extra!, replacement: definition.nodes.work! } });
  await expect(main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Replace unfinished work', definition: replacement, retire: ['work'] } }))
    .rejects.toMatchObject({ code: 'pending_work' });
  expect(runtime.nodeRun(graphId, 'work').instance!.id).toBe(instance);
  const queue = await main.graphInspect({ graphId, query: 'queue' }) as { items: { seq: number; state: string }[] };
  expect(queue.items).toMatchObject([{ seq: receipt.queue.seq, state: 'queued' }]);
  await main.graphControl({ graphId, action: 'cancel', seq: receipt.queue.seq });
  await expect(main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Retire explicitly cancelled work', definition: replacement, retire: ['work'] } }))
    .resolves.toMatchObject({ revision: 2 });
  expect(runtime.nodeRun(graphId, 'work').node.status).toBe('retired');
  expect(runtime.nodeRun(graphId, 'replacement').instance!.id).not.toBe(instance);
});

test('native revision must explicitly name every retired node and preserves its history', async () => {
  const { runtime, main, graphId, definition } = await setup();
  await main.graphSend({ graphId, nodeId: 'extra', input: 'job', value: {} }); await runtime.host.drive();
  const before = runtime.nodeRun(graphId, 'extra');
  const surviving = parseGraphDefinition({ ...definition, nodes: { work: definition.nodes.work! } });
  await expect(main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Omitted node', definition: surviving } }))
    .rejects.toMatchObject({ code: 'invalid_graph' });
  await expect(main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Typo', definition: surviving, retire: ['extras'] } }))
    .rejects.toMatchObject({ code: 'invalid_graph' });
  await expect(main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Retire the idle sibling', definition: surviving, retire: ['extra'] } }))
    .resolves.toMatchObject({ revision: 2 });
  const retired = runtime.nodeRun(graphId, 'extra');
  expect(retired).toMatchObject({ node: { status: 'retired' }, instance: { id: before.instance!.id, used: before.instance!.used } });
  expect(retired.operations).toEqual(before.operations);
  expect(retired.entries).toEqual(before.entries);
  expect(runtime.nodePrompt(graphId, 'extra')).toMatchObject({ status: 'retired', definitionVersion: 'coder@1', action: 'work' });
  await expect(main.graphSend({ graphId, nodeId: 'extra', text: 'New work' })).rejects.toMatchObject({ code: 'invalid_input' });
});
