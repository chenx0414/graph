import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import type { GraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
const submit = (value: unknown): ResponsePlan => ({ tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value } } }) }] });
async function fixture(plans: ResponsePlan[]) {
  const root = await mkdtemp(join(tmpdir(), 'graph-definition-e2e-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  const provider = await openaiServer(plans); cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') }, projects: [{ id: 'p', root: project }],
    limits: { defaultBudgetTokens: 20_000_000 }, models: { apiKey: 'local-only', modelRuntime: provider.runtime,
      entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] } });
  cleanup.push(() => runtime.close()); runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Exercise graph definitions', requestId: 'begin' });
  const disk = new TaskStore(join(root, 'state', 'tasks.sqlite')); cleanup.push(() => disk.close());
  return { runtime, main: runtime.supervisor(owner.taskId), provider, disk };
}
const pipeline = {
  schemaVersion: 2,
  name: 'pipeline',
  protocols: {
    'implementation-request': {
      type: 'object',
      required: ['goal'],
      properties: { goal: { type: 'string' } },
    },
    'code-result': {
      type: 'object',
      required: ['repository', 'commit', 'artifact'],
      properties: {
        repository: { type: 'string' },
        commit: { type: 'string' },
        artifact: { type: 'object' },
      },
    },
  },
  nodes: {
    worker: {
      recipe: 'worker@1',
      task: '实现功能',
      inputs: { task: { protocol: 'implementation-request' } },
      outputs: { result: { protocol: 'code-result' } },
      submission: { required: ['result'] },
    },
  },
  edges: {},
  inputs: { task: { to: 'worker.task', protocol: 'implementation-request' } },
  outputs: { result: { from: 'worker.result', protocol: 'code-result' } },
};

const rejected: { definition: unknown; fragment: string }[] = [];
const expectInvalid = (definition: unknown, fragment: string) => { rejected.push({ definition, fragment }); };
const cases = Object.assign((_name: string, collect: () => void) => collect(), {
  each: <T,>(rows: readonly T[]) => (_name: string, collect: (row: T) => void) => { for (const row of rows) collect(row); },
});
  cases.each([
    { recipe: undefined, command: { run: 'node', args: ['--version'] } },
    { recipe: 'worker@1', command: { run: '' } },
    { recipe: 'worker@1', command: null },
  ])('nodes reject command declarations; host commands belong to modules (%j)', fields => {
    expectInvalid({ ...pipeline, nodes: { worker: { ...pipeline.nodes.worker, ...fields } } }, 'operation module');
  });

  cases('unknown inputs and malformed node environments are refused with exact paths', () => {
    expectInvalid({
      ...pipeline,
      inputs: { task: { to: 'worker.missing', protocol: 'implementation-request' } },
    }, 'worker.missing');
    for (const [fields, message] of [
      [{ workspace: { base: 'project', path: '../outside' } }, 'workspace.path'],
      [{ workspace: { base: 'project', path: '/absolute' } }, 'workspace.path'],
      [{ workspace: { base: 'project', path: 'some\\path' } }, 'workspace.path'],
      [{ workspace: { base: 'elsewhere' } }, 'workspace requires base'],
      [{ access: { mode: 'standard', commands: 'shell' } }, 'access.commands'],
      [{ access: { mode: 'standard', filesystem: { unknown: true } } }, 'access.filesystem'],
      [{ access: { filesystem: { read: 'host' } } }, 'access requires mode'],
    ] as const) expectInvalid({ ...pipeline, nodes: { worker: { ...pipeline.nodes.worker, ...fields } } }, message);
  });

  cases('edges require explicit boolean enablement and declared endpoints', () => {
    const valid = {
      ...pipeline,
      nodes: { worker: { ...pipeline.nodes.worker, inputs: {
        ...pipeline.nodes.worker.inputs, result: { protocol: 'code-result' },
      } } },
    };
    for (const enabled of [undefined, null, 0, 1, 'false', {}, []]) {
      expectInvalid({ ...valid, edges: { link: { from: 'worker.result', to: 'worker.result', enabled } } }, 'enabled');
    }
    expectInvalid({
      ...pipeline,
      edges: { 'worker-review': { from: 'worker.nope', to: 'worker.task', enabled: true } },
    }, 'worker.nope');
  });

  cases('edge protocol version must agree at both ends', () => {
    // The edge itself carries no protocol; both endpoints must resolve to the same
    // protocol id AND version. An output promising v2 into an input promising v1 is refused.
    expectInvalid({
      ...pipeline,
      protocols: { ...pipeline.protocols, ping: { type: 'object' } },
      nodes: {
        worker: {
          ...pipeline.nodes.worker,
          inputs: { task: { protocol: 'implementation-request' }, ping: { protocol: 'ping' } },
          outputs: { result: { protocol: 'code-result' }, ping2: { protocol: 'ping', version: 2 } },
        },
      },
      edges: { 'mismatch': { from: 'worker.ping2', to: 'worker.ping', enabled: true } },
    }, 'ping');
  });

  cases('blank edge IDs are refused', () => {
    // JSON.parse collapses duplicate keys, so id uniqueness is enforced by the map
    // itself; this pins the blank-id guard that the parser does own.
    expectInvalid({ ...pipeline, edges: { '': { from: 'worker.result', to: 'worker.task', enabled: true } } }, 'blank');
  });
  cases('unsupported schemaVersion is refused', () => {
    expectInvalid({ ...pipeline, schemaVersion: 1 }, 'schemaVersion');
  });
  cases('missing protocol referenced by an output is refused', () => {
    expectInvalid({
      ...pipeline,
      nodes: { worker: { ...pipeline.nodes.worker, outputs: { result: { protocol: 'nope' } } } },
    }, 'nope');
  });
  cases('required output must name a declared output', () => {
    expectInvalid({
      ...pipeline,
      nodes: { worker: { ...pipeline.nodes.worker, submission: { required: ['ghost'] } } },
    }, 'ghost');
  });
cases.each([{ model: '' }, { model: 7 }, { retry: { automatic: -1 } }, { retry: { resubmit: 0.5 } },
  { retry: [] }, { retry: { unknown: 1 } }, { instructions: '' }, { instructions: ' \n\t' }, { instructions: 7 }, { instructions: null }])('node configuration rejects invalid model, retry or instructions declaration: %j', configuration => {
  expectInvalid({ ...pipeline, nodes: { worker: { ...pipeline.nodes.worker, ...configuration } } }, configuration.model !== undefined ? 'model' : configuration.retry !== undefined ? 'retry' : 'instructions');
});


cases.each([
  { budget: { tokens: -1 } }, { budget: { tokens: 1.5 } }, { budget: {} },
  { budget: { tokens: 1, other: 2 } }, { budget: [] }, { retry: { automatic: -1 } }, { model: '' },
])('invalid graph execution defaults are rejected atomically: %j', defaults => {
  expectInvalid({ ...pipeline, defaults }, 'defaults');
});


cases.each([
  {},
  [{ id: 'a', description: 'inspect', kind: 'human' }, { id: 'a', description: 'again', kind: 'human' }],
  [{ id: 'a', kind: 'human' }],
  [{ id: 'a', description: 'inspect', kind: 'anything' }],
  [{ id: 'a', description: 'test', kind: 'check', module: 'missing' }],
  [{ id: 'a', description: 'review', kind: 'review', node: 'missing' }],
  [{ id: 'a', description: 'inspect', kind: 'human', passed: true }],
])('invalid final acceptance is refused as a whole: %j', acceptance => {
  expectInvalid({ ...pipeline, acceptance }, 'Acceptance');
});
expectInvalid({ ...pipeline, protocols: { ...pipeline.protocols, bad: { type: 'not-a-type' } } }, 'invalid schema');

// Legacy context and inferred scheduling are refused at the public atomic-creation boundary.
for (const [fields, field] of [
  [{ context: { purpose: 'review', sourceNode: 'worker', requiredFacts: [{ kind: 'transcript_range' }], independence: 'model-excluded' } }, 'context'],
  [{ context: { purpose: 'explore', sourceNode: 'worker', requiredFacts: [{ kind: 'transcript_range' }] } }, 'context'],
  [{ context: { predecessors: [{ source: 'worker', mode: 'result_handoff' }] } }, 'context'],
  [{ context: { predecessors: [{ source: 'probe', mode: 'evidence_only' }] } }, 'context'],
  [{ dependsOn: ['worker'] }, 'dependsOn'],
  [{ when: { node: 'review', equals: true } }, 'when'],
  [{ container: 'bundle' }, 'container'],
] as const) expectInvalid({ ...pipeline, nodes: { worker: { ...pipeline.nodes.worker, ...fields } } }, `Node worker.*${field}`);

// Malformed rows are sent raw to the real graph management surface; no parser is called here.
test('creation refusals leave no partial graph, then a valid native Pi graph publishes and completes', async () => {
  const output = { repository: 'project', commit: 'controlled-result', artifact: { name: 'result' } };
  const f = await fixture([submit(output), { text: 'Published' }]);
  const counts = () => ['tasks', 'kernel_revisions', 'kernel_nodes', 'kernel_modules', 'kernel_graph_owners'].map(table => f.disk.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
  const before = counts();
  for (const [index, row] of rejected.entries()) {
    await expect(f.main.graphCreate({ definition: row.definition as GraphDefinition, requestId: `reject-${index}` })).rejects.toMatchObject({ code: 'invalid_definition', message: expect.stringMatching(new RegExp(row.fragment, 'i')) });
    expect(counts(), `refusal ${index}: ${row.fragment}`).toEqual(before);
  }
  expect(f.provider.requests).toHaveLength(0);
  const definition: GraphDefinition = { ...pipeline,
    protocols: { ...pipeline.protocols, check: { type: 'object' } },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'code-result' } }, outputs: { result: { protocol: 'check' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } },
    edges: { verify: { from: 'worker.result', to: 'check.job', enabled: true } },
    acceptance: [{ id: 'works', description: 'The integrated project passes its host check', kind: 'check', module: 'check' }],
    completion: { on: 'result', drain: true },
  };
  const { graphId } = await f.main.graphCreate({ definition, targetBranch: 'main', requestId: 'valid' }) as { graphId: string };
  await expect(f.main.graphInspect({ graphId, query: 'queue' })).resolves.toMatchObject({ items: [] });
  await f.main.graphSend({ graphId, input: 'task', value: { goal: 'Implement the request' } }); await f.runtime.host.drive();
  await expect(f.main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: output }]);
  expect(f.provider.requests).toHaveLength(2);
  await expect(f.main.graphInspect({ graphId, query: 'acceptance' })).resolves.toMatchObject({ ready: true, items: [{ id: 'works', status: 'passed' }] });
  expect(await f.runtime.user.task(graphId).view()).toMatchObject({ phase: 'completed' });
}, 60_000);

test('receiving protocol rejects each malformed nested value before execution and preserves the valid value', async () => {
  const value = { status: 'approved', items: [1] };
  const f = await fixture([submit(value), { text: 'Submitted unchanged value' }]);
  const protocol = { type: 'object', additionalProperties: false, required: ['status', 'items'], properties: { status: { type: 'string', enum: ['approved', 'rework'] }, items: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } } } };
  const { graphId } = await f.main.graphCreate({ definition: { schemaVersion: 2, name: 'Protocol round trip', protocols: { data: protocol },
    nodes: { worker: { recipe: 'worker@1', model: 'local', task: 'Submit the received value unchanged', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } }, modules: {}, edges: {},
    inputs: { job: { to: 'worker.job', protocol: 'data' } }, outputs: { result: { from: 'worker.result', protocol: 'data' } }, completion: { on: 'result', drain: true } } }) as { graphId: string };
  for (const bad of [{ status: 'made-up', items: [1] }, { status: 'approved', items: [] }, { status: 'approved', items: [0] }, { ...value, extra: true }]) {
    await expect(f.main.graphSend({ graphId, input: 'job', value: bad })).rejects.toThrow();
    await expect(f.main.graphInspect({ graphId, query: 'queue' })).resolves.toMatchObject({ items: [] });
    expect(f.provider.requests).toHaveLength(0);
  }
  await f.main.graphSend({ graphId, input: 'job', value }); await f.runtime.host.drive();
  await expect(f.main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value }]);
  expect(value).toEqual({ status: 'approved', items: [1] }); expect(f.provider.requests).toHaveLength(2);
  expect(await f.runtime.user.task(graphId).view()).toMatchObject({ phase: 'completed' });
}, 60_000);

test('enabled parallel edges deliver twice to one input while the disabled edge delivers nothing', async () => {
  const f = await fixture([submit({ n: 7 }), { text: 'source done' }, submit({ n: 8 }), { text: 'first received' }, submit({ n: 9 }), { text: 'second received' }]);
  const node = { recipe: 'worker@1', model: 'local', task: 'Submit the assigned number', inputs: { job: { protocol: 'ping' } }, outputs: { result: { protocol: 'ping' } }, submission: { required: ['result'] } };
  const { graphId } = await f.main.graphCreate({ definition: { schemaVersion: 2, name: 'Parallel edges', protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } }, nodes: { source: node, receiver: node }, modules: {},
    edges: { a: { from: 'source.result', to: 'receiver.job', enabled: true }, b: { from: 'source.result', to: 'receiver.job', enabled: true }, off: { from: 'source.result', to: 'receiver.job', enabled: false } },
    inputs: {}, outputs: { result: { from: 'receiver.result', protocol: 'ping' } } } }) as { graphId: string };
  await f.main.graphSend({ graphId, nodeId: 'source', input: 'job', value: { n: 0 } }); await f.runtime.host.drive();
  const executions = await f.main.graphInspect({ graphId, query: 'executions' }) as { items: { nodeId: string; state: string }[] };
  expect(executions.items.filter(item => item.nodeId === 'receiver')).toHaveLength(2);
  expect(executions.items.every(item => item.state === 'completed')).toBe(true);
  for (const id of ['a', 'b']) await expect(f.main.graphInspect({ graphId, query: 'edge', id })).resolves.toMatchObject({ deliveries: [{ value: { n: 7 } }] });
  await expect(f.main.graphInspect({ graphId, query: 'edge', id: 'off' })).resolves.toMatchObject({ deliveries: [] });
  await expect(f.main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { n: 8 } }, { value: { n: 9 } }]);
  expect(f.provider.requests).toHaveLength(6);
  await f.main.graphControl({ graphId, action: 'complete' }); await f.runtime.host.drive();
  expect(await f.runtime.user.task(graphId).view()).toMatchObject({ phase: 'completed' });
}, 60_000);

test('chain, disconnected and cyclic graphs wait for explicit validated input instead of inventing entry work', async () => {
  const f = await fixture(Array.from({ length: 3 }, () => [submit({ n: 1 }), { text: 'Explicit input completed' }]).flat());
  for (const shape of ['chain', 'disconnected', 'cycle']) {
    const node = { recipe: 'worker@1', model: 'local', task: 'Submit the assigned number', inputs: { job: { protocol: 'ping' } }, outputs: { result: { protocol: 'ping' } }, submission: { required: ['result'] } };
    const edges: GraphDefinition['edges'] = shape === 'disconnected' ? {} : { ab: { from: 'a.result', to: 'b.job', enabled: true } };
    if (shape === 'cycle') edges.ba = { from: 'b.result', to: 'a.job', enabled: true };
    const { graphId } = await f.main.graphCreate({ definition: { schemaVersion: 2, name: shape, protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } }, nodes: { a: node, b: node }, modules: {}, edges, inputs: {}, outputs: {} } }) as { graphId: string };
    const requests = f.provider.requests.length;
    await f.runtime.host.drive();
    await expect(f.main.graphInspect({ graphId, query: 'queue' })).resolves.toMatchObject({ items: [] });
    expect(f.provider.requests).toHaveLength(requests);
    await expect(f.main.graphSend({ graphId, nodeId: 'a', input: 'job', value: {} })).rejects.toThrow(/n/);
    await expect(f.main.graphInspect({ graphId, query: 'queue' })).resolves.toMatchObject({ items: [] });
    // Pause only the downstream node: its accepted delivery stays visible without cycling forever.
    await f.main.graphControl({ graphId, nodeId: 'b', action: 'pause' });
    await f.main.graphSend({ graphId, nodeId: 'a', input: 'job', value: { n: 0 } }); await f.runtime.host.drive();
    await expect(f.main.graphInspect({ graphId, query: 'executions' })).resolves.toMatchObject({ items: [{ nodeId: 'a', state: 'completed' }] });
    const queue = await f.main.graphInspect({ graphId, query: 'queue', id: 'b' }) as { items: { state: string }[] };
    expect(queue.items).toHaveLength(shape === 'disconnected' ? 0 : 1);
    if (shape !== 'disconnected') expect(queue.items[0]!.state).toBe('queued');
    expect(f.provider.requests).toHaveLength(requests + 2);
    await f.main.graphControl({ graphId, action: 'stop' }); await f.runtime.host.drive();
    expect(await f.runtime.user.task(graphId).view()).toMatchObject({ phase: 'stopped' });
  }
}, 60_000);
