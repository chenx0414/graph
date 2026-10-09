import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

// Merge assistance is an ordinary, explicitly declared agent, with the same resident
// process, admission, version binding and ledger as every other graph node.
async function fixture(plans: ResponsePlan[], options: { publish?: boolean; noModels?: boolean; tokens?: number; recipe?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-explicit-merge-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  const provider = await openaiServer(plans); cleanup.push(() => provider.close());
  const runtimeOptions = { stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }],
    catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
    models: { apiKey: 'local-only', modelRuntime: provider.runtime, entries: options.noModels ? [] : [
      { id: 'big', provider: provider.model.provider, grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 },
      { id: 'mid', provider: provider.model.provider, grade: 'medium' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 },
    ] } } satisfies Parameters<typeof openTaskRuntime>[0];
  let runtime = await openTaskRuntime(runtimeOptions); cleanup.push(() => runtime.close());
  const recipe = (systemPrompt: string) => ({ id: 'matt-merge', name: 'Merge assistant', description: 'Explicit merge assistance',
    recommendedGrade: 'medium' as const, review: false, tags: [], resources: [], systemPrompt });
  if (options.publish !== false) {
    await runtime.catalog.saveAgentCombination(recipe('MERGE_IDENTITY_V1: read both sides; preserve their intent.'));
    await runtime.catalog.saveAgentCombination(recipe('MERGE_IDENTITY_V2: a revised identity for later nodes.'));
  }
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Explicit merge assistance', requestId: 'begin' });
  const definition = () => parseGraphDefinition({ schemaVersion: 2, name: 'Explicit merge assistance', protocols: { job: { type: 'object' } },
    nodes: { merge: { recipe: options.recipe ?? 'matt-merge@1', task: 'Explain how to preserve both sides of the supplied conflict.',
      ...(options.tokens === undefined ? {} : { budget: { tokens: options.tokens } }),
      inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {} } }, modules: {}, edges: {} });
  let graphId = '';
  return { root, project, provider, get runtime() { return runtime; }, get graphId() { return graphId; }, get main() { return runtime.supervisor(owner.taskId); },
    async create() { graphId = ((await runtime.supervisor(owner.taskId).graphCreate({ definition: definition() })) as { graphId: string }).graphId; },
    async send() {
      await runtime.supervisor(owner.taskId).graphSend({ graphId, nodeId: 'merge', input: 'job', value: { base: 'middle', ours: 'left', theirs: 'right' } });
      await runtime.host.drive();
    },
    async reopen() { await runtime.close(); runtime = await openTaskRuntime(runtimeOptions); },
  };
}

test('an explicitly declared merge node selects its recommended medium model and its exact published identity version', async () => {
  const graph = await fixture([{ text: 'Preserve both sides.' }]); await graph.create();
  expect(graph.provider.requests).toHaveLength(0); await graph.send();
  expect(graph.provider.requests).toHaveLength(1);
  expect(graph.provider.requests[0]).toMatchObject({ model: 'mid' });
  const sent = JSON.stringify(graph.provider.requests[0]);
  expect(sent).toContain('MERGE_IDENTITY_V1'); expect(sent).not.toContain('MERGE_IDENTITY_V2');
  expect(sent).toContain('left'); expect(sent).toContain('right');
  expect(graph.runtime.nodeRun(graph.graphId, 'merge').node.status).toBe('succeeded');
}, 30000);

test('merge assistance has standard workspace permissions and cannot write a host file outside its workspace', async () => {
  let outside = '';
  const graph = await fixture([
    { tools: [{ id: 'escape', name: 'write_file', arguments: () => JSON.stringify({ path: outside, content: 'overwrite' }) }] },
    { text: 'The unauthorized write was refused.' },
  ]);
  outside = join(graph.root, 'human.txt'); await writeFile(outside, 'human content');
  await graph.create(); await graph.send();
  expect(await readFile(outside, 'utf8')).toBe('human content');
  expect(graph.provider.requests).toHaveLength(2);
  const response = JSON.stringify(graph.provider.requests[1]);
  expect(response).toMatch(/denied|outside|not allowed|escape/i);
  expect(graph.runtime.nodeRun(graph.graphId, 'merge').node.status).toBe('succeeded');
}, 30000);

test('a merge node with no configured model pauses its retained input without sending', async () => {
  const graph = await fixture([], { noModels: true }); await graph.create(); await graph.send();
  expect(graph.provider.requests).toHaveLength(0);
  const run = graph.runtime.nodeRun(graph.graphId, 'merge');
  expect(run.node.status).toBe('blocked');
  expect(await graph.main.graphInspect({ graphId: graph.graphId, query: 'queue' })).toMatchObject({ items: [{ state: 'queued', payload: { value: { ours: 'left', theirs: 'right' } } }] });
}, 30000);

test('an unpublished merge identity is refused before any model session can send', async () => {
  const graph = await fixture([], { publish: false });
  await graph.create(); await graph.send();
  expect(graph.runtime.nodeRun(graph.graphId, 'merge').node.status).toBe('failed');
  expect(JSON.stringify(await graph.main.graphInspect({ graphId: graph.graphId, query: 'queue' }))).toContain('matt-merge');
  expect(graph.provider.requests).toHaveLength(0);
}, 30000);

test('an explicitly selected missing identity version never falls forward to a newer published merge recipe', async () => {
  const graph = await fixture([], { recipe: 'matt-merge@3' });
  await graph.create(); await graph.send();
  expect(graph.runtime.nodeRun(graph.graphId, 'merge').node.status).toBe('failed');
  expect(JSON.stringify(await graph.main.graphInspect({ graphId: graph.graphId, query: 'queue' }))).toContain('matt-merge@3');
  expect(graph.provider.requests).toHaveLength(0);
}, 30000);

test('merge assistance records real provider spend on its node ledger and preserves it across restart', async () => {
  const graph = await fixture([{ text: 'Both sides explained.', usage: { prompt_tokens: 71, completion_tokens: 29 } }]);
  await graph.create(); await graph.send();
  const before = graph.runtime.nodeRun(graph.graphId, 'merge');
  expect(before.instance).toMatchObject({ used: 100, unlimited: true });
  expect(before.operations).toHaveLength(1); expect(graph.provider.requests).toHaveLength(1);
  await graph.reopen();
  expect(graph.runtime.nodeRun(graph.graphId, 'merge').instance).toMatchObject({ id: before.instance!.id, used: 100 });
  await graph.runtime.host.drive(); expect(graph.provider.requests).toHaveLength(1);
}, 30000);

test('a finite merge node budget admits a metered turn instead of requiring an invisible unlimited resolver', async () => {
  const graph = await fixture([{ text: 'Bounded merge advice.', usage: { prompt_tokens: 60, completion_tokens: 20 } }], { tokens: 300000 });
  await graph.create(); await graph.send();
  expect(graph.provider.requests).toHaveLength(1);
  const run = graph.runtime.nodeRun(graph.graphId, 'merge');
  expect(run.node.status).toBe('succeeded');
  expect(run.instance).toMatchObject({ used: 80, budget: 300000, unlimited: false });
  expect((await graph.runtime.user.task(graph.graphId).view()).questions).toHaveLength(0);
}, 30000);
