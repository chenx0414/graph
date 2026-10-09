import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import type { ModelEntry } from '../../src/catalog/models.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
function entry(id: string, baseUrl: string): ModelEntry {
  return { id, provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 256 };
}
const definition = (model: string, review = false) => parseGraphDefinition({ schemaVersion: 2, name: 'Model selection', protocols: { data: { type: 'object' } },
  nodes: { work: { recipe: 'coder@1', model, task: 'Implement the feature', acceptance: ['Feature works'],
    inputs: {}, outputs: { result: { protocol: 'data' } }, submission: {} },
    ...(review ? { review: { recipe: 'reviewer@1', model, task: 'Review the feature independently', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} } } : {}),
  }, modules: {}, edges: review ? { reviewed: { from: 'work.result', to: 'review.job', enabled: true } } : {},
});

async function setup(plans: Parameters<typeof openaiServer>[0], models: string[], grades?: ModelEntry['grade'][]) {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-model-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer(plans); cleanup.push(() => provider.close());
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: { preferences: {} as Partial<Record<ModelEntry['grade'], string[]>>, entries: models.map((id, index) => ({ ...entry(id, provider.model.baseUrl), grade: grades?.[index] ?? 'high' })), apiKey: 'local-only', modelRuntime: provider.runtime } };
  let runtime = await openTaskRuntime(options); cleanup.push(async () => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const parent = await runtime.user.begin({ projectId: 'p', request: 'Select models', requestId: 'begin' });
  return { provider, options, parent, get runtime() { return runtime; }, reopen: async () => { await runtime.close(); runtime = await openTaskRuntime(options); } };
}

test('native Pi requests preserve invocation accounting, unknown prices and session history across reopening', async () => {
  const fixture = await setup([{ text: 'First implementation' }, { text: 'Continued implementation' }], ['local']);
  let runtime = fixture.runtime; let main = runtime.supervisor(fixture.parent.taskId);
  const { graphId } = await main.graphCreate({ definition: definition('local') }) as { graphId: string };
  await main.graphSend({ graphId, nodeId: 'work', text: 'Implement the feature' }); await runtime.host.drive();
  const before = runtime.nodeRun(graphId, 'work');
  expect(before.instance).toMatchObject({ model: 'local', definitionVersion: 'coder@1', used: 50 });
  expect(before.invocations).toHaveLength(1); expect(before.invocations[0]).toMatchObject({ model: 'local', cost: { unknown: true } });
  expect(runtime.nodePrompt(graphId, 'work').briefing!.text).toContain('Feature works');
  expect(fixture.provider.requests).toHaveLength(1);
  await fixture.reopen(); runtime = fixture.runtime; main = runtime.supervisor(fixture.parent.taskId);
  const reopened = runtime.nodeRun(graphId, 'work');
  expect(reopened.instance!.id).toBe(before.instance!.id);
  expect(reopened.session!.sessionId).toBe(before.session!.sessionId);
  expect(reopened.invocations).toEqual(before.invocations);
  await main.graphSend({ graphId, nodeId: 'work', text: 'Continue the previous implementation' }); await runtime.host.drive();
  expect(fixture.provider.requests).toHaveLength(2);
  expect(JSON.stringify(fixture.provider.requests[1])).toContain('First implementation');
  expect(runtime.nodeRun(graphId, 'work').instance).toMatchObject({ id: before.instance!.id, used: 100 });
});

test('native review selects an independent configured model despite requesting the implementer', async () => {
  const fixture = await setup([{ text: 'Implementation' }, { text: 'Independent review' }], ['writer', 'reader']);
  const runtime = fixture.runtime; const main = runtime.supervisor(fixture.parent.taskId);
  const { graphId } = await main.graphCreate({ definition: definition('writer', true) }) as { graphId: string };
  await main.graphSend({ graphId, nodeId: 'work', text: 'Implement' }); await runtime.host.drive();
  await main.graphSend({ graphId, nodeId: 'review', input: 'job', value: {} }); await runtime.host.drive();
  expect(runtime.nodeRun(graphId, 'work').instance!.model).toBe('writer');
  expect(runtime.nodeRun(graphId, 'review').instance!.model).toBe('reader');
  expect(fixture.provider.requests).toHaveLength(2);
});

test('native review with no independent model retains a durable queued input without sending', async () => {
  const fixture = await setup([{ text: 'Implementation' }], ['writer']);
  const runtime = fixture.runtime; const main = runtime.supervisor(fixture.parent.taskId);
  const { graphId } = await main.graphCreate({ definition: definition('writer', true) }) as { graphId: string };
  await main.graphSend({ graphId, nodeId: 'work', text: 'Implement' }); await runtime.host.drive();
  const instance = runtime.nodeRun(graphId, 'review').instance!.id;
  await main.graphSend({ graphId, nodeId: 'review', input: 'job', value: { text: 'Preserve this assignment' } }); await runtime.host.drive();
  expect(runtime.nodeRun(graphId, 'review').node.status).toBe('blocked');
  const queue = await main.graphInspect({ graphId, query: 'queue', id: 'review' });
  expect(queue).toMatchObject({ items: [{ state: 'queued', payload: { value: { text: 'Preserve this assignment' } } }] });
  await fixture.reopen();
  expect(fixture.runtime.nodeRun(graphId, 'review')).toMatchObject({ node: { status: 'blocked' }, instance: { id: instance } });
  await expect(fixture.runtime.supervisor(fixture.parent.taskId).graphInspect({ graphId, query: 'queue', id: 'review' })).resolves.toEqual(queue);
  expect(fixture.provider.requests).toHaveLength(1);
});

test('native fallback uses model tiers without changing legacy grade selection or admitted identities', async () => {
  const fixture = await setup([{ text: 'Frontier implementation' }, { text: 'Small implementation' }, { text: 'Legacy implementation' }, { text: 'Preferred frontier' }, { text: 'Legacy unaffected by tier preferences' }],
    ['mechanical', 'backup', 'implementer'], ['low', 'highest', 'high']);
  const runtime = fixture.runtime; const main = runtime.supervisor(fixture.parent.taskId);
  runtime.catalog.publishDefinition('frontier-worker', { recommendedGrade: 'frontier' }, 'frontier');
  runtime.catalog.publishDefinition('small-worker', { recommendedGrade: 'small' }, 'small');
  for (const [recipe, expected] of [['frontier-worker@1', 'backup'], ['small-worker@1', 'mechanical'], ['coder@1', 'implementer']]) {
    const graph = definition('gone'); graph.nodes.work!.recipe = recipe!;
    const { graphId } = await main.graphCreate({ definition: graph }) as { graphId: string };
    const instance = runtime.nodeRun(graphId, 'work').instance!.id;
    await main.graphSend({ graphId, nodeId: 'work', text: 'Implement with an available model' }); await runtime.host.drive();
    expect(runtime.nodeRun(graphId, 'work')).toMatchObject({ node: { status: 'succeeded' }, instance: { id: instance, model: expected } });
  }
  fixture.options.models.preferences.frontier = ['implementer'];
  const preferred = definition('gone'); preferred.nodes.work!.recipe = 'frontier-worker@1';
  const { graphId } = await main.graphCreate({ definition: preferred }) as { graphId: string };
  await main.graphSend({ graphId, nodeId: 'work', text: 'Use the configured frontier preference' }); await runtime.host.drive();
  expect(runtime.nodeRun(graphId, 'work').instance!.model).toBe('implementer');
  const legacy = definition('gone');
  const legacyGraph = await main.graphCreate({ definition: legacy }) as { graphId: string };
  fixture.options.models.preferences.frontier = ['backup'];
  await main.graphSend({ graphId: legacyGraph.graphId, nodeId: 'work', text: 'Keep the legacy high choice despite frontier preferences' }); await runtime.host.drive();
  expect(runtime.nodeRun(legacyGraph.graphId, 'work').instance!.model).toBe('implementer');
  expect(fixture.provider.requests.map(request => (request as { model: string }).model)).toEqual(['backup', 'mechanical', 'implementer', 'implementer', 'implementer']);
  expect(runtime.models()).toMatchObject([{ id: 'mechanical', grade: 'low', tier: 'small' }, { id: 'backup', grade: 'highest', tier: 'frontier' }, { id: 'implementer', grade: 'high', tier: 'frontier' }]);
});
