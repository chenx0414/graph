import type { EdgeExplanation } from '../../src/core/kernel-explain.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition, type GraphDefinition, type NodeDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const data = { protocol: 'data' };
const node = (model: string): NodeDefinition => ({ recipe: 'coder@1', model, task: 'Process the delivered task and submit its result',
  inputs: { job: data }, outputs: { result: data }, submission: { required: ['result'] } });
const submitted = (value: unknown | (() => unknown)): ResponsePlan => ({ tools: [{ id: 'submit', name: 'submit',
  arguments: () => JSON.stringify({ outputs: { result: { enable: true, value: typeof value === 'function' ? value() : value } } }) }] });
async function setup(definition: GraphDefinition, plans: Record<string, ResponsePlan[]>) {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-structure-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const providers: Record<string, Awaited<ReturnType<typeof openaiServer>>> = {};
  for (const [id, responses] of Object.entries(plans)) { const provider = await openaiServer(responses); providers[id] = provider; cleanup.push(() => provider.close()); }
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'p', root }], models: { apiKey: 'local-only', modelRuntime: Object.values(providers)[0]!.runtime,
    entries: Object.entries(providers).map(([id, provider]) => ({ id, provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })) } };
  const runtime = await openTaskRuntime(options); cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId: ownerId } = await runtime.user.begin({ projectId: 'p', request: definition.name, requestId: 'begin' });
  const main = runtime.supervisor(ownerId);
  const { graphId } = await main.graphCreate({ definition }) as { graphId: string };
  return { root, runtime, main, graphId, ownerId, options, providers };
}

test('nested native subgraphs route only the selected branch and export mapped outputs without container executions', async () => {
  const inner = parseGraphDefinition({ schemaVersion: 2, name: 'Choose format', protocols: { data: { type: 'object' } }, nodes: { text: node('text'), json: node('json') },
    modules: { route: { type: 'router', trigger: 'each', inputs: { job: data }, outputs: { text: data, json: data }, rules: [
      { when: 'job.kind == "text"', emit: { text: '$job' } }, { when: 'job.kind == "json"', emit: { json: '$job' } },
    ] } }, edges: { text: { from: 'route.text', to: 'text.job', enabled: true }, json: { from: 'route.json', to: 'json.job', enabled: true } },
    inputs: { job: { to: 'route.job', protocol: 'data' } }, outputs: { result: { from: 'text.result', protocol: 'data' } } });
  const outer = parseGraphDefinition({ schemaVersion: 2, name: 'Outer reusable graph', protocols: { data: { type: 'object' } }, nodes: {}, modules: {}, edges: {},
    templates: { formats: { version: 1, definition: inner } }, instances: { inner: { template: 'formats', version: 1 } },
    inputs: { job: { to: 'inner.job', protocol: 'data' } }, outputs: { result: { from: 'inner.result', protocol: 'data' } } });
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Nested native route', protocols: { data: { type: 'object' } }, nodes: {}, modules: {}, edges: {},
    templates: { outer: { version: 1, definition: outer } }, instances: { outer: { template: 'outer', version: 1 } },
    inputs: { job: { to: 'outer.job', protocol: 'data' } }, outputs: { result: { from: 'outer.result', protocol: 'data' } } });
  const { runtime, main, graphId, providers } = await setup(definition, { text: [submitted({ format: 'text' }), { text: 'Text result submitted' }], json: [] });
  await main.graphSend({ graphId, input: 'job', value: { kind: 'text' } }); await runtime.host.drive();
  expect(providers.text!.requests).toHaveLength(2); expect(providers.json!.requests).toEqual([]);
  await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { format: 'text' } }]);
  const view = await runtime.user.task(graphId).view();
  expect(view.phase).toBe('idle');
  expect(new Set(view.nodes.map(item => item.id))).toEqual(new Set(['outer/inner/text', 'outer/inner/json']));
  expect(new Set(view.nodes.map(item => item.instanceId)).size).toBe(2);
  const history = await main.graphInspect({ graphId, query: 'executions' }) as { items: { nodeId: string; state: string }[] };
  expect(history.items).toMatchObject([{ nodeId: 'outer/inner/text', state: 'completed' }]);
  await expect(main.graphInspect({ graphId, query: 'module', id: 'outer/inner/route' })).resolves.toMatchObject({ transitions: [{ outputs: { text: { kind: 'text' } } }] });
  await expect(main.graphInspect({ graphId, query: 'edge', id: 'outer/inner/json' })).resolves.toMatchObject({ deliveries: [], latest: null });
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  expect(await runtime.user.task(graphId).view()).toMatchObject({ phase: 'completed' });
});

test('native required failure holds only its join and explicit retry reuses the successful sibling while an optional failure is absent', async () => {
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Required and optional branches', protocols: { data: { type: 'object' } },
    nodes: { work: { ...node('work'), retry: { automatic: 0, resubmit: 0 } }, sibling: node('sibling'), optional: { ...node('optional'), retry: { automatic: 0, resubmit: 0 } } },
    modules: { join: { type: 'router', trigger: 'once', requiredInputs: ['work', 'sibling'], inputs: { work: data, sibling: data, optional: data }, outputs: { result: data },
      rules: [{ when: 'work.passed == true && sibling.passed == true', emit: { result: { work: '$work', sibling: '$sibling' } } }] } },
    edges: Object.fromEntries(['work', 'sibling', 'optional'].map(id => [id, { from: `${id}.result`, to: `join.${id}`, enabled: true }])),
    outputs: { result: { from: 'join.result', protocol: 'data' } } });
  const { runtime, main, graphId, providers } = await setup(definition, {
    work: [{ text: 'Required source unavailable; no deliverable submitted' }, submitted({ passed: true, attempt: 2 }), { text: 'Recovered work submitted' }],
    sibling: [submitted({ passed: true, stable: true }), { text: 'Sibling submitted' }], optional: [{ text: 'Optional source unavailable; no deliverable submitted' }],
  });
  const instanceId = runtime.nodeRun(graphId, 'work').instance!.id;
  for (const id of ['work', 'sibling', 'optional']) await main.graphSend({ graphId, nodeId: id, input: 'job', value: {} });
  await runtime.host.drive();
  await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toEqual([]);
  await expect(main.graphInspect({ graphId, query: 'module', id: 'join' })).resolves.toMatchObject({ triggered: false, inputs: expect.arrayContaining([
    expect.objectContaining({ name: 'work', missing: true }), expect.objectContaining({ name: 'sibling', value: { passed: true, stable: true } }), expect.objectContaining({ name: 'optional', missing: true }),
  ]) });
  const queue = await main.graphInspect({ graphId, query: 'queue' }) as { items: { seq: number; nodeId: string; state: string }[] };
  expect(queue.items.find(item => item.nodeId === 'work')!.state).not.toBe('done');
  await main.graphControl({ graphId, action: 'retry', seq: queue.items.find(item => item.nodeId === 'work')!.seq }); await runtime.host.drive();
  expect(providers.work!.requests).toHaveLength(3); expect(providers.sibling!.requests).toHaveLength(2); expect(providers.optional!.requests).toHaveLength(1);
  expect(runtime.nodeRun(graphId, 'work').instance!.id).toBe(instanceId);
  await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { work: { passed: true, attempt: 2 }, sibling: { stable: true } } }]);
  await expect(main.graphInspect({ graphId, query: 'module', id: 'join' })).resolves.toMatchObject({ triggered: true, inputs: expect.arrayContaining([expect.objectContaining({ name: 'work', delivered: true }), expect.objectContaining({ name: 'sibling', delivered: true }), expect.objectContaining({ name: 'optional', missing: true })]) });
  await main.graphControl({ graphId, action: 'skip', seq: queue.items.find(item => item.nodeId === 'optional')!.seq });

  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  expect(await runtime.user.task(graphId).view()).toMatchObject({ phase: 'completed' });
});

const artifactReference = (runtime: Awaited<ReturnType<typeof openTaskRuntime>>, graphId: string) => {
  const item = runtime.artifacts.list(graphId, { namespace: 'plans' }).artifacts[0]!;
  return { artifactId: item.artifactId, version: item.version, digest: item.digest };
};
const publish: ResponsePlan = { tools: [{ id: 'publish', name: 'artifact_publish', arguments: JSON.stringify({ namespace: 'plans', name: 'candidate', mediaType: 'text/markdown', content: 'stable candidate', requestId: 'candidate' }) }] };

test('a native downstream execution receives the persisted producer delivery and immutable artifact version after restart', async () => {
  let current!: Awaited<ReturnType<typeof openTaskRuntime>>; let id = '';
  const reference = () => artifactReference(current, id);
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Versioned native handoff', protocols: { data: { type: 'object' } }, nodes: { produce: node('produce'), check: node('check') }, modules: {},
    edges: { handoff: { from: 'produce.result', to: 'check.job', enabled: true } }, outputs: { result: { from: 'check.result', protocol: 'data' } } });
  const fixture = await setup(definition, { produce: [publish, submitted(() => ({ subject: reference() })), { text: 'Candidate submitted' }],
    check: [{ tools: [{ id: 'read', name: 'artifact_read', arguments: () => JSON.stringify(reference()) }] }, submitted(() => ({ passed: true, subject: reference() })), { text: 'Stable candidate checked' }] });
  current = fixture.runtime; id = fixture.graphId;
  const { runtime, main, graphId, options, ownerId, providers } = fixture;
  await main.graphControl({ graphId, nodeId: 'check', action: 'pause' });
  await main.graphSend({ graphId, nodeId: 'produce', input: 'job', value: {} }); await runtime.host.drive();
  const subject = reference();
  const delivery = await main.graphInspect({ graphId, query: 'edge', id: 'handoff' }) as EdgeExplanation;
  expect(delivery.deliveries[0]!.receiver.state).toBe('queued');
  const producer = await main.graphInspect({ graphId, query: 'executions' });
  expect(providers.produce!.requests).toHaveLength(3); expect(providers.check!.requests).toEqual([]);
  await runtime.close(); current = await openTaskRuntime(options); cleanup.push(() => current.close());
  const recovered = current.supervisor(ownerId);
  await recovered.graphControl({ graphId, nodeId: 'check', action: 'resume' }); await current.host.drive();
  expect(providers.produce!.requests).toHaveLength(3); expect(providers.check!.requests).toHaveLength(3);
  expect(JSON.stringify(providers.check!.requests[0])).toContain(subject.digest);
  expect(JSON.stringify(providers.check!.requests[1])).toContain('stable candidate');
  const received = await recovered.graphInspect({ graphId, query: 'edge', id: 'handoff' }) as EdgeExplanation;
  expect(received.deliveries[0]!.receiver.state).toBe('done');
  // Only processing state evolves; immutable delivery bytes and provenance survive restart.
  const immutable = (edge: EdgeExplanation) => ({ ...edge, deliveries: edge.deliveries.map(({ receiver: _receiver, ...record }) => record) });
  expect(immutable(received)).toEqual(immutable(delivery));
  const history = await recovered.graphInspect({ graphId, query: 'executions' }) as { items: { nodeId: string; state: string }[] };
  expect(history.items).toMatchObject([{ nodeId: 'produce', state: 'completed' }, { nodeId: 'check', state: 'completed' }]);
  expect((producer as { items: unknown[] }).items[0]).toEqual(history.items[0]);
  await expect(recovered.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { passed: true, subject } }]);
  expect((await current.artifacts.read(graphId, subject.artifactId, subject.version)).text).toBe('stable candidate');
});

test('a native review gate outside a reusable subgraph consumes its explicitly exported stable artifact reference', async () => {
  let current!: Awaited<ReturnType<typeof openTaskRuntime>>; let id = '';
  const reference = () => artifactReference(current, id);
  const inner = parseGraphDefinition({ schemaVersion: 2, name: 'Produce and review', protocols: { data: { type: 'object' } }, nodes: { produce: node('produce'), review: node('review') }, modules: {},
    edges: { review: { from: 'produce.result', to: 'review.job', enabled: true } }, inputs: { job: { to: 'produce.job', protocol: 'data' } }, outputs: { result: { from: 'review.result', protocol: 'data' } } });
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'External explicit review gate', protocols: { data: { type: 'object' } }, nodes: {},
    templates: { development: { version: 1, definition: inner } }, instances: { inner: { template: 'development', version: 1 } },
    modules: { gate: { type: 'router', trigger: 'each', inputs: { review: data }, outputs: { passed: data }, rules: [{ when: 'review.passed == true', emit: { passed: '$review' } }] } },
    edges: { judgment: { from: 'inner.result', to: 'gate.review', enabled: true } }, inputs: { job: { to: 'inner.job', protocol: 'data' } }, outputs: { result: { from: 'gate.passed', protocol: 'data' } } });
  const fixture = await setup(definition, { produce: [publish, submitted(() => ({ subject: reference() })), { text: 'Nested candidate submitted' }],
    review: [{ tools: [{ id: 'read', name: 'artifact_read', arguments: () => JSON.stringify(reference()) }] }, submitted(() => ({ passed: true, subject: reference(), dimension: 'correctness' })), { text: 'Nested candidate reviewed' }] });
  current = fixture.runtime; id = fixture.graphId;
  const { runtime, main, graphId, providers } = fixture;
  await main.graphSend({ graphId, input: 'job', value: {} }); await runtime.host.drive();
  expect(providers.produce!.requests).toHaveLength(3); expect(providers.review!.requests).toHaveLength(3);
  expect(JSON.stringify(providers.review!.requests[1])).toContain('stable candidate');
  const subject = reference();
  await expect(main.graphInspect({ graphId, query: 'module', id: 'gate' })).resolves.toMatchObject({ inputs: [{ value: { subject, passed: true } }], transitions: [{ outputs: { passed: { subject, dimension: 'correctness' } } }] });
  await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { passed: true, subject } }]);
  expect((await runtime.user.task(graphId).view()).nodes).toHaveLength(2);
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  expect(await runtime.user.task(graphId).view()).toMatchObject({ phase: 'completed' });
});
