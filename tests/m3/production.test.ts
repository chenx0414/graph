import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { createApp } from '../../src/server/app.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

function entry(baseUrl: string, id = 'local') {
  return { id, provider: 'graph-openai' as const, grade: 'high' as const, api: 'openai-completions' as const, baseUrl, contextWindow: 32_000, maxTokens: 256 };
}

// The external main submits native JSON directly; no legacy node array or converter.
const proposal = (requirementVersion: number) => ({
  requirementVersion,
  summary: 'Case-insensitive title search',
  acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
  definition: parseGraphDefinition({ schemaVersion: 2, name: 'Title search', protocols: { result: { type: 'object' } },
    nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Implement case-insensitive title search',
      inputs: { job: { protocol: 'result' } }, outputs: { done: { protocol: 'result' } }, submission: { required: ['done'] } } },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { start: { protocol: 'result' } }, outputs: { result: { protocol: 'result' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } },
    edges: { checked: { from: 'work.done', to: 'check.start', enabled: true } },
    inputs: { job: { to: 'work.job', protocol: 'result' } }, outputs: { result: { from: 'check.result', protocol: 'result' } },
    acceptance: [{ id: 'ok', description: 'Works', kind: 'check', module: 'check' }],
  }),
});

/** Real native worker and resident Pi; replies need no workflow submission. */
async function runNativeWorker(runtime: Awaited<ReturnType<typeof openTaskRuntime>>) {
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Implement', requestId: 'begin' });
  const main = runtime.supervisor(owner.taskId);
  const graph = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Provider accounting', protocols: {},
    nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Implement the request', inputs: {}, outputs: {}, submission: {} } }, modules: {}, edges: {} }) }) as { graphId: string };
  await main.graphSend({ graphId: graph.graphId, nodeId: 'work', text: 'Implement the request' });
  await runtime.host.drive();
  return { main, graphId: graph.graphId, run: runtime.nodeRun(graph.graphId, 'work') };
}

test('a production master receives tools, proposes a graph, and wakes on a later user message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-prod-master-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const plan = proposal(1);
  const provider = await openaiServer([
    { tools: [{ id: 'p1', name: 'propose_graph', arguments: JSON.stringify({ proposal: plan, requestId: 'plan-1' }) }] },
    { text: 'I proposed a case-insensitive title search graph.' },
    { text: 'Noted, matching will ignore case.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'def');
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Read the source and implement title search.', requestId: 'begin' });
  await runtime.host.runReady();
  const proposed = await runtime.user.task(taskId).view();
  expect(proposed.proposalVersion).toBe(1);
  expect(proposed.proposal?.summary).toMatch(/title search/i);
  expect(proposed.proposal?.definition).toMatchObject({ schemaVersion: 2, nodes: { work: { recipe: 'coder@1' } }, modules: { check: { type: 'operation' } } });
  expect(Object.keys(proposed.proposal!.definition!.nodes)).toEqual(['work']);
  expect((provider.requests[0] as { tools?: unknown[] }).tools?.length).toBeGreaterThan(0);
  const tools = (provider.requests[0] as { tools: { function: { name: string; description: string } }[] }).tools;
  expect(tools.find(tool => tool.function.name === 'propose_graph')?.function.description).toContain('schemaVersion:2');
  await runtime.user.task(taskId).say('Yes, please use case-insensitive matching.', 'say');
  expect((await runtime.user.task(taskId).view()).nodes.find(node => node.id === 'master')?.status).toBe('pending');
  await runtime.host.runReady();
  expect((await runtime.user.task(taskId).view()).nodes.find(node => node.id === 'master')?.status).toBe('succeeded');
  expect(provider.requests.length).toBeGreaterThanOrEqual(3);
});

test('a production master receives compact rules without the removed workflow prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-prod-schema-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer([{ text: 'Proposed later.' }]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'def');
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  await runtime.user.begin({ projectId: 'p', request: 'Implement title search.', requestId: 'begin' });
  await runtime.host.runReady();
  const prompt = JSON.stringify(provider.requests[0]);
  expect(prompt).toContain('Requirement version: 1');
  expect(prompt).toContain('<rules>\\n- Use bash for file operations like ls, rg, find');
  expect(prompt).toContain('R14 When one node stays blocked for three rounds');
  expect(prompt).not.toContain('<workflow>');
  expect(prompt).not.toContain('proposalJson schema');
});

test('a later user message is delivered to the production master provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-prod-followup-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer([
    { text: 'Please clarify the matching rule.' },
    { text: 'Acknowledged, matching will ignore case.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'def');
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Implement title search.', requestId: 'begin' });
  await runtime.host.runReady();
  await runtime.user.task(taskId).say('FOLLOWUP_SENTINEL_97531: titles must ignore case.', 'say');
  await runtime.host.runReady();
  expect(provider.requests).toHaveLength(2);
  expect(JSON.stringify(provider.requests[0])).not.toContain('FOLLOWUP_SENTINEL_97531');
  expect(JSON.stringify(provider.requests[1])).toContain('FOLLOWUP_SENTINEL_97531');
});

test('a production Pi session may exceed a single-call reservation without blocking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-prod-reserve-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer([
    { tools: [{ id: 'w1', name: 'write_file', arguments: JSON.stringify({ path: 'feature.txt', content: 'done' }) }], usage: { prompt_tokens: 60_000, completion_tokens: 5 } },
    { text: 'Wrote the feature.', usage: { prompt_tokens: 60_000, completion_tokens: 5 } },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    limits: { defaultBudgetTokens: 20_000_000 },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'def');
  const { main, graphId, run } = await runNativeWorker(runtime);
  expect(provider.requests).toHaveLength(2);
  expect(run.node.status).toBe('succeeded');
  expect(run.instance?.used).toBe(120_010);
  expect(run.invocations).toHaveLength(2);
  const calls = await main.graphInspect({ graphId, query: 'provider_calls' }) as { state: string }[];
  expect(calls.every(call => call.state === 'settled')).toBe(true);
  expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('done');
});

test('unknown usage on a production request blocks the next provider call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-prod-usage-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer([
    { tools: [{ id: 'read-1', name: 'read', arguments: '{"path":"package.json"}' }], usage: null },
    { text: 'Implementation done.' },
  ]);
  cleanup.push(() => provider.close());
  await writeFile(join(root, 'package.json'), '{}\n');
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    limits: { defaultBudgetTokens: 20_000_000 },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'def');
  const { main, graphId, run } = await runNativeWorker(runtime);
  expect(provider.requests).toHaveLength(1);
  expect(run.node.status).toBe('blocked');
  const calls = await main.graphInspect({ graphId, query: 'provider_calls' }) as { state: string; usage: unknown; reserved: number }[];
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ state: 'unknown', usage: null });
  expect(calls[0]!.reserved).toBeGreaterThan(0);
  await main.graphSend({ graphId, nodeId: 'work', text: 'This queued follow-up must wait for usage reconciliation' });
  await runtime.host.drive();
  expect(provider.requests).toHaveLength(1);
});

test('reconciling unknown usage accumulates the known calls and applies the result once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-prod-reconcile-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer([
    { tools: [{ id: 'read-1', name: 'read', arguments: '{"path":"package.json"}' }], usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: 'Implementation done.', usage: null },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(root, 'ok'), digest: 'a'.repeat(64) } }] }) } },
    limits: { defaultBudgetTokens: 20_000_000 },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'def');
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Implement', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Work',
    acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.runReady();
  const blocked = await runtime.user.task(taskId).view();
  expect(blocked.questions.map(question => question.kind)).toContain('unknown_usage');
  await runtime.user.task(taskId).answer(blocked.questions[0]!.id, { type: 'reconcile_usage', proof: 'Provider exposes no usage for the failed call' }, 'reconcile');
  const after = await runtime.user.task(taskId).view();
  const work = after.nodes.find(node => node.id === 'work')!;
  expect(work).toMatchObject({ status: 'succeeded', used: 50, outputVersion: 1 });
  const unknown = after.invocations.filter(invocation => invocation.usage === null);
  expect(unknown).toHaveLength(1);
  expect(unknown[0]!.cost).toEqual({ unknown: true });
  // A second reconcile cannot double count: the question is already resolved.
  await expect(runtime.user.task(taskId).answer(blocked.questions[0]!.id, { type: 'reconcile_usage', proof: 'again' }, 'again')).rejects.toMatchObject({ code: 'invalid_question' });
  expect((await runtime.user.task(taskId).view()).nodes.find(node => node.id === 'work')!.used).toBe(50);
});

test('a production request that exceeds the budget cannot send a follow-up call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-prod-budget-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer([
    { tools: [{ id: 'read-1', name: 'read', arguments: '{"path":"package.json"}' }], usage: { prompt_tokens: 20_000_000, completion_tokens: 1 } },
    { text: 'Implementation done.' },
  ]);
  cleanup.push(() => provider.close());
  await writeFile(join(root, 'package.json'), '{}\n');
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },

    limits: { defaultBudgetTokens: 20_000_000 },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'def');
  const { main, graphId, run } = await runNativeWorker(runtime);
  expect(provider.requests).toHaveLength(1);
  expect(run.instance?.used).toBe(20_000_001);
  expect(run.invocations).toHaveLength(1);
  await main.graphSend({ graphId, nodeId: 'work', text: 'This queued follow-up must wait for a budget change' });
  await runtime.host.drive();
  expect(provider.requests).toHaveLength(1);
});

test('a production worker receives the task graph with the check commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-prod-graph-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'README.md'), 'project\n');
  const provider = await openaiServer([{ text: 'Inspected the checks.' }]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: { kind: 'program', prepare: async () => async () => ({
      outcome: 'completed', output: null,
      evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(root, 'ok'), digest: 'a'.repeat(64) } }],
    }) } },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'def');
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Implement', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Work',
    acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['--test', 'test/specific.test.js'] } },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const prompt = JSON.stringify(provider.requests[0]);
  expect(prompt).toContain('test/specific.test.js');
  expect(prompt).toContain('ok (check check)');
});

test('a production reviewer receives the independent review report schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-prod-review-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{}\n');
  const provider = await openaiServer([
    { tools: [{ id: 'w1', name: 'write', arguments: JSON.stringify({ path: 'feature.txt', content: 'x' }) }] },
    { text: 'Wrote the feature.' },
    { text: 'Review submitted.' },
  ]);
  cleanup.push(() => provider.close());
  const reader = { ...provider.model, id: 'reader' };
  provider.runtime.registerProvider('graph-openai-reader', { baseUrl: provider.model.baseUrl, api: 'openai-completions', apiKey: 'scripted-local-key', models: [reader] });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: { entries: [entry(provider.model.baseUrl), { id: 'reader', provider: 'graph-openai-reader', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: { kind: 'program', prepare: async () => async () => ({
      outcome: 'completed', output: null,
      evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(root, 'ok'), digest: 'a'.repeat(64) } }],
    }) } },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Implement', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Work',
    acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
      { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'reader', dependsOn: ['check'] },
      { id: 'review-gate', kind: 'program', action: 'graph.verify', dependsOn: ['review'], verifier: { kind: 'independent', reportNodes: ['review'] } },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const reviewRequest = provider.requests.map(request => JSON.stringify(request)).find(text => text.includes('graph.verify independent gate'));
  expect(reviewRequest).toBeDefined();
  expect(reviewRequest).toContain('sha256');
});

test('a production worker writes the workspace through tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-prod-write-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'README.md'), 'project\n');
  const provider = await openaiServer([
    { tools: [{ id: 'w1', name: 'write', arguments: JSON.stringify({ path: 'feature.txt', content: 'done' }) }] },
    { text: 'Wrote feature.txt' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: { kind: 'program', prepare: async operation => async () => {
      const path = join(operation.workspace ?? root, 'feature.txt');
      const body = await readFile(path, 'utf8');
      return { outcome: 'completed', output: { body }, evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path, digest: 'a'.repeat(64) } }] };
    } } },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'def');
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Write the feature', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Work',
    acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const view = await runtime.user.task(taskId).view();
  expect(view.questions).toEqual([]);
  expect(view.nodes.find(node => node.id === 'work')).toMatchObject({ status: 'succeeded' });
  // The Pi worker wrote through its tools into the isolated work copy.
  const workerTree = view.worktrees.find(item => item.nodeId === 'work')!.path;
  expect(await readFile(join(workerTree, 'feature.txt'), 'utf8')).toBe('done');
});

test('HTTP production master can discuss then propose through the adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-prod-http-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const plan = proposal(1);
  const provider = await openaiServer([
    { tools: [{ id: 'p1', name: 'propose_graph', arguments: JSON.stringify({ proposal: plan, requestId: 'plan-http' }) }] },
    { text: 'Proposed.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  const app = await createApp(runtime, { origin: 'http://127.0.0.1' });
  cleanup.push(() => app.close());
  const cookie = (await app.inject({ method: 'GET', url: '/' })).cookies[0];
  const headers = { cookie: `${cookie!.name}=${cookie!.value}`, origin: 'http://127.0.0.1' };
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'def');
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId } = (await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { projectId: 'p', request: 'Implement title search', requestId: 'begin' } })).json() as { taskId: string };
  await runtime.host.runReady();
  const view = await runtime.user.task(taskId).view();
  expect(view.proposalVersion).toBe(1);
  expect(view.proposal?.definition).toMatchObject({ schemaVersion: 2, modules: { check: { type: 'operation' } } });
  expect(provider.requests).toHaveLength(2);
});
