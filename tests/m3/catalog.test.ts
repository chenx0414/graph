import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ModelEntry } from '../../src/catalog/models.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
test('explicit recipe versions stay bound on distinct model instances until main patches the next execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-def-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const one = await openaiServer([{ text: 'Left v1' }, { text: 'Left v2' }]);
  const two = await openaiServer([{ text: 'Right v1' }]);
  cleanup.push(() => one.close()); cleanup.push(() => two.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    models: { entries: ([['one', one], ['two', two]] as const).map(([id, provider]): ModelEntry => ({ id,
      provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })),
      apiKey: 'local-fixture', modelRuntime: one.runtime },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', systemPrompt: 'RECIPE_V1_IDENTITY' }, 'v1');
  const parent = await runtime.user.begin({ projectId: 'project', request: 'Two instances', requestId: 'begin' });
  const main = runtime.supervisor(parent.taskId);
  const node = { recipe: 'coder@1', task: 'Reply to the assignment', inputs: {}, outputs: {}, submission: {} };
  const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Two instances', protocols: {},
    nodes: { left: { ...node, model: 'one' }, right: { ...node, model: 'two' } }, modules: {}, edges: {},
  }) }) as { graphId: string };
  const left = runtime.nodeRun(graphId, 'left').instance!.id;
  const right = runtime.nodeRun(graphId, 'right').instance!.id;
  expect(left).not.toBe(right);
  const second = runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium', systemPrompt: 'RECIPE_V2_IDENTITY' }, 'v2');
  expect(second).toMatchObject({ version: 2, key: 'coder@2' });
  await main.graphSend({ graphId, nodeId: 'left', text: 'First assignment' });
  await main.graphSend({ graphId, nodeId: 'right', text: 'Independent assignment' }); await runtime.host.drive();
  expect(one.requests.length, JSON.stringify(await main.graphInspect({ graphId, query: 'queue' }))).toBeGreaterThan(0);
  expect(runtime.nodeRun(graphId, 'left').instance).toMatchObject({ id: left, model: 'one', definitionVersion: 'coder@1' });
  expect(runtime.nodeRun(graphId, 'right').instance).toMatchObject({ id: right, model: 'two', definitionVersion: 'coder@1' });
  expect(JSON.stringify(one.requests[0])).toContain('RECIPE_V1_IDENTITY');
  expect(JSON.stringify(two.requests[0])).toContain('RECIPE_V1_IDENTITY');
  await main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Use the new recipe for the next left turn', patch: { nodes: { left: { recipe: 'coder@2' } } } } });
  await main.graphSend({ graphId, nodeId: 'left', text: 'Use the revised recipe' }); await runtime.host.drive();
  expect(runtime.nodeRun(graphId, 'left').instance!.id).toBe(left);
  expect(JSON.stringify(one.requests[1])).toContain('RECIPE_V2_IDENTITY');
  expect(runtime.nodeRun(graphId, 'right').instance).toMatchObject({ id: right, definitionVersion: 'coder@1' });
  expect(two.requests).toHaveLength(1);
});

test('a filesystem capability is available without an installation record or expanded task grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-cap-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'graph', 'capabilities', 'lookup');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '# Lookup titles');
  await writeFile(join(source, 'capability.json'), JSON.stringify({ id: 'lookup', kind: 'skill', version: '1.0.0', name: 'Lookup' }));
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root, grants: ['workspace:write'] }],
    catalog: { capabilityRoot: join(root, 'graph', 'capabilities'), recipesPath: join(root, 'graph', 'agent-combinations.json') },
  });
  cleanup.push(() => runtime.close());
  expect(runtime.catalog.capability('lookup')).toMatchObject({ id: 'lookup', version: '1.0.0', status: 'available', source: await realpath(source) });
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Use skill', requestId: 'begin' });
  expect((await runtime.user.task(taskId).view()).questions).toEqual([]);
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'lookup', version: '1.0.0' }] }, 'with-skill');
  expect(runtime.catalog.definitions()).toMatchObject([{ id: 'coder', version: 1 }]);
});
