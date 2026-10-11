import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/** Native public lifecycle: successful node status, explicit completion and confirmed evidence stay distinct. */

const definition = {
  schemaVersion: 2, name: 'finishes',
  protocols: { out: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
  nodes: {
    work: { recipe: 'worker@1', model: 'local', task: 'work', acceptance: ['ok'], inputs: { job: { protocol: 'out' } }, outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } },
  },
  modules: {}, edges: {}, inputs: {}, outputs: {},
  acceptance: [{ id: 'ok', description: 'ran', kind: 'human' }],
};

async function run(limitNodes = 1) {
  const root = await mkdtemp(join(tmpdir(), 'graph-v2-complete-'));
  await mkdir(join(root, 'state'), { recursive: true });
  const provider = await openaiServer([
    { tools: [{ id: 'output', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { text: 'done' } } } }) }] },
    { text: 'Work complete' },
    { text: 'Missing the required output' }, { text: 'Still missing the required output' },
  ]);
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }], limits: { defaultBudgetTokens: 20_000_000 },
    models: { entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl,
      contextWindow: 32000, maxTokens: 256 }], apiKey: 'local-only', modelRuntime: provider.runtime },
  });
  runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'go', requestId: 'b' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'finish',
    acceptance: [{ id: 'ok', description: 'ran', checkNode: 'work' }],
    definition: limitNodes === 1 ? definition : {
      ...definition,
      nodes: { ...definition.nodes, other: { recipe: 'worker@1', model: 'local', task: 'other', inputs: { job: { protocol: 'out' } }, outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } } },
    },
  } as never, 'draft');
  // No Git is configured, so there is no integration branch and no delivery to wait for:
  // this run is about the completion decision itself, not about merging into a branch.
  await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, draftRevision: 1, targetBranch: 'main', requestId: 'a' });
  const main = runtime.supervisor(taskId);
  await main.graphSend({ graphId: taskId, nodeId: 'work', input: 'job', value: { text: 'go' } });
  await runtime.host.drive();
  expect(runtime.nodeRun(taskId, 'work').node.status).toBe('succeeded');
  if (limitNodes > 1) await main.graphSend({ graphId: taskId, nodeId: 'other', input: 'job', value: { text: 'go' } });
  for (let i = 0; i < 5; i += 1) await runtime.host.drive();
  const idle = await runtime.user.task(taskId).view();
  expect(idle.phase).not.toBe('completed');
  await runtime.controlGraph(taskId, { action: 'complete' });
  await runtime.host.drive();
  const view = await runtime.user.task(taskId).view();
  const acceptance = await runtime.supervisor(taskId).graphInspect({ graphId: taskId, query: 'acceptance' }) as { items: { id: string; status: string }[] };
  const nodes = (view as unknown as { nodes: { id: string; status: string }[] }).nodes;
  await runtime.close();
  await provider.close();
  await rm(root, { recursive: true, force: true });
  return { phase: view.phase, acceptance, statuses: Object.fromEntries(nodes.filter(n => n.id !== 'master').map(n => [n.id, n.status])) };
}

test('C1: a v2 node that submits reads succeeded', async () => {
  const { statuses } = await run(1);
  expect(statuses).toEqual({ work: 'succeeded' });
}, 30_000);

test('C2: successful node status cannot replace confirmed human acceptance', async () => {
  const { phase, statuses, acceptance } = await run(1);
  expect(statuses).toEqual({ work: 'succeeded' });
  expect(phase).toBe('blocked');
  expect(acceptance.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ok', kind: 'human', status: 'missing' })]));
}, 30_000);

test('C3: a node that cannot supply its required output stays visible as failed', async () => {
  const { statuses } = await run(2);
  expect(statuses.other).toBe('failed');
}, 30_000);
