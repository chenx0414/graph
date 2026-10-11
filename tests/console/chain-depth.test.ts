// Depth-independent interface delivery through real resident Pi processes.
// Each node has its own provider, so a producer finishing after submit cannot
// consume a response intended for the downstream node it already activated.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { installPresets } from '../../src/catalog/presets.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const value = (step: number) => ({ step, summary: `step ${step} done` });

async function runChain(links: number) {
  const root = await mkdtemp(join(tmpdir(), `graph-chain-${links}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  const providers = await Promise.all(Array.from({ length: links }, (_, index) => openaiServer([
    { tools: [{ id: `submit-${index}`, name: 'submit', arguments: JSON.stringify({
      outputs: { result: { enable: true, value: value(index) } },
    }) }] }, { text: `step ${index} done` },
  ])));
  for (const provider of providers) cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }], actions: {},
    models: { entries: providers.map((provider, index) => ({ id: `local${index}`, provider: 'graph-openai', grade: 'high' as const,
      api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 })),
      apiKey: 'local-only', modelRuntime: providers[0]!.runtime } });
  cleanup.push(() => runtime.close());
  await installPresets(runtime.catalog, fileURLToPath(new URL('../../presets', import.meta.url)));
  const ids = Array.from({ length: links }, (_, index) => `n${index}`);
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: `chain of ${links}`, requestId: 'begin' });
  const main = runtime.supervisor(taskId);
  await main.propose({ requirementVersion: 1, summary: `chain of ${links}`,
    acceptance: [{ id: 'ok', description: 'User inspects the final result', checkNode: ids.at(-1)! }],
    definition: parseGraphDefinition({ schemaVersion: 2, name: `chain of ${links}`,
      protocols: { step: { type: 'object', required: ['step', 'summary'], properties: { step: { type: 'integer' }, summary: { type: 'string' } } } },
      nodes: Object.fromEntries(ids.map((id, index) => [id, { recipe: 'coder@1', model: `local${index}`, task: `Complete step ${index}`,
        inputs: { job: { protocol: 'step' } }, outputs: { result: { protocol: 'step' } }, submission: { required: ['result'] } }])),
      modules: {}, edges: Object.fromEntries(ids.slice(1).map((id, index) => [`e${index}`, { from: `${ids[index]}.result`, to: `${id}.job`, enabled: true }])),
      outputs: { result: { from: `${ids.at(-1)}.result`, protocol: 'step' } },
      acceptance: [{ id: 'ok', description: 'User inspects the final result', kind: 'human' }] }),
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'accept' });
  expect(providers.every(provider => provider.requests.length === 0)).toBe(true);
  await main.graphSend({ graphId: taskId, nodeId: 'n0', input: 'job', value: value(-1) });
  await runtime.host.drive();
  for (const [index, id] of ids.entries()) {
    const run = await runtime.nodeRun(taskId, id);
    expect(run.node.status, id).toBe('succeeded');
    expect(run.operations).toHaveLength(1);
    expect(providers[index]!.requests).toHaveLength(2);
    expect(run.entries[0]?.text).toContain(JSON.stringify(value(index - 1)));
    expect(JSON.stringify(providers[index]!.requests[0])).toContain(JSON.stringify(run.entries[0]!.text).slice(1, -1));
  }
  const queue = await main.graphInspect({ graphId: taskId, query: 'queue' });
  expect(queue).toMatchObject({ items: ids.map(nodeId => ({ nodeId, state: 'done' })) });
  const results = await main.graphInspect({ graphId: taskId, query: 'results' });
  expect(results).toMatchObject([{ value: value(links - 1) }]);
  expect((await runtime.user.task(taskId).view()).phase).not.toBe('completed');
}

test('a two-link interface chain drains and publishes its final output', async () => { await runChain(2); }, 60_000);
test('a three-link interface chain drains and publishes its final output', async () => { await runChain(3); }, 60_000);
