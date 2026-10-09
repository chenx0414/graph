import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const data = { protocol: 'data' };
const protocols = { data: { type: 'object' } };
const handoff = (workSummary: string) => ({ objective: 'Complete the assigned work', schemaVersion: 1, workSummary });
const submit = (value: unknown): ResponsePlan => ({ tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value } } }) }] });
const node = (model: string, task = 'Process only the explicit input value.', output = true) => ({ recipe: 'coder@1', model, task,
  inputs: { job: data }, outputs: output ? { result: data } : {}, submission: output ? { required: ['result'] } : {} });
const definition = (nodes: Record<string, unknown>, edges: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ schemaVersion: 2, name: 'Explicit handoff', protocols, nodes, modules: {}, edges, ...extra });
const lastUser = (request: unknown) => {
  const messages = (request as { messages: { role: string; content: unknown }[] }).messages.filter(message => message.role === 'user');
  return JSON.stringify(messages.at(-1)?.content);
};
async function fixture(plans: Record<string, ResponsePlan[]>) {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-handoff-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const capabilityRoot = join(root, 'capabilities'); await mkdir(project); await mkdir(capabilityRoot);
  const providers: Record<string, Awaited<ReturnType<typeof openaiServer>>> = {};
  for (const [id, responses] of Object.entries(plans)) { providers[id] = await openaiServer(responses); cleanup.push(() => providers[id]!.close()); }
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
    models: { apiKey: 'local-only', modelRuntime: Object.values(providers)[0]!.runtime, entries: Object.entries(providers).map(([id, provider]) => ({ id, modelId: id, provider: provider.model.provider,
      grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })) } });
  cleanup.push(() => runtime.close());
  await runtime.catalog.saveAgentCombination({ id: 'coder', name: 'Worker', description: 'Explicit interface worker', review: false, recommendedGrade: 'medium', tags: [], resources: [], systemPrompt: 'Use the named interfaces and declared protocols. Keep your own conversation.' });
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Explicit handoff contracts', requestId: 'begin' }); const main = runtime.supervisor(owner.taskId);
  let graphId = '';
  return { runtime, main, providers, get graphId() { return graphId; },
    async create(raw: unknown) { graphId = ((await main.graphCreate({ definition: parseGraphDefinition(raw) })) as { graphId: string }).graphId; },
    async send(nodeId: string, value: Record<string, string> = {}) { await main.graphSend({ graphId, nodeId, input: 'job', value }); await runtime.host.drive(); },
    async edge(id = 'handoff') { return main.graphInspect({ graphId, query: 'edge', id }); },
  };
}

test('a subgraph output delivers the actual leaf value and provenance without inheriting its private conversation', async () => {
  const value = handoff('CONTAINER_LEAF_SUMMARY');
  const graph = await fixture({ work: [submit(value), { text: 'PRIVATE_LEAF_TRANSCRIPT' }], next: [{ text: 'Consumed the explicit result' }] });
  await graph.create(definition({ next: node('next', undefined, false) }, { handoff: { from: 'bundle.result', to: 'next.job', enabled: true } }, {
    templates: { task: { version: 1, definition: definition({ leaf: node('work') }, {}, { outputs: { result: { from: 'leaf.result', protocol: 'data' } } }) } },
    instances: { bundle: { template: 'task', version: 1 } },
  }));
  await graph.send('bundle/leaf');
  expect(graph.providers.next!.requests).toHaveLength(1);
  expect(JSON.stringify(graph.providers.next!.requests[0])).toContain('CONTAINER_LEAF_SUMMARY');
  expect(JSON.stringify(graph.providers.next!.requests[0])).not.toContain('PRIVATE_LEAF_TRANSCRIPT');
  expect(await graph.edge()).toMatchObject({ from: 'bundle/leaf.result', to: 'next.job', latest: value, deliveries: [{ value }] });
  expect(graph.runtime.nodeRun(graph.graphId, 'bundle/leaf').session?.sessionId).not.toBe(graph.runtime.nodeRun(graph.graphId, 'next').session?.sessionId);
}, 30000);

test('an explicit join combines a work summary and evidence payload while keeping each source transcript private', async () => {
  const summary = handoff('MULTI_WORK_SUMMARY'); const evidence = { evidence: 'EXPLICIT_EVIDENCE' };
  const graph = await fixture({ work: [submit(summary), { text: 'PRIVATE_WORK_TRANSCRIPT' }], probe: [submit(evidence), { text: 'PRIVATE_PROBE_TRANSCRIPT' }], next: [{ text: 'Joined the explicit payloads' }] });
  await graph.create(definition({ work: node('work'), probe: node('probe'), next: node('next', undefined, false) }, {
    workJoin: { from: 'work.result', to: 'join.work', enabled: true }, probeJoin: { from: 'probe.result', to: 'join.probe', enabled: true },
    handoff: { from: 'join.result', to: 'next.job', enabled: true },
  }, { modules: { join: { type: 'router', trigger: 'once', requiredInputs: ['work', 'probe'], inputs: { work: data, probe: data }, outputs: { result: data },
    rules: [{ when: 'true', emit: { result: { summary: '$work', evidence: '$probe' } } }] } } }));
  await graph.send('work'); expect(graph.providers.next!.requests).toHaveLength(0);
  await graph.send('probe'); expect(graph.providers.next!.requests).toHaveLength(1);
  const received = JSON.stringify(graph.providers.next!.requests[0]); expect(received).toContain('MULTI_WORK_SUMMARY'); expect(received).toContain('EXPLICIT_EVIDENCE');
  expect(received).not.toContain('PRIVATE_WORK_TRANSCRIPT'); expect(received).not.toContain('PRIVATE_PROBE_TRANSCRIPT');
  expect(await graph.edge()).toMatchObject({ latest: { summary, evidence }, deliveries: [{ value: { summary, evidence } }] });
}, 30000);

test('a later source execution delivers its new value without rewriting the old delivery or replacing downstream history', async () => {
  const first = handoff('WORK_SUMMARY_V1'); const second = handoff('WORK_SUMMARY_V2');
  const graph = await fixture({ work: [submit(first), { text: 'First work complete' }, submit(second), { text: 'Second work complete' }], next: [{ text: 'FIRST_DOWNSTREAM_REPLY' }, { text: 'Second downstream reply' }] });
  await graph.create(definition({ work: node('work'), next: node('next', undefined, false) }, { handoff: { from: 'work.result', to: 'next.job', enabled: true } }));
  await graph.send('work'); const session = graph.runtime.nodeRun(graph.graphId, 'next').session!.sessionId;
  await graph.send('work', { message: 'Explicit rework input' });
  expect(await graph.edge()).toMatchObject({ latest: second, deliveries: [{ value: second }, { value: first }] });
  expect(graph.providers.next!.requests).toHaveLength(2);
  expect(lastUser(graph.providers.next!.requests[1])).toContain('WORK_SUMMARY_V2'); expect(lastUser(graph.providers.next!.requests[1])).not.toContain('WORK_SUMMARY_V1');
  expect(JSON.stringify(graph.providers.next!.requests[1])).toContain('FIRST_DOWNSTREAM_REPLY');
  expect(graph.runtime.nodeRun(graph.graphId, 'next').session!.sessionId).toBe(session);
}, 30000);

test('a missing required handoff receives one repair delta in the same execution before it can reach downstream', async () => {
  const graph = await fixture({ work: [{ text: 'Forgot the required output' }, submit(handoff('REPAIRED_HANDOFF')), { text: 'Required output submitted' }], next: [{ text: 'Received repaired handoff' }] });
  await graph.create(definition({ work: node('work', 'TASK_BRIEFING_SENTINEL: produce the result'), next: node('next', undefined, false) }, { handoff: { from: 'work.result', to: 'next.job', enabled: true } }));
  await graph.send('work');
  expect(graph.providers.work!.requests).toHaveLength(3); const delta = lastUser(graph.providers.work!.requests[1]);
  expect(delta).toMatch(/missing|required|result/i); expect(delta).not.toContain('TASK_BRIEFING_SENTINEL');
  expect(graph.providers.next!.requests).toHaveLength(1); expect(JSON.stringify(graph.providers.next!.requests[0])).toContain('REPAIRED_HANDOFF');
  const executions = await graph.main.graphInspect({ graphId: graph.graphId, query: 'executions', id: 'work' });
  expect(executions).toMatchObject({ items: [{ state: 'completed', resubmitsUsed: 1 }] });
  expect(await graph.edge()).toMatchObject({ deliveries: [{ value: handoff('REPAIRED_HANDOFF') }] });
}, 30000);

test('an invalid handoff returns its field defect to the live worker and a corrected submit alone reaches downstream', async () => {
  const graph = await fixture({ work: [submit({ schemaVersion: 1, workSummary: 'NO_OBJECTIVE' }), submit(handoff('FIXED_IN_TURN')), { text: 'Work done' }], next: [{ text: 'Downstream done' }] });
  await graph.create(definition({ work: node('work'), next: node('next', undefined, false) }, { handoff: { from: 'work.result', to: 'next.job', enabled: true } }, {
    protocols: { data: { type: 'object', required: ['schemaVersion', 'objective', 'workSummary'], properties: { schemaVersion: { type: 'integer' }, objective: { type: 'string' }, workSummary: { type: 'string' } } } },
  }));
  await expect(graph.main.graphSend({ graphId: graph.graphId, nodeId: 'work', input: 'job', value: { schemaVersion: 'invalid input must not dispatch' } })).rejects.toThrow(/work.job.*objective/);
  expect(graph.providers.work!.requests).toHaveLength(0);
  await graph.main.graphSend({ graphId: graph.graphId, nodeId: 'work', input: 'job', value: handoff('Start') }); await graph.runtime.host.drive();
  expect(JSON.stringify(graph.providers.work!.requests[1])).toContain('objective'); expect(JSON.stringify(graph.providers.work!.requests[1])).toContain('output_protocol_mismatch');
  expect(await graph.edge()).toMatchObject({ deliveries: [{ value: handoff('FIXED_IN_TURN') }] });
  expect(graph.runtime.nodeRun(graph.graphId, 'work').node.status).toBe('succeeded');
  expect((await graph.runtime.user.task(graph.graphId).view()).questions).toEqual([]);
}, 30000);

test('an unsatisfied delivery requirement settles as a known failed execution and retains the input for main', async () => {
  const graph = await fixture({ work: [{ text: 'No output on first turn' }, { text: 'Still no output after repair' }], next: [] });
  await graph.create(definition({ work: node('work'), next: node('next', undefined, false) }, { handoff: { from: 'work.result', to: 'next.job', enabled: true } }));
  await graph.send('work'); expect(graph.providers.work!.requests).toHaveLength(2); expect(graph.providers.next!.requests).toHaveLength(0);
  expect(graph.runtime.nodeRun(graph.graphId, 'work').node.status).toBe('failed');
  expect(await graph.main.graphInspect({ graphId: graph.graphId, query: 'executions', id: 'work' })).toMatchObject({ items: [{ state: 'failed', resubmitsUsed: 1 }] });
  expect(await graph.main.graphInspect({ graphId: graph.graphId, query: 'queue' })).toMatchObject({ items: [{ state: 'failed', reason: expect.stringContaining('required output') }] });
  expect(await graph.edge()).toMatchObject({ deliveries: [] });
  const calls = await graph.main.graphInspect({ graphId: graph.graphId, query: 'provider_calls' }) as { state: string }[];
  expect(calls.map(call => call.state)).toEqual(['settled', 'settled']);
}, 30000);

test('the declared handoff protocol shown to the worker enforces string-list element types before delivery', async () => {
  const value = { knownLimits: ['none'], changes: [{ summary: 'Updated the parser' }] };
  const graph = await fixture({ work: [submit({ ...value, knownLimits: [{ text: 'not a string' }] }), submit(value), { text: 'Submitted typed result' }], next: [{ text: 'Received typed result' }] });
  await graph.create(definition({ work: node('work'), next: node('next', undefined, false) }, { handoff: { from: 'work.result', to: 'next.job', enabled: true } }, {
    protocols: { data: { type: 'object', properties: { knownLimits: { type: 'array', items: { type: 'string' } }, changes: { type: 'array', items: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } } } } } },
  }));
  await graph.send('work');
  const initial = JSON.stringify(graph.providers.work!.requests[0]); expect(initial).toContain('knownLimits'); expect(initial).toContain('string');
  expect(JSON.stringify(graph.providers.work!.requests[1])).toContain('knownLimits'); expect(JSON.stringify(graph.providers.work!.requests[1])).toContain('output_protocol_mismatch');
  expect(await graph.edge()).toMatchObject({ deliveries: [{ value }] }); expect(graph.providers.next!.requests).toHaveLength(1);
}, 30000);
