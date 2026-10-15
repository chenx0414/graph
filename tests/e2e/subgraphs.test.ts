import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { GraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('two pinned flat or nested subgraph instances route native executions through isolated public interfaces without synthetic steps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-subgraph-e2e-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  const provider = await openaiServer(Array.from({ length: 12 }, () => [
    { tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { ok: true } } } }) }] }, { text: 'Subgraph node complete' },
  ]).flat()); cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
    limits: { defaultBudgetTokens: 20_000_000 }, models: { apiKey: 'local-only', modelRuntime: provider.runtime, entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] } });
  cleanup.push(() => runtime.close()); runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium', systemPrompt: 'PINNED_WORKER_IDENTITY' }, 'worker');
  runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium', systemPrompt: 'NEW_WORKER_VERSION_IDENTITY' }, 'worker-version2');
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Execute pinned reusable graphs', requestId: 'begin' }); const main = runtime.supervisor(owner.taskId);
  for (const nested of [false, true]) {
    const leaf = { schemaVersion: 2, name: 'Leaf', protocols: { job: { type: 'object', required: ['goal'], properties: { goal: { type: 'string' } } }, done: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } },
      nodes: {
        work: { recipe: 'worker@1', model: 'local', task: 'ORIGINAL_WORK_TASK', inputs: { in: { protocol: 'job' } }, outputs: { out: { protocol: 'done' } }, submission: { required: ['out'] } },
        review: { recipe: 'worker@1', model: 'local', task: 'Review the received result', inputs: { in: { protocol: 'done' } }, outputs: { out: { protocol: 'done' } }, submission: { required: ['out'] } },
      }, modules: {}, edges: { review: { from: 'work.out', to: 'review.in', enabled: true } }, inputs: { job: { to: 'work.in', protocol: 'job' } }, outputs: { result: { from: 'review.out', protocol: 'done' } } };
    const template = nested ? { schemaVersion: 2, name: 'Middle', protocols: {}, nodes: {}, modules: {}, edges: {}, templates: { leaf: { version: 3, definition: leaf } }, instances: { inner: { template: 'leaf', version: 3 } }, inputs: { job: { to: 'inner.job', protocol: 'job' } }, outputs: { result: { from: 'inner.result', protocol: 'done' } } } : leaf;
    const definition = { schemaVersion: 2, name: nested ? 'Nested parent' : 'Flat parent', protocols: {}, nodes: {}, modules: {}, edges: {}, templates: { reusable: { version: 7, definition: template } }, instances: { first: { template: 'reusable', version: 7 }, second: { template: 'reusable', version: 7 } },
      inputs: { first: { to: 'first.job', protocol: 'job' }, second: { to: 'second.job', protocol: 'job' } }, outputs: { first: { from: 'first.result', protocol: 'done' }, second: { from: 'second.result', protocol: 'done' } } };
    const { graphId } = await main.graphCreate({ definition: definition as GraphDefinition }) as { graphId: string };
    const prefix = nested ? '/inner' : '';
    // A later template edit cannot change the admitted definition or a sibling instance.
    leaf.nodes.work.recipe = 'worker@2'; leaf.nodes.work.task = 'LATER_TEMPLATE_TASK';
    await main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Change only one instance task', patch: { nodes: { [`first${prefix}/work`]: { task: 'FIRST_INSTANCE_TASK' } } } } });
    const revision = await main.graphInspect({ graphId, query: 'revision' }) as GraphDefinition;
    expect(revision.nodes[`first${prefix}/work`]!.recipe).toBe('worker@1'); expect(revision.nodes[`second${prefix}/work`]!.recipe).toBe('worker@1');
    expect(revision.nodes[`first${prefix}/work`]!.task).toBe('FIRST_INSTANCE_TASK'); expect(revision.nodes[`second${prefix}/work`]!.task).toBe('ORIGINAL_WORK_TASK'); expect(leaf.nodes.work.task).toBe('LATER_TEMPLATE_TASK');
    expect(revision.subgraphInstances!.first!.version).toBe(7); expect(revision.inputs.first!.to).toBe(`first${prefix}/work.in`); expect(revision.outputs.second!.from).toBe(`second${prefix}/review.out`);
    if (nested) {
      expect(revision.subgraphInstances!['first/inner']!.inputs.job!.to).toBe('first/inner/work.in');
      expect(revision.subgraphInstances!['second/inner']!.outputs.result!.from).toBe('second/inner/review.out');
      expect(revision.subgraphs).toEqual(['first', 'first/inner', 'second', 'second/inner']);
    }
    await expect(main.graphCreate({ definition: { ...definition, instances: { third: { template: 'reusable', version: 8 } } } as GraphDefinition })).rejects.toMatchObject({ code: 'invalid_definition', message: expect.stringContaining('version') });
    const before = provider.requests.length;
    await main.graphSend({ graphId, input: 'first', value: { goal: 'FIRST_REQUEST' } }); await runtime.host.drive();
    await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { ok: true } }]);
    expect(JSON.stringify(provider.requests[before])).toContain('FIRST_INSTANCE_TASK'); expect(JSON.stringify(provider.requests[before])).toContain('PINNED_WORKER_IDENTITY');
    await main.graphSend({ graphId, input: 'second', value: { goal: 'SECOND_REQUEST' } }); await runtime.host.drive();
    const executions = await main.graphInspect({ graphId, query: 'executions' }) as { items: { nodeId: string; state: string }[] };
    expect(executions.items.map(item => item.nodeId)).toEqual([`first${prefix}/work`, `first${prefix}/review`, `second${prefix}/work`, `second${prefix}/review`]);
    expect(executions.items.every(item => item.state === 'completed')).toBe(true); expect(provider.requests).toHaveLength(before + 8);
    expect(JSON.stringify(provider.requests[before + 4])).toContain('ORIGINAL_WORK_TASK'); expect(JSON.stringify(provider.requests[before + 4])).not.toContain('LATER_TEMPLATE_TASK');
    await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { ok: true } }, { value: { ok: true } }]);
    for (const instance of ['first', 'second']) await expect(main.graphInspect({ graphId, query: 'edge', id: `${instance}${prefix}/review` })).resolves.toMatchObject({ from: `${instance}${prefix}/work.out`, to: `${instance}${prefix}/review.in`, deliveries: [{ value: { ok: true } }] });
    await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive(); expect(await runtime.user.task(graphId).view()).toMatchObject({ phase: 'completed' });
    // A fresh, matching template revision adopts the newer recipe; the graph
    // admitted above kept its previous recipe and task throughout execution.
    const upgradedTemplate = nested ? { ...template, templates: { leaf: { version: 4, definition: leaf } }, instances: { inner: { template: 'leaf', version: 4 } } } : leaf;
    const upgraded = { ...definition, templates: { reusable: { version: 8, definition: upgradedTemplate } }, instances: { first: { template: 'reusable', version: 8 } }, inputs: { first: definition.inputs.first }, outputs: { first: definition.outputs.first } };
    const created = await main.graphCreate({ definition: upgraded as GraphDefinition }) as { graphId: string };
    const freshRevision = await main.graphInspect({ graphId: created.graphId, query: 'revision' }) as GraphDefinition;
    expect(freshRevision.subgraphInstances!.first!.version).toBe(8);
    if (nested) expect(freshRevision.subgraphInstances!['first/inner']!.version).toBe(4);
    expect(freshRevision.nodes[`first${prefix}/work`]!.recipe).toBe('worker@2');
    expect(freshRevision.nodes[`first${prefix}/work`]!.task).toBe('LATER_TEMPLATE_TASK');
    const freshStart = provider.requests.length;
    await main.graphSend({ graphId: created.graphId, input: 'first', value: { goal: 'NEW_VERSION_REQUEST' } }); await runtime.host.drive();
    expect(JSON.stringify(provider.requests[freshStart])).toContain('NEW_WORKER_VERSION_IDENTITY');
    expect(JSON.stringify(provider.requests[freshStart])).toContain('LATER_TEMPLATE_TASK');
    expect(JSON.stringify(provider.requests[freshStart])).not.toContain('PINNED_WORKER_IDENTITY');
    expect(provider.requests).toHaveLength(freshStart + 4);
    await expect(main.graphInspect({ graphId: created.graphId, query: 'results' })).resolves.toMatchObject([{ value: { ok: true } }]);
    await main.graphControl({ graphId: created.graphId, action: 'complete' }); await runtime.host.drive();
    expect(await runtime.user.task(created.graphId).view()).toMatchObject({ phase: 'completed' });

  }
}, 90_000);
