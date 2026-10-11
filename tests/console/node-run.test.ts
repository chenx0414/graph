import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { appendNodeEntry, listNodeEntries, nodeRun, recordCapabilityLoad } from '../../src/core/node-run.ts';
import { installPresets } from '../../src/catalog/presets.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const presetsRoot = fileURLToPath(new URL('../../presets', import.meta.url));

function nativeDraft() {
  return { requirementVersion: 1, summary: 'Inspect this node',
    acceptance: [{ id: 'ok', description: 'User inspects the result', checkNode: 'work' }],
    definition: parseGraphDefinition({ schemaVersion: 2, name: 'Node detail', protocols: { job: { type: 'object' } },
      nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Read the note and reply.', inputs: { job: { protocol: 'job' } },
        outputs: {}, submission: {} } }, modules: {}, edges: {},
      acceptance: [{ id: 'ok', description: 'User inspects the result', kind: 'human' }] }),
  };
}


async function workerFixture(name: string, plans: Parameters<typeof openaiServer>[0]) {
  const root = await mkdtemp(join(tmpdir(), `graph-node-run-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer(plans);
  cleanup.push(() => provider.close());
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'note.txt'), 'node-run marker line\n');
  const options = {
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }], actions: {},
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    limits: { defaultBudgetTokens: 20_000_000 },
  };
  let runtime = await openTaskRuntime(options);
  cleanup.push(() => runtime.close());
  await installPresets(runtime.catalog, presetsRoot);
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Node detail', requestId: 'begin' });
  await runtime.supervisor(taskId).propose(nativeDraft(), 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'accept' });
  return { taskId, runtime: () => runtime, restart: async () => {
    await runtime.close(); runtime = await openTaskRuntime(options);
  } };
}

test('a worker node projects real Pi entries, its session reference and operation timing', async () => {
  const provider = await openaiServer([
    { tools: [{ id: 'r1', name: 'read', arguments: JSON.stringify({ path: 'note.txt' }) }] },
    { text: 'Read the note and finished.' },
  ]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-node-run-projection-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'note.txt'), 'node-run marker line\n');
  const options = {
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }], actions: {},
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    limits: { defaultBudgetTokens: 20_000_000 },
  };
  let runtime = await openTaskRuntime(options);
  cleanup.push(() => runtime.close());
  await installPresets(runtime.catalog, presetsRoot);
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Node detail', requestId: 'begin' });
  await runtime.supervisor(taskId).propose(nativeDraft(), 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.supervisor(taskId).graphSend({ graphId: taskId, nodeId: 'work', input: 'job', value: {} });
  await runtime.host.drive();

  const first = await runtime.nodeRun(taskId, 'work');
  expect(first.node).toMatchObject({ id: 'work', kind: 'agent', status: 'succeeded' });
  expect(first.instance?.definitionVersion).toBe('coder@1');
  expect(first.session?.sessionId).toBeTruthy();
  const roles = first.entries.map(entry => `${entry.role}:${entry.kind}`);
  expect(first.entries[0]!.role).toBe('user');
  expect(first.entries[0]!.text).toContain('GRAPH OVERVIEW');
  expect(JSON.stringify(provider.requests[0])).toContain(JSON.stringify(first.entries[0]!.text).slice(1, -1));
  expect(roles).toContain('tool:call');
  expect(roles).toContain('tool:result');
  expect(roles).toContain('assistant:message');
  expect(first.entries.find(entry => entry.role === 'tool' && entry.kind === 'call')?.data).toMatchObject({ toolName: 'read' });
  expect(first.entries.find(entry => entry.role === 'assistant')?.text).toContain('Read the note');
  // Work time is measured from actual execution boundaries, not fabricated
  // from provider usage or the latest chat timestamp.
  expect(first.operations.length).toBeGreaterThanOrEqual(1);
  expect(first.operations[0]).toMatchObject({ state: 'completed', waitingMs: 0 });
  expect(first.operations[0]!.runMs).toBeGreaterThan(0);
  const elapsed = first.operations.map(operation => 'elapsedMs' in operation ? operation.elapsedMs : null);
  expect(elapsed[0]).toBeGreaterThan(0);
  expect(first.timing.totalMs).toBe(elapsed[0]);
  expect(first.timing.runMs).toBe(first.operations[0]!.runMs);
  expect(first.timing.waitingMs).toBe(0);
  expect(first.operations[0]!.runMs).toBeLessThanOrEqual(elapsed[0]!);
  expect(first.invocations.length).toBeGreaterThanOrEqual(2);
  expect(first.invocations.every(invocation => invocation.usageSource === 'authoritative')).toBe(true);
  expect(first.entryCount).toBe(first.entries.length);

  // Restarting the daemon keeps the same projection.
  await runtime.close();
  runtime = await openTaskRuntime(options);
  cleanup.push(() => runtime.close());
  const restored = await runtime.nodeRun(taskId, 'work');
  expect(restored.entries).toEqual(first.entries);
  expect(restored.session?.sessionId).toBe(first.session?.sessionId);
  expect(restored.operations.map(operation => 'elapsedMs' in operation ? operation.elapsedMs : null)).toEqual(elapsed);
  expect(restored.timing).toEqual(first.timing);
}, 120_000);

test('entry pagination stays stable when two nodes interleave more than 500 records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-node-run-paging-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t','p','x',1)").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('t','a','{}','x','succeeded')").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('t','b','{}','y','succeeded')").run();
  });
  for (let index = 0; index < 600; index += 1) {
    appendNodeEntry(store, { taskId: 't', nodeId: 'a', role: 'assistant', kind: 'message', text: `a-${index}` });
    appendNodeEntry(store, { taskId: 't', nodeId: 'b', role: 'assistant', kind: 'message', text: `b-${index}` });
  }
  const forward: string[] = [];
  let cursor = 0;
  for (;;) {
    const page = listNodeEntries(store, 't', 'a', { after: cursor, limit: 77 });
    if (!page.entries.length) break;
    forward.push(...page.entries.map(entry => entry.text));
    cursor = page.entries[page.entries.length - 1]!.seq;
  }
  expect(forward).toHaveLength(600);
  expect(new Set(forward).size).toBe(600);
  expect(forward[0]).toBe('a-0');
  expect(forward.at(-1)).toBe('a-599');
  // Backward paging from the end reaches the first record without duplicates.
  const backward: string[] = [];
  let before = 10_000;
  for (;;) {
    const page = listNodeEntries(store, 't', 'a', { before, limit: 100 });
    if (!page.entries.length) break;
    backward.unshift(...page.entries.map(entry => entry.text));
    before = page.entries[0]!.seq;
  }
  expect(backward).toEqual(forward);
  // Node b is untouched by node a paging.
  const other = listNodeEntries(store, 't', 'b', { limit: 500 });
  expect(other.entryCount).toBe(600);
  expect(other.entries.every(entry => entry.text.startsWith('b-'))).toBe(true);
}, 60_000);

test('a credential slot wait is recorded apart from the run duration', async () => {
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
  let releaseNative!: () => void;
  const nativeReleased = new Promise<void>(resolve => { releaseNative = resolve; });
  const provider = await openaiServer([
    { text: 'first done', beforeReply: () => firstReleased },
    { text: 'second done' },
    { text: 'native first done', beforeReply: () => nativeReleased },
    { text: 'native second done' },
    { text: 'native next execution done' },
  ]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-node-run-wait-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }], actions: {},
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }], apiKey: '', credentialFor: () => ({ credentialId: 'local', apiKey: 'k', limit: 1 }), modelRuntime: provider.runtime },
    live: {
      revision: () => 0,
      config: () => ({}),
      entries: () => [{ id: 'local', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      preferences: () => ({}),
      credentialFor: () => ({ credentialId: 'local', apiKey: 'k', limit: 1 }),
      masterModel: () => 'local',
      defaultBudgetTokens: () => null,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(async () => { releaseFirst(); releaseNative(); await runtime.close(); });
  await installPresets(runtime.catalog, presetsRoot);
  const first = await runtime.conversations.create({ text: '第一个会话。', requestId: 'conv-one' });
  const second = await runtime.conversations.create({ text: '第二个会话。', requestId: 'conv-two' });
  // Drive both chatting masters at once; the second send queues behind the
  // single credential slot while the first provider response is delayed.
  const driving = runtime.host.drive();
  // The second master waits for the single credential slot while the first is
  // still in flight; the wait must be recorded apart from run time.
  // Either master may win the race for the single slot; the other one parks.
  const deadline = Date.now() + 8_000;
  let waitingTask: string | undefined;
  for (;;) {
    waitingTask = [first.taskId, second.taskId].find(taskId => runtime.nodeRun(taskId, 'master').operations.some(operation => operation.waitingSlot));
    if (waitingTask) break;
    if (Date.now() > deadline) throw new Error(`no master recorded a slot wait (${provider.requests.length} provider requests)`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  releaseFirst();
  await driving;
  const detail = runtime.nodeRun(waitingTask, 'master');
  expect(detail.operations.length).toBeGreaterThanOrEqual(1);
  expect(detail.operations[0]!.runMs).not.toBeNull();
  expect(detail.operations[0]!.waitingMs).toBeGreaterThanOrEqual(0);

  const main = runtime.supervisor(first.taskId);
  const node = { recipe: 'coder@1', model: 'local', task: 'Reply to the input', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} };
  const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Native measured waits',
    protocols: { data: { type: 'object' } }, nodes: { a: node, b: node }, modules: {}, edges: {} }) }) as { graphId: string };
  await main.graphSend({ graphId, nodeId: 'a', input: 'job', value: {} });
  await main.graphSend({ graphId, nodeId: 'b', input: 'job', value: {} });
  const nativeDriving = runtime.host.drive();
  let waitingNode!: string;
  await expect.poll(() => {
    waitingNode = ['a', 'b'].find(id => runtime.nodeRun(graphId, id).operations.some(operation => operation.waitingSlot)) ?? '';
    return waitingNode && runtime.nodeRun(graphId, waitingNode).timing.waitingMs;
  }, { timeout: 10_000 }).toBeGreaterThan(0);
  const held = runtime.nodeRun(graphId, waitingNode);
  expect(held.timing).toMatchObject({ inProgress: true });
  expect(held.timing.runMs).toBeGreaterThan(0);
  expect(runtime.nodeRun(graphId, waitingNode).timing.runMs).toBe(held.timing.runMs);
  releaseNative();
  await nativeDriving;
  const finished = runtime.nodeRun(graphId, waitingNode);
  expect(finished.timing).toMatchObject({ inProgress: false });
  expect(finished.timing.waitingMs).toBeGreaterThanOrEqual(held.timing.waitingMs!);
  expect(finished.timing.runMs).toBeGreaterThan(held.timing.runMs!);
  expect(finished.timing.runMs! + finished.timing.waitingMs!).toBe(finished.timing.totalMs);

  // Idle time between deliveries is not work; each execution contributes once.
  await main.graphSend({ graphId, nodeId: waitingNode, input: 'job', value: {} });
  await runtime.host.drive();
  const rerun = runtime.nodeRun(graphId, waitingNode);
  expect(rerun.operations).toHaveLength(2);
  expect(rerun.timing.runMs).toBe(rerun.operations.reduce((total, operation) => total + operation.runMs!, 0));
  expect(rerun.timing.waitingMs).toBe(rerun.operations.reduce((total, operation) => total + operation.waitingMs!, 0));
}, 120_000);

test('the node detail API serves the projection over HTTP', async () => {
  const provider = await openaiServer([{ text: 'hello' }]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-node-run-http-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  const { openGraphServer } = await import('../../src/server/host.ts');
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }], actions: {},
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
  });
  cleanup.push(() => server.close());
  await installPresets(server.runtime.catalog, presetsRoot);
  const { taskId } = await server.runtime.user.begin({ projectId: 'p', request: 'Node HTTP', requestId: 'begin' });
  await server.runtime.supervisor(taskId).propose(nativeDraft(), 'proposal');
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'accept' });
  await server.runtime.supervisor(taskId).graphSend({ graphId: taskId, nodeId: 'work', input: 'job', value: {} });
  await server.runtime.host.drive();
  const home = await fetch(server.url, { headers: { origin: server.url } });
  const headers = { origin: server.url, cookie: home.headers.get('set-cookie') ?? '' };
  const response = await fetch(`${server.url}/api/tasks/${taskId}/nodes/work/run?limit=2`, { headers });
  expect(response.status).toBe(200);
  const body = await response.json() as { entries: unknown[]; entryCount: number; session: { sessionId: string } | null };
  expect(body.entryCount).toBeGreaterThan(0);
  expect(body.entries.length).toBeLessThanOrEqual(2);
  expect(body.session?.sessionId).toBeTruthy();
  const missing = await fetch(`${server.url}/api/tasks/${taskId}/nodes/nope/run`, { headers });
  expect(missing.status).toBe(400);
  // A task that never got a graph has no containers to fall back to: the honest answer is still
  // "unknown node", not a crash while looking for a container that cannot exist.
  const fresh = await server.runtime.user.begin({ projectId: 'p', request: 'No graph yet', requestId: 'begin-2' });
  const bare = await fetch(`${server.url}/api/tasks/${fresh.taskId}/nodes/nope/run`, { headers });
  expect(bare.status).toBe(400);
  expect((await bare.json() as { message: string }).message).toContain('Unknown node');
}, 120_000);

test('a terminal node is not in progress because of a historical not_sent attempt (UC-R13-R1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-node-timing-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t','p','timing',1,'running')").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,status,activation_id,output_version,stall_count) VALUES('t','work','{\"id\":\"work\",\"kind\":\"agent\",\"action\":\"work\"}','succeeded','act',1,0)").run();
    const insert = store.db.prepare(`INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,worker_active,result,usage,activation_id,dispatched_at,settled_at,waiting_ms)
      VALUES(?,?,?,?,0,'{}',?,0,?,?,NULL,'act',?,?,0)`);
    insert.run('o1', 't', 'work', null, 'not_sent', 0, '{}', 1_000, 1_000);
    insert.run('o2', 't', 'work', null, 'succeeded', 0, '{}', 1_000, 2_000);
  });
  const view = nodeRun(store, 't', 'work');
  expect(view.operations).toHaveLength(2);
  expect(view.timing).toMatchObject({ inProgress: false, totalMs: 1_000, runMs: 1_000 });
});

test('node detail aggregates capability tool calls into success statistics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-usage-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t','p','capability usage',1,'running')").run();
    store.db.prepare("INSERT INTO definitions(id,version,spec) VALUES('coder',1,?)").run(JSON.stringify({
      recommendedGrade: 'high',
      capabilities: [{ id: 'demo-mcp', version: '1.0.0' }],
    }));
    store.db.prepare("INSERT INTO capabilities(id,kind,source,version,snapshot,status) VALUES('demo-mcp','mcp',?,?,?,'available')")
      .run(join(root, 'demo-mcp'), '1.0.0', JSON.stringify({ name: 'Demo MCP' }));
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,status,activation_id,output_version,stall_count) VALUES('t','work',?,'succeeded','act',1,0)")
      .run(JSON.stringify({ id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1' }));
  });
  recordCapabilityLoad(store, {
    taskId: 't',
    nodeId: 'work',
    operationId: 'op',
    readOnly: false,
    report: [{
      id: 'demo-mcp', version: '1.0.0', kind: 'mcp', loaded: true, executable: true, reason: null,
      name: 'Demo MCP', tools: ['mcp:demo:search', 'mcp:demo:write'],
    }],
  });
  appendNodeEntry(store, { taskId: 't', nodeId: 'work', role: 'tool', kind: 'call', text: 'search', data: { toolCallId: 'c1', toolName: 'mcp:demo:search' } });
  appendNodeEntry(store, { taskId: 't', nodeId: 'work', role: 'tool', kind: 'result', text: 'ok', data: { toolCallId: 'c1', toolName: 'mcp:demo:search', isError: false } });
  appendNodeEntry(store, { taskId: 't', nodeId: 'work', role: 'tool', kind: 'call', text: 'write', data: { toolCallId: 'c2', toolName: 'mcp:demo:write' } });
  appendNodeEntry(store, { taskId: 't', nodeId: 'work', role: 'tool', kind: 'result', text: 'failed', data: { toolCallId: 'c2', toolName: 'mcp:demo:write', isError: true } });
  appendNodeEntry(store, { taskId: 't', nodeId: 'work', role: 'tool', kind: 'call', text: 'search again', data: { toolCallId: 'c3', toolName: 'mcp:demo:search' } });

  expect(nodeRun(store, 't', 'work').capabilityUsage).toEqual([
    expect.objectContaining({
      id: 'demo-mcp', version: '1.0.0', name: 'Demo MCP', calls: 3, successes: 1, failures: 1, pending: 1, successRate: 0.5,
    }),
  ]);
});

test('pause and user-wait accumulate only at state boundaries with recorded facts (C02)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-time-ledger-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  const { openPause, closePause, openUserWait, closeUserWait } = await import('../../src/core/time-ledger.ts');
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t','p','ledger',1,'running')").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,status,activation_id,output_version,stall_count) VALUES('t','work','{\"id\":\"work\",\"kind\":\"agent\",\"action\":\"work\"}','running','act',1,0)").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,status,activation_id,output_version,stall_count) VALUES('t','old','{\"id\":\"old\",\"kind\":\"agent\",\"action\":\"work\"}','succeeded','old-act',1,0)").run();
  });
  store.transaction(() => {
    openPause(store, 't', 1_000);
    closePause(store, 't', 2_000);
    openUserWait(store, 't', 'work', 1_000);
    closeUserWait(store, 't', 'work', 1_500);
  });
  const recorded = nodeRun(store, 't', 'work');
  expect(recorded.timing.pauseMs).toBe(1_000);
  expect(recorded.timing.userWaitMs).toBe(500);
  // A second close inside the same segment must not double count.
  store.transaction(() => { closePause(store, 't', 9_999); closeUserWait(store, 't', 'work', 9_999); openPause(store, 't', 10_000); closePause(store, 't', 10_100); });
  expect(nodeRun(store, 't', 'work').timing.pauseMs).toBe(1_100);
  // Historical nodes keep NULL columns and must still read as "未记录".
  const historical = nodeRun(store, 't', 'old');
  expect(historical.timing.pauseMs).toBeNull();
  expect(historical.timing.userWaitMs).toBeNull();
  // An open segment is counted live while the node is active ...
  const now = Date.now();
  store.transaction(() => openUserWait(store, 't', 'work', now - 300));
  expect(nodeRun(store, 't', 'work').timing.userWaitMs).toBeGreaterThanOrEqual(300);
  // ... but a terminal node does not grow an unclosed segment forever.
  store.transaction(() => { store.db.prepare("UPDATE nodes SET status='succeeded' WHERE task_id='t' AND id='work'").run(); });
  const frozen = nodeRun(store, 't', 'work').timing.userWaitMs!;
  expect(frozen).toBeGreaterThanOrEqual(300);
  expect(nodeRun(store, 't', 'work').timing.userWaitMs).toBe(frozen);
});

test('native pause timing survives restart and counts overlapping graph and node pauses once (C02)', async () => {
  const { taskId, runtime, restart } = await workerFixture('pause-ledger', [{ text: 'done' }]);
  const detail = async () => {
    const view = await runtime().nodeRun(taskId, 'work');
    if (!('pauseMs' in view.timing)) throw new Error('Expected native node timing');
    return { ...view, timing: view.timing };
  };
  expect((await detail()).timing.pauseMs).toBeNull();
  await runtime().user.task(taskId).pause('pause-ledger');
  const start = Date.now();
  await runtime().supervisor(taskId).graphControl({ graphId: taskId, action: 'pause', nodeId: 'work' });
  await restart();
  await runtime().user.task(taskId).resume('resume-ledger');
  await new Promise(resolve => setTimeout(resolve, 150));
  const minimum = Date.now() - start;
  expect((await detail()).timing.pauseMs!).toBeGreaterThanOrEqual(minimum);
  await runtime().supervisor(taskId).graphControl({ graphId: taskId, action: 'resume', nodeId: 'work' });
  const elapsed = Date.now() - start;
  const view = await detail();
  expect(view.timing.pauseMs).not.toBeNull();
  expect(view.timing.pauseMs!).toBeGreaterThanOrEqual(100);
  expect(view.timing.pauseMs!).toBeLessThanOrEqual(elapsed + 100);
  expect(view.timing.userWaitMs).toBeNull();
  await runtime().supervisor(taskId).graphControl({ graphId: taskId, action: 'resume', nodeId: 'work' });
  await runtime().user.task(taskId).resume('resume-again');
  await restart();
  expect((await detail()).timing.pauseMs).toBe(view.timing.pauseMs);
  expect((await detail()).operations).toHaveLength(0);
  // Reverse the overlap: resuming a node must not close a graph pause.
  await runtime().supervisor(taskId).graphControl({ graphId: taskId, action: 'pause', nodeId: 'work' });
  await runtime().supervisor(taskId).graphControl({ graphId: taskId, action: 'pause' });
  await runtime().supervisor(taskId).graphControl({ graphId: taskId, action: 'resume', nodeId: 'work' });
  const held = (await detail()).timing.pauseMs!;
  await new Promise(resolve => setTimeout(resolve, 100));
  expect((await detail()).timing.pauseMs!).toBeGreaterThanOrEqual(held + 100);
  await runtime().supervisor(taskId).graphControl({ graphId: taskId, action: 'stop' });
  const stopped = (await detail()).timing.pauseMs;
  await restart();
  expect((await detail()).timing.pauseMs).toBe(stopped);
});
