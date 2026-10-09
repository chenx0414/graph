import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition, type GraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function nativeGraph(build: (root: string) => GraphDefinition | Promise<GraphDefinition>, plans: Record<string, ResponsePlan[]>, mainModel?: string) {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-scheduling-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const providers: Record<string, Awaited<ReturnType<typeof openaiServer>>> = {};
  for (const [id, responses] of Object.entries(plans)) { const provider = await openaiServer(responses); providers[id] = provider; cleanup.push(() => provider.close()); }
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'project', root }], ...(mainModel ? { master: { action: 'main', definitionVersion: 'coder@1', model: mainModel } } : {}), models: { apiKey: 'local-only', modelRuntime: Object.values(providers)[0]!.runtime,
    entries: Object.entries(providers).map(([id, provider]) => ({ id, provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })) } };
  const runtime = await openTaskRuntime(options); cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId: ownerId } = await runtime.user.begin({ projectId: 'project', request: 'Scheduling', requestId: 'begin' });
  const main = runtime.supervisor(ownerId);
  const { graphId } = await main.graphCreate({ definition: await build(root) }) as { graphId: string };
  return { root, runtime, main, graphId, ownerId, options, providers, task: runtime.user.task(graphId) };
}
const submitted = (value: unknown, output = 'result'): ResponsePlan => ({ tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { [output]: { enable: true, value } } }) }] });

test('native drive starts an independent successor before a slow sibling finishes', async () => {
  const release = deferred();
  const fixture = await nativeGraph(() => parseGraphDefinition({ schemaVersion: 2, name: 'Independent successor', protocols: { data: { type: 'object' } }, nodes: {
    slow: { recipe: 'coder@1', model: 'slow', task: 'Finish the slow task', inputs: {}, outputs: {}, submission: {} },
    fast: { recipe: 'coder@1', model: 'fast', task: 'Submit the fast result', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } },
  }, modules: { afterFast: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
    operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } },
  edges: { successor: { from: 'fast.result', to: 'afterFast.job', enabled: true } } }), {
    slow: [{ text: 'Slow sibling completed', beforeReply: () => release.promise }], fast: [submitted({ fast: true }), { text: 'Fast result submitted' }],
  });
  cleanup.push(async () => release.resolve());
  const { runtime, main, graphId, providers, task } = fixture;
  await main.graphSend({ graphId, nodeId: 'slow', text: 'Start the slow sibling' });
  await main.graphSend({ graphId, nodeId: 'fast', input: 'job', value: {} });
  const driving = runtime.host.drive();
  await expect.poll(async () => await main.graphInspect({ graphId, query: 'operations' }), { timeout: 15000 }).toMatchObject([{ module_id: 'afterFast', state: 'settled', result: { outputs: { result: { passed: true } } } }]);
  expect(runtime.nodeRun(graphId, 'slow').node.status).toBe('running');
  expect(providers.slow!.requests).toHaveLength(1);
  await expect(main.graphInspect({ graphId, query: 'module', id: 'afterFast' })).resolves.toMatchObject({ inputs: [{ name: 'job', value: { fast: true } }] });
  release.resolve(); await driving;
  expect(await task.view()).toMatchObject({ phase: 'idle' });
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  expect(await task.view()).toMatchObject({ phase: 'completed' });
}, 30000);

test('native Pi pump dispatches a new main conversation while an earlier provider response hangs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pump-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const release = deferred();
  const provider = await openaiServer([{ text: 'first eventually', beforeReply: () => release.promise }, { text: 'second reply' }]); cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), master: { action: 'main', definitionVersion: 'coder@1', model: 'main' },
    models: { apiKey: 'local-only', modelRuntime: provider.runtime, entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] } });
  cleanup.push(() => runtime.close()); cleanup.push(async () => release.resolve());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const first = await runtime.conversations.create({ text: 'First conversation question', requestId: 'first' });
  expect(await runtime.host.pump()).toEqual({ dispatched: 1 });
  await expect.poll(() => provider.requests.length, { timeout: 15000 }).toBe(1);
  const second = await runtime.conversations.create({ text: 'Second conversation question', requestId: 'second' });
  expect(await runtime.host.pump()).toEqual({ dispatched: 1 });
  await expect.poll(async () => (await runtime.conversations.view(second.conversationId)).messages.filter(message => message.role === 'assistant').map(message => message.text), { timeout: 15000 }).toEqual(['second reply']);
  expect(provider.requests).toHaveLength(2);
  expect((await runtime.conversations.view(first.conversationId)).messages.filter(message => message.role === 'assistant')).toEqual([]);
  expect(runtime.nodeRun(first.taskId, 'master').node.status).toBe('running');
  expect(runtime.nodeRun(first.taskId, 'master').instance!.id).not.toBe(runtime.nodeRun(second.taskId, 'master').instance!.id);
  release.resolve(); await runtime.host.drive();
  expect((await runtime.conversations.view(first.conversationId)).messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['first eventually']);
  expect(provider.requests).toHaveLength(2);
}, 30000);

test('native reusable subgraph workers share the global pool with the external main and add no container execution', async () => {
  const mainRelease = deferred(); const workersRelease = deferred();
  const fixture = await nativeGraph(() => {
    const inner = parseGraphDefinition({ schemaVersion: 2, name: 'Reusable pool', protocols: { data: { type: 'object' } },
      nodes: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`worker-${i}`, { recipe: 'coder@1', model: 'workers', task: 'Complete the nested assignment', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} }])), modules: {}, edges: {} });
    return parseGraphDefinition({ schemaVersion: 2, name: 'Nested slots', protocols: {}, nodes: {}, modules: {}, edges: {}, templates: { pool: { version: 1, definition: inner } }, instances: { inner: { template: 'pool', version: 1 } } });
  }, { main: [{ text: 'Main plan completed', beforeReply: () => mainRelease.promise }], workers: Array.from({ length: 11 }, () => ({ text: 'Nested assignment completed', beforeReply: () => workersRelease.promise })) }, 'main');
  cleanup.push(async () => { mainRelease.resolve(); workersRelease.resolve(); });
  const { runtime, main, graphId, providers, ownerId, task } = fixture;
  const mainTurn = runtime.host.runReady();
  await expect.poll(() => providers.main!.requests.length, { timeout: 15000 }).toBe(1);
  for (let i = 0; i < 11; i++) await main.graphSend({ graphId, nodeId: `inner/worker-${i}`, input: 'job', value: { assignment: i } });
  const driving = runtime.host.drive();
  await expect.poll(() => providers.workers!.requests.length, { timeout: 15000 }).toBe(9);
  const executions = () => main.graphInspect({ graphId, query: 'executions' }) as Promise<{ items: { nodeId: string; state: string }[] }>;
  expect((await executions()).items.filter(item => item.state === 'running')).toHaveLength(9);
  expect(runtime.nodeRun(ownerId, 'master').node.status).toBe('running');
  expect(new Set((await task.view()).nodes.map(node => node.id))).toEqual(new Set(Array.from({ length: 11 }, (_, i) => `inner/worker-${i}`)));
  mainRelease.resolve(); await mainTurn;
  await expect.poll(() => providers.workers!.requests.length, { timeout: 15000 }).toBe(10);
  expect((await executions()).items.filter(item => item.state === 'running')).toHaveLength(10);
  workersRelease.resolve(); await driving;
  expect(providers.workers!.requests).toHaveLength(11);
  const history = (await executions()).items;
  expect(history).toHaveLength(11); expect(history.every(item => item.nodeId.startsWith('inner/worker-') && item.state === 'completed')).toBe(true);
  const instances = (await task.view()).nodes.map(node => node.instanceId);
  expect(new Set(instances).size).toBe(11);
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  expect(await task.view()).toMatchObject({ phase: 'completed' });
}, 30000);

const reviewPolicy = (version: number) => `export function evaluate({inputs,state}) {
  const report = inputs.review;
  const previous = state?.version === ${version} ? state : {version:${version},stalls:0,failed:[],attempts:state?.attempts ?? []};
  const failed = report.failed;
  const progress = previous.failed.some(id => !failed.includes(id));
  const stalls = failed.length === 0 || progress ? 0 : previous.stalls + 1;
  const attempts = [...previous.attempts, report.round];
  if (stalls >= 3) throw new Error(JSON.stringify({kind:'stalled',stalls,attempts,failed,reason:'Three consecutive rounds made no substantial progress'}));
  return {state:{version:${version},stalls,failed,attempts},outputs:{[failed.length ? 'rework' : 'passed']:report},diagnostics:[progress ? 'progress reset consecutive count' : 'review evaluated']};
}`;

test('native three no-progress rounds pause only the review module, retain its input across restart and allow explicit repair', async () => {
  const independent = deferred();
  const fixture = await nativeGraph(async root => {
    const entry = join(root, 'policy-v1.mjs'); await writeFile(entry, reviewPolicy(1));
    return parseGraphDefinition({ schemaVersion: 2, name: 'Local review stall', protocols: { data: { type: 'object' } }, nodes: {
      work: { recipe: 'coder@1', model: 'work', task: 'Submit the current candidate', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } },
      review: { recipe: 'coder@1', model: 'review', task: 'Report failed dimensions for the candidate', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } },
      independent: { recipe: 'coder@1', model: 'independent', task: 'Submit the independent result', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } },
    }, modules: {
      gate: { type: 'command', trigger: 'each', requiredInputs: ['review'], inputs: { review: { protocol: 'data' } }, outputs: { rework: { protocol: 'data' }, passed: { protocol: 'data' } }, code: { entry, version: 1 } },
      late: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } },
    }, edges: {
      review: { from: 'work.result', to: 'review.job', enabled: true }, judgment: { from: 'review.result', to: 'gate.review', enabled: true },
      rework: { from: 'gate.rework', to: 'work.job', enabled: true }, independent: { from: 'independent.result', to: 'late.job', enabled: true },
    }, outputs: { result: { from: 'gate.passed', protocol: 'data' } } });
  }, {
    work: Array.from({ length: 4 }, (_, i) => [submitted({ round: i + 1, text: 'same implementation' }), { text: 'Candidate submitted' }]).flat(),
    review: Array.from({ length: 4 }, (_, i) => [submitted({ round: i + 1, failed: i < 3 ? ['correctness'] : [] }), { text: 'Review submitted' }]).flat(),
    independent: [{ ...submitted({ ok: true }), beforeReply: () => independent.promise }, { text: 'Independent work submitted' }],
  });
  cleanup.push(async () => independent.resolve());
  const { runtime, main, graphId, task, options, ownerId, providers, root } = fixture;
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} });
  await main.graphSend({ graphId, nodeId: 'independent', input: 'job', value: {} });
  const driving = runtime.host.drive();
  await expect.poll(() => runtime.events(graphId, 0).filter(event => event.type === 'graph.module.failed'), { timeout: 15000 }).toMatchObject([{ data: { moduleId: 'gate', reason: expect.stringContaining('"stalls":3') } }]);
  const failure = runtime.events(graphId, 0).find(event => event.type === 'graph.module.failed')!;
  expect(JSON.parse((failure.data as { reason: string }).reason)).toMatchObject({ attempts: [1, 2, 3], failed: ['correctness'] });
  expect(runtime.nodeRun(graphId, 'independent').node.status).toBe('running');
  await expect(main.graphInspect({ graphId, query: 'module', id: 'gate' })).resolves.toMatchObject({ state: { stalls: 2, attempts: [1, 2] }, inputs: [{ name: 'review', value: { round: 3 } }] });
  independent.resolve(); await driving;
  await expect(main.graphInspect({ graphId, query: 'operations' })).resolves.toMatchObject([{ module_id: 'late', state: 'settled' }]);
  expect((await task.view()).phase).not.toBe('completed');
  expect(providers.work!.requests).toHaveLength(6);
  await runtime.close(); const restored = await openTaskRuntime(options); cleanup.push(() => restored.close());
  const recovered = restored.supervisor(ownerId);
  await restored.user.task(graphId).resume('resume-graph'); await restored.host.drive();
  expect(providers.work!.requests).toHaveLength(6);
  const repairedEntry = join(root, 'policy-v2.mjs'); await writeFile(repairedEntry, reviewPolicy(2));
  await recovered.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Explicitly restart the review policy counter after inspecting the stalled attempts', patch: { modules: { gate: { code: { entry: repairedEntry, version: 2 } } } } } });
  await expect(recovered.graphControl({ graphId, action: 'resume', moduleId: 'missing' })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(recovered.graphControl({ graphId, action: 'resume', moduleId: 'gate', nodeId: 'work' })).rejects.toMatchObject({ code: 'invalid_input' });
  await restored.user.task(graphId).pause('pause-repair');
  await recovered.graphControl({ graphId, action: 'pause', moduleId: 'gate' });
  await recovered.graphControl({ graphId, action: 'resume', moduleId: 'gate' }); await restored.host.drive();
  expect(providers.work!.requests).toHaveLength(6);
  expect(await restored.user.task(graphId).view()).toMatchObject({ status: 'paused' });
  await restored.user.task(graphId).resume('resume-repair'); await restored.host.drive();
  expect(providers.work!.requests).toHaveLength(8);
  await expect(recovered.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { round: 4, failed: [] } }]);
  await expect(recovered.graphInspect({ graphId, query: 'module', id: 'gate' })).resolves.toMatchObject({ state: { version: 2, stalls: 0, attempts: [1, 2, 3, 4] } });
  expect(providers.independent!.requests).toHaveLength(2);
}, 30000);

test('native passing a previously failed dimension resets the consecutive no-progress count', async () => {
  const fixture = await nativeGraph(async root => {
    const entry = join(root, 'review-policy.mjs'); await writeFile(entry, reviewPolicy(1));
    return parseGraphDefinition({ schemaVersion: 2, name: 'Review progress', protocols: { data: { type: 'object' } }, nodes: {
      work: { recipe: 'coder@1', model: 'work', task: 'Submit the current candidate', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } },
      review: { recipe: 'coder@1', model: 'review', task: 'Report failed review dimensions', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } },
    }, modules: { gate: { type: 'command', trigger: 'each', requiredInputs: ['review'], inputs: { review: { protocol: 'data' } }, outputs: { rework: { protocol: 'data' }, passed: { protocol: 'data' } }, code: { entry, version: 1 } } },
    edges: { review: { from: 'work.result', to: 'review.job', enabled: true }, judgment: { from: 'review.result', to: 'gate.review', enabled: true }, rework: { from: 'gate.rework', to: 'work.job', enabled: true } },
    outputs: { result: { from: 'gate.passed', protocol: 'data' } } });
  }, {
    work: Array.from({ length: 3 }, (_, i) => [submitted({ round: i + 1 }), { text: 'Candidate submitted' }]).flat(),
    review: [['correctness', 'security'], ['security'], []].flatMap((failed, i) => [submitted({ round: i + 1, failed }), { text: 'Review submitted' }]),
  });
  const { runtime, main, graphId, providers, task } = fixture;
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} }); await runtime.host.drive();
  expect(providers.work!.requests).toHaveLength(6); expect(providers.review!.requests).toHaveLength(6);
  const gate = await main.graphInspect({ graphId, query: 'module', id: 'gate' }) as { state: unknown; transitions: { stateAfter: { stalls: number } }[] };
  expect(gate.state).toMatchObject({ stalls: 0, failed: [], attempts: [1, 2, 3] });
  expect(gate.transitions.map(transition => transition.stateAfter.stalls)).toEqual([1, 0, 0]);
  expect(runtime.events(graphId, 0).filter(event => event.type === 'graph.module.failed')).toEqual([]);
  await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { round: 3, failed: [] } }]);
  expect(await task.view()).toMatchObject({ phase: 'idle' });
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  expect(await task.view()).toMatchObject({ phase: 'completed' });
}, 30000);
