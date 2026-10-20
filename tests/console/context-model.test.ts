import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { Json } from '../../src/core/types.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});


const nativePort = { protocol: 'data' };
const nativeNode = (model: string, task = 'Process the explicit input.', outputs = false) => ({ recipe: 'coder@1', model, task,
  inputs: { job: nativePort }, outputs: outputs ? { result: nativePort } : {}, submission: outputs ? { required: ['result'] } : {} });
const nativeDefinition = (nodes: Record<string, unknown>, edges: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2, name: 'Native context contracts', protocols: { data: { type: 'object' } }, nodes, modules: {}, edges, ...extra });
const nativeTool = (name: string, args: unknown | (() => unknown)): ResponsePlan => ({ tools: [{ id: name, name,
  arguments: typeof args === 'function' ? () => JSON.stringify((args as () => unknown)()) : JSON.stringify(args) }] });
const nativeSubmit = (value: unknown) => nativeTool('submit', { outputs: { result: { enable: true, value } } });
const nativeLastUser = (request: unknown) => JSON.stringify((request as { messages: { role: string; content: unknown }[] }).messages.filter(message => message.role === 'user').at(-1)?.content);
async function nativeContext(plans: Record<string, ResponsePlan[]>) {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-context-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const capabilityRoot = join(root, 'capabilities'); await mkdir(project); await mkdir(capabilityRoot);
  const providers: Record<string, Awaited<ReturnType<typeof openaiServer>>> = {};
  for (const [id, responses] of Object.entries(plans)) { providers[id] = await openaiServer(responses); cleanup.push(() => providers[id]!.close()); }
  const runtimeOptions = { stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }],
    catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') }, limits: { defaultBudgetTokens: 20000000 },
    models: { apiKey: 'local-only', modelRuntime: Object.values(providers)[0]!.runtime,
      entries: Object.entries(providers).map(([id, provider]) => ({ id, modelId: id, provider: provider.model.provider, grade: 'medium',
        api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })) } } satisfies Parameters<typeof openTaskRuntime>[0];
  let runtime = await openTaskRuntime(runtimeOptions);
  cleanup.push(() => runtime.close());
  const saveRecipe = (id: string, prompt: string) => runtime.catalog.saveAgentCombination({ id, name: id, description: id,
    review: false, recommendedGrade: 'medium', tags: [], resources: [], systemPrompt: prompt });
  await saveRecipe('coder', 'CONTEXT_RECIPE_V1: process the named input and retain only your own conversation.');
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Native context contracts', requestId: 'begin' });
  let main = runtime.supervisor(owner.taskId); let graphId = '';
  return { get runtime() { return runtime; }, get main() { return main; }, project, providers, saveRecipe,
    async reopen() { await runtime.close(); runtime = await openTaskRuntime(runtimeOptions); main = runtime.supervisor(owner.taskId); }, get graphId() { return graphId; },
    async create(raw: unknown) { graphId = ((await main.graphCreate({ definition: parseGraphDefinition(raw) })) as { graphId: string }).graphId; },
    async send(nodeId: string, value: Json = {}) { await main.graphSend({ graphId, nodeId, input: 'job', value }); await runtime.host.drive(); },
    reference() { const item = runtime.artifacts.list(graphId, { namespace: 'deliverables' }).artifacts[0]!; return { artifactId: item.artifactId, version: item.version, digest: item.digest }; },
  };
}

test('new native nodes have independent sessions and quotas, and a later source turn cannot charge or copy into its peer', async () => {
  const graph = await nativeContext({ source: [{ text: 'SOURCE_PRIVATE_HISTORY' }, { text: 'SOURCE_SECOND_REPLY' }], fresh: [{ text: 'FRESH_REPLY' }] });
  await graph.create(nativeDefinition({ source: nativeNode('source'), fresh: nativeNode('fresh') }));
  await graph.send('source'); await graph.send('fresh');
  const source = graph.runtime.nodeRun(graph.graphId, 'source'); const fresh = graph.runtime.nodeRun(graph.graphId, 'fresh');
  expect(source.session!.sessionId).not.toBe(fresh.session!.sessionId); expect(source.instance!.id).not.toBe(fresh.instance!.id);
  expect(source.instance!.used).toBe(50); expect(fresh.instance!.used).toBe(50);
  expect(JSON.stringify(graph.providers.fresh!.requests[0])).not.toContain('SOURCE_PRIVATE_HISTORY');
  await graph.send('source', { message: 'Continue only this node' });
  expect(graph.runtime.nodeRun(graph.graphId, 'source').instance!.used).toBe(100);
  expect(graph.runtime.nodeRun(graph.graphId, 'fresh').instance!.used).toBe(50);
  expect(JSON.stringify(graph.providers.source!.requests[1])).toContain('SOURCE_PRIVATE_HISTORY');
  expect(graph.runtime.nodeRun(graph.graphId, 'source').session!.sessionId).toBe(source.session!.sessionId);
}, 30000);

test('a receiver initial turn contains its task, acceptance, named protocol and explicit value without the sender private reply', async () => {
  const graph = await nativeContext({ source: [nativeSubmit({ message: 'EXPLICIT_INPUT_VALUE' }), { text: 'PRIVATE_SOURCE_REPLY' }], next: [{ text: 'Processed the initial value' }] });
  await graph.create(nativeDefinition({ source: nativeNode('source', 'Produce the explicit value.', true),
    next: { ...nativeNode('next', 'RECEIVER_TASK_SENTINEL'), acceptance: ['RECEIVER_ACCEPTANCE_SENTINEL'] } },
    { handoff: { from: 'source.result', to: 'next.job', enabled: true } },
    { protocols: { data: { type: 'object', properties: { message: { type: 'string', description: 'VALUE_PROTOCOL_SENTINEL' } } } } }));
  await graph.send('source');
  expect(graph.providers.next!.requests).toHaveLength(1);
  const received = JSON.stringify(graph.providers.next!.requests[0]);
  for (const text of ['RECEIVER_TASK_SENTINEL', 'RECEIVER_ACCEPTANCE_SENTINEL', 'VALUE_PROTOCOL_SENTINEL', 'EXPLICIT_INPUT_VALUE', 'source', 'next', 'job']) expect(received).toContain(text);
  expect(received).not.toContain('PRIVATE_SOURCE_REPLY');
}, 30000);

test('an explicit evidence projection excludes the source summary and transcript from the receiver actual turn', async () => {
  const graph = await nativeContext({ source: [nativeSubmit({ summary: 'PRIVATE_RESULT_SUMMARY', evidence: { observation: 'DECLARED_EVIDENCE_VALUE' } }), { text: 'PRIVATE_SOURCE_TRANSCRIPT' }],
    review: [{ text: 'Processed only the projected evidence' }] });
  await graph.create(nativeDefinition({ source: nativeNode('source', undefined, true), review: nativeNode('review') }, {
    input: { from: 'source.result', to: 'project.source', enabled: true }, evidence: { from: 'project.evidence', to: 'review.job', enabled: true },
  }, { modules: { project: { type: 'router', trigger: 'each', inputs: { source: nativePort }, outputs: { evidence: nativePort },
    rules: [{ when: 'true', emit: { evidence: 'source.evidence' } }] } } }));
  await graph.send('source');
  const received = JSON.stringify(graph.providers.review!.requests[0]);
  expect(received).toContain('DECLARED_EVIDENCE_VALUE'); expect(received).not.toContain('PRIVATE_RESULT_SUMMARY'); expect(received).not.toContain('PRIVATE_SOURCE_TRANSCRIPT');
  expect(await graph.main.graphInspect({ graphId: graph.graphId, query: 'edge', id: 'evidence' })).toMatchObject({ latest: { observation: 'DECLARED_EVIDENCE_VALUE' } });
}, 30000);

test('a declared artifact-reference protocol rejects a missing version before downstream dispatch and retains the failed input for main', async () => {
  const graph = await nativeContext({ source: [nativeSubmit({ artifactId: 'missing-version' }), { text: 'No valid reference submitted' }, { text: 'Still no valid reference' }], next: [] });
  await graph.create(nativeDefinition({ source: { ...nativeNode('source', undefined, true), outputs: { result: { protocol: 'reference' } } },
    next: { ...nativeNode('next'), inputs: { job: { protocol: 'reference' } } } },
    { handoff: { from: 'source.result', to: 'next.job', enabled: true } },
    { protocols: { data: { type: 'object' }, reference: { type: 'object', required: ['artifactId', 'version', 'digest'], properties: {
      artifactId: { type: 'string' }, version: { type: 'integer', minimum: 1 }, digest: { type: 'string' } } } } }));
  await graph.send('source');
  expect(JSON.stringify(graph.providers.source!.requests[1])).toContain('version');
  expect(JSON.stringify(graph.providers.source!.requests[1])).toContain('output_protocol_mismatch');
  expect(graph.providers.next!.requests).toHaveLength(0);
  expect(await graph.main.graphInspect({ graphId: graph.graphId, query: 'edge', id: 'handoff' })).toMatchObject({ deliveries: [] });
  expect(await graph.main.graphInspect({ graphId: graph.graphId, query: 'queue' })).toMatchObject({ items: [expect.objectContaining({ nodeId: 'source', state: 'failed' })] });
}, 30000);

test('an explicit artifact version remains the receiver context after the same logical publication advances', async () => {
  let reference!: { artifactId: string; version: number; digest: string };
  const graph = await nativeContext({ source: [nativeTool('artifact_publish', { namespace: 'deliverables', name: 'plan', content: 'PLAN_VERSION_ONE', requestId: 'publish-one' }), { text: 'Published version one' },
    nativeTool('artifact_publish', { namespace: 'deliverables', name: 'plan', content: 'PLAN_VERSION_TWO', expectedVersion: 1, requestId: 'publish-two' }), { text: 'Published version two' }],
    next: [nativeTool('artifact_read', () => reference), { text: 'Read version one' }, nativeTool('artifact_read', () => reference), { text: 'Read the same frozen version' }] });
  await graph.create(nativeDefinition({ source: nativeNode('source'), next: nativeNode('next') }));
  await graph.send('source'); reference = graph.reference(); await graph.send('next', reference);
  await graph.send('source', { message: 'Publish a new version' });
  const latest = graph.reference(); expect(latest.artifactId).toBe(reference.artifactId); expect(latest.version).toBe(2); expect(latest.digest).not.toBe(reference.digest);
  await graph.send('next', reference);
  const received = JSON.stringify(graph.providers.next!.requests[3]);
  expect(received).toContain('PLAN_VERSION_ONE'); expect(received).not.toContain('PLAN_VERSION_TWO');
  expect(reference.version).toBe(1);
}, 30000);

test('native interface values do not silently invent a digest, absolute path or published artifact for a private file', async () => {
  const value = { changes: [{ path: './index.html' }] };
  const graph = await nativeContext({ source: [nativeTool('write_file', { path: './index.html', content: 'PRIVATE_FILE_CONTENT' }), nativeSubmit(value), { text: 'Submitted the declared value' }],
    next: [{ text: 'Received the unmodified value' }] });
  await graph.create(nativeDefinition({ source: nativeNode('source', undefined, true), next: nativeNode('next') }, { value: { from: 'source.result', to: 'next.job', enabled: true } }));
  await graph.send('source');
  expect(await graph.main.graphInspect({ graphId: graph.graphId, query: 'edge', id: 'value' })).toMatchObject({ latest: value, deliveries: [{ value }] });
  expect(graph.runtime.artifacts.list(graph.graphId, {}).artifacts).toEqual([]);
  expect(JSON.stringify(graph.providers.next!.requests[0])).not.toContain('PRIVATE_FILE_CONTENT');
}, 30000);

test('a real publication outside the private work copy is refused without leaking the host file to downstream', async () => {
  let hostPath = '';
  const graph = await nativeContext({ source: [nativeTool('artifact_publish', () => ({ namespace: 'deliverables', name: 'outside', sourcePath: hostPath, requestId: 'publish-outside' })),
    { text: 'The publication was refused' }, { text: 'No valid required output exists' }], next: [] });
  hostPath = join(graph.project, '..', 'host-only.txt'); await writeFile(hostPath, 'HOST_FILE_SENTINEL');
  await graph.create(nativeDefinition({ source: nativeNode('source', undefined, true), next: nativeNode('next') }, { output: { from: 'source.result', to: 'next.job', enabled: true } }));
  await graph.send('source');
  expect(JSON.stringify(graph.providers.source!.requests[1])).toMatch(/outside|private work|work copy/i);
  expect(graph.runtime.artifacts.list(graph.graphId, {}).artifacts).toEqual([]); expect(graph.providers.next!.requests).toHaveLength(0);
  expect(graph.runtime.nodeRun(graph.graphId, 'source').node.status).toBe('failed');
  expect(await graph.main.graphInspect({ graphId: graph.graphId, query: 'edge', id: 'output' })).toMatchObject({ deliveries: [] });
}, 30000);

test('a real workspace-relative publication gives the receiver verified bytes and a stable digest without copying private file paths into its context', async () => {
  const content = '<!doctype html><title>NATIVE_PUBLISHED_PAGE</title>\n'; let reference!: { artifactId: string; version: number; digest: string };
  const graph = await nativeContext({ source: [nativeTool('write_file', { path: './index.html', content }),
    nativeTool('artifact_publish', { namespace: 'deliverables', name: 'page', sourcePath: './index.html', requestId: 'publish-page' }), { text: 'PRIVATE_PUBLISHER_REPLY' }],
    next: [nativeTool('artifact_read', () => reference), { text: 'Read the exact published page' }] });
  await graph.create(nativeDefinition({ source: nativeNode('source'), next: nativeNode('next') }));
  await graph.send('source'); reference = graph.reference();
  expect(reference.version).toBe(1); expect(reference.digest).toBe(createHash('sha256').update(content).digest('hex'));
  await graph.send('next', reference);
  expect(JSON.stringify(graph.providers.next!.requests[1])).toContain('NATIVE_PUBLISHED_PAGE');
  expect(JSON.stringify(graph.providers.next!.requests[0])).not.toContain('PRIVATE_PUBLISHER_REPLY');
  expect(nativeLastUser(graph.providers.next!.requests[0])).not.toContain('index.html');
  expect(graph.runtime.nodeRun(graph.graphId, 'next').node.status).toBe('succeeded');
}, 30000);

test('changing the native node recipe takes effect on its next turn through a rebind that retains only its own history', async () => {
  const graph = await nativeContext({ work: [{ text: 'ORIGINAL_OWN_REPLY' }, { text: 'Updated identity replied' }], peer: [{ text: 'UNRELATED_PEER_HISTORY' }] });
  await graph.create(nativeDefinition({ work: nativeNode('work', 'ORIGINAL_TASK_SENTINEL'), peer: nativeNode('peer') }));
  await graph.send('work'); await graph.send('peer'); const before = graph.runtime.nodeRun(graph.graphId, 'work'); const session = before.session!.sessionId;
  await graph.saveRecipe('specialist', 'SPECIALIST_IDENTITY_SENTINEL: process this task as the updated specialist.');
  await graph.main.graphPatch({ graphId: graph.graphId, baseRevision: 1, changes: { reason: 'Use the explicit new identity next turn', patch: {
    nodes: { work: { recipe: 'specialist@1', task: 'UPDATED_TASK_SENTINEL' } } } } });
  await graph.send('work', { message: 'NEW_INPUT_SENTINEL' });
  const request = graph.providers.work!.requests[1] as { messages: { role: string; content: unknown }[] };
  expect(JSON.stringify(request.messages.filter(message => message.role === 'system' || message.role === 'developer'))).toContain('SPECIALIST_IDENTITY_SENTINEL');
  expect(JSON.stringify(request)).toContain('ORIGINAL_OWN_REPLY'); expect(JSON.stringify(request)).not.toContain('UNRELATED_PEER_HISTORY');
  expect(nativeLastUser(request)).toContain('NEW_INPUT_SENTINEL');
  expect(graph.runtime.nodeRun(graph.graphId, 'work').session!.sessionId).toBe(session);
  expect(graph.runtime.nodeRun(graph.graphId, 'work').instance!.id).toBe(before.instance!.id);
  expect(graph.runtime.nodeRun(graph.graphId, 'work').instance!.used).toBe(100);
  expect(graph.runtime.nodeRun(graph.graphId, 'work').instance!.definitionVersion).toBe('specialist@1');
}, 30000);

test('two instances of one native subgraph template retain independent conversations when one is activated again', async () => {
  const graph = await nativeContext({ work: [{ text: 'LEFT_PRIVATE_REPLY' }, { text: 'RIGHT_PRIVATE_REPLY' }, { text: 'LEFT_CONTINUED_REPLY' }] });
  await graph.create(nativeDefinition({}, {}, { templates: { reusable: { version: 1, definition: nativeDefinition({ leaf: nativeNode('work') }) } },
    instances: { left: { template: 'reusable', version: 1 }, right: { template: 'reusable', version: 1 } } }));
  await graph.send('left/leaf'); const left = graph.runtime.nodeRun(graph.graphId, 'left/leaf');
  await graph.send('right/leaf'); const right = graph.runtime.nodeRun(graph.graphId, 'right/leaf');
  expect(right.session!.sessionId).not.toBe(left.session!.sessionId); expect(right.instance!.id).not.toBe(left.instance!.id);
  expect(JSON.stringify(graph.providers.work!.requests[1])).not.toContain('LEFT_PRIVATE_REPLY');
  await graph.send('left/leaf', { message: 'Continue only the left instance' });
  expect(JSON.stringify(graph.providers.work!.requests[2])).toContain('LEFT_PRIVATE_REPLY'); expect(JSON.stringify(graph.providers.work!.requests[2])).not.toContain('RIGHT_PRIVATE_REPLY');
  expect(graph.runtime.nodeRun(graph.graphId, 'left/leaf').session!.sessionId).toBe(left.session!.sessionId);
  expect(graph.runtime.nodeRun(graph.graphId, 'right/leaf').instance!.used).toBe(50);
}, 30000);

test('a reopened native node resumes its recorded own history and receives only the new input delta on its next execution', async () => {
  const graph = await nativeContext({ work: [{ text: 'PERSISTED_PRIVATE_REPLY' }, { text: 'Reopened conversation replied' }] });
  await graph.create(nativeDefinition({ work: { ...nativeNode('work', 'INITIAL_TASK_ONCE_SENTINEL'), acceptance: ['INITIAL_ACCEPTANCE_ONCE_SENTINEL'] } }));
  await graph.send('work', { message: 'FIRST_INPUT_SENTINEL' }); const before = graph.runtime.nodeRun(graph.graphId, 'work');
  const originalPrompt = graph.runtime.nodePrompt(graph.graphId, 'work');
  await graph.reopen(); await graph.send('work', { message: 'NEXT_INPUT_SENTINEL' });
  const received = JSON.stringify(graph.providers.work!.requests[1]); const delta = nativeLastUser(graph.providers.work!.requests[1]);
  expect(received).toContain('PERSISTED_PRIVATE_REPLY'); expect(received).toContain('INITIAL_TASK_ONCE_SENTINEL');
  expect(delta).toContain('NEXT_INPUT_SENTINEL'); expect(delta).not.toContain('INITIAL_TASK_ONCE_SENTINEL'); expect(delta).not.toContain('INITIAL_ACCEPTANCE_ONCE_SENTINEL');
  const after = graph.runtime.nodeRun(graph.graphId, 'work'); expect(after.session!.sessionId).toBe(before.session!.sessionId); expect(after.instance!.id).toBe(before.instance!.id); expect(after.instance!.used).toBe(100);
  expect(graph.runtime.nodePrompt(graph.graphId, 'work').briefing).toEqual(originalPrompt.briefing);
  expect(await graph.main.graphInspect({ graphId: graph.graphId, query: 'executions' })).toMatchObject({ items: [expect.objectContaining({ state: 'completed' }), expect.objectContaining({ state: 'completed' })] });
}, 30000);

test('an unsupported transcript-inheritance patch is refused atomically and the existing native session remains usable', async () => {
  const graph = await nativeContext({ work: [{ text: 'ORIGINAL_VALID_REPLY' }, { text: 'Continued after refused patch' }], peer: [] });
  await graph.create(nativeDefinition({ work: nativeNode('work'), peer: nativeNode('peer') }));
  await graph.send('work'); const session = graph.runtime.nodeRun(graph.graphId, 'work').session!.sessionId;
  const revision = await graph.main.graphInspect({ graphId: graph.graphId, query: 'revision' });
  await expect(graph.main.graphPatch({ graphId: graph.graphId, baseRevision: 1, changes: { reason: 'Attempt retired transcript inheritance', patch: {
    nodes: { peer: { context: { sourceNode: 'work', requiredFacts: [{ kind: 'transcript_range' }] } } } } } })).rejects.toThrow(/Node peer.*context/);
  expect(await graph.main.graphInspect({ graphId: graph.graphId, query: 'revision' })).toEqual(revision);
  expect(graph.providers.peer!.requests).toHaveLength(0);
  await graph.send('work', { message: 'Continue using the valid definition' });
  expect(JSON.stringify(graph.providers.work!.requests[1])).toContain('ORIGINAL_VALID_REPLY');
  expect(graph.runtime.nodeRun(graph.graphId, 'work').session!.sessionId).toBe(session);
}, 30000);
