// graph:allow-large-file: 14 个真实 daemon 迁移用例共用同一崩溃/重启夹具，拆分会让同一迁移竞态分居两个文件。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { DEFINITION, PROPOSAL } from './go-graph-confirmation.fixture.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

function identity(value: unknown) {
  if (typeof value !== 'object' || value === null ||
      !('conversationId' in value) || typeof value.conversationId !== 'string' ||
      !('taskId' in value) || typeof value.taskId !== 'string' ||
      !('role' in value) || (value.role !== 'global' && value.role !== 'project') ||
      !('projectId' in value) || (value.projectId !== null && typeof value.projectId !== 'string')) {
    throw new Error(`Expected a supervisor thread receipt: ${JSON.stringify(value)}`);
  }
  return {
    conversationId: value.conversationId,
    taskId: value.taskId,
    role: value.role,
    projectId: value.projectId,
  };
}

function message(value: unknown) {
  if (typeof value !== 'object' || value === null ||
      !('role' in value) || typeof value.role !== 'string' ||
      !('text' in value) || typeof value.text !== 'string') {
    throw new Error(`Expected a conversation message: ${JSON.stringify(value)}`);
  }
  return { role: value.role, text: value.text };
}

function messages(value: unknown) {
  if (typeof value !== 'object' || value === null ||
      !('messages' in value) || !Array.isArray(value.messages)) {
    throw new Error(`Expected a conversation projection: ${JSON.stringify(value)}`);
  }
  return value.messages.map(message);
}

async function read(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}

async function fixture(provider?: Awaited<ReturnType<typeof openaiServer>>) {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-orchestration-identity-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    ...(provider ? {
      credentials: { local: { secretRef: 'GRAPH_IDENTITY_TEST_KEY' } },
      models: { entries: [{
        id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256,
        credentialId: 'local',
      }] },
    } : {}),
  }));
  const start = async () => {
    const daemon = await launchCli(root, {
      configPath, extraArgs: provider ? ['--execute'] : [],
      env: { GRAPH_IDENTITY_TEST_KEY: 'synthetic-identity-key' },
    });
    cleanup.push(() => daemon.close());
    return daemon;
  };
  return { root, start, daemon: await start() };
}

async function open(daemon: Awaited<ReturnType<typeof launchCli>>, path: string, requestId: string) {
  return identity(await read(await daemon.request(path, {
    method: 'POST', body: JSON.stringify({ requestId }),
  })));
}

async function transcript(daemon: Awaited<ReturnType<typeof launchCli>>, conversationId: string) {
  return messages(await read(await daemon.request(`/api/conversations/${conversationId}`)));
}

test('global and project threads keep their identity across concurrent opens and daemon restart without a model', async () => {
  const f = await fixture();
  const repeated = await Promise.all(Array.from({ length: 8 }, async (_, index) => ({
    global: await open(f.daemon, '/api/orchestration/global', `global-open-${index}`),
    project: await open(f.daemon, '/api/projects/p/thread', `project-open-${index}`),
  })));
  const first = repeated[0];
  if (!first) throw new Error('Concurrent thread opens returned no receipts');
  const { global, project } = first;
  expect(global).toMatchObject({ role: 'global', projectId: null });
  expect(project).toMatchObject({ role: 'project', projectId: 'p' });
  expect(global.conversationId).not.toBe(project.conversationId);
  expect(global.taskId).not.toBe(project.taskId);
  for (const item of repeated) {
    expect(item.global).toEqual(global);
    expect(item.project).toEqual(project);
  }
  expect(await transcript(f.daemon, global.conversationId)).toEqual([]);
  expect(await transcript(f.daemon, project.conversationId)).toEqual([]);

  const unknown = await f.daemon.request('/api/projects/missing/thread', {
    method: 'POST', body: JSON.stringify({ requestId: 'unknown-project' }),
  });
  expect([400, 404]).toContain(unknown.status);

  await f.daemon.close();
  const restarted = await f.start();
  expect(await open(restarted, '/api/orchestration/global', 'global-after-restart')).toEqual(global);
  expect(await open(restarted, '/api/projects/p/thread', 'project-after-restart')).toEqual(project);
  expect(await transcript(restarted, global.conversationId)).toEqual([]);
  expect(await transcript(restarted, project.conversationId)).toEqual([]);
}, 60_000);

test('opening a configured global thread makes no model request and its first real message starts the conversation', async () => {
  const provider = await openaiServer([{ text: 'Ready to coordinate your projects.' }]);
  cleanup.push(() => provider.close());
  const f = await fixture(provider);
  const global = await open(f.daemon, '/api/orchestration/global', 'configured-global');
  await open(f.daemon, '/api/projects/p/thread', 'configured-project');
  expect(await transcript(f.daemon, global.conversationId)).toEqual([]);
  expect(provider.requests).toHaveLength(0);

  await read(await f.daemon.request(`/api/conversations/${global.conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ text: 'What projects can you manage?', requestId: 'first-real-message' }),
  }));
  await expect.poll(async () => transcript(f.daemon, global.conversationId), {
    timeout: 30_000, interval: 100,
  }).toContainEqual({ role: 'assistant', text: 'Ready to coordinate your projects.' });
  const history = await transcript(f.daemon, global.conversationId);
  expect(history.filter(item => item.role === 'user')).toEqual([
    { role: 'user', text: 'What projects can you manage?' },
  ]);
  expect(provider.requests).toHaveLength(1);
}, 60_000);


test('the only existing project conversation becomes its project thread without losing history', async () => {
  const f = await fixture();
  const old = identityFromLegacy(await read(await f.daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', text: 'Existing project history', requestId: 'legacy-project' }),
  })));
  const thread = await open(f.daemon, '/api/projects/p/thread', 'promote-only-thread');
  expect(thread.conversationId).toBe(old);
  expect(await transcript(f.daemon, old)).toContainEqual({ role: 'user', text: 'Existing project history' });
  await f.daemon.close();
  const restarted = await f.start();
  expect((await open(restarted, '/api/projects/p/thread', 'open-after-promotion')).conversationId).toBe(old);
}, 60_000);

function identityFromLegacy(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('conversationId' in value) || typeof value.conversationId !== 'string') {
    throw new Error(`Expected existing conversation: ${JSON.stringify(value)}`);
  }
  return value.conversationId;
}

test('choosing one of several existing project conversations preserves the other as read-only history', async () => {
  const provider = await openaiServer([{ text: 'First history settled.' }, { text: 'Second history settled.' }]);
  cleanup.push(() => provider.close());
  const f = await fixture(provider);
  async function createLegacy(text: string, requestId: string) {
    return identityFromLegacy(await read(await f.daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', text, requestId }),
    })));
  }
  const first = await createLegacy('First historical conversation', 'first-history');
  await expect.poll(async () => transcript(f.daemon, first), { timeout: 30_000 })
    .toContainEqual({ role: 'assistant', text: 'First history settled.' });
  const second = await createLegacy('Second historical conversation', 'second-history');
  await expect.poll(async () => transcript(f.daemon, second), { timeout: 30_000 })
    .toContainEqual({ role: 'assistant', text: 'Second history settled.' });
  const ambiguous = await f.daemon.request('/api/projects/p/thread', {
    method: 'POST', body: JSON.stringify({ requestId: 'ambiguous' }),
  });
  expect(ambiguous.status).toBe(400);
  const selected = identity(await read(await f.daemon.request('/api/projects/p/thread/select', {
    method: 'POST', body: JSON.stringify({ conversationId: first, requestId: 'select-first' }),
  })));
  expect(selected.conversationId).toBe(first);
  expect((await open(f.daemon, '/api/projects/p/thread', 'open-selected')).conversationId).toBe(first);
  expect(await transcript(f.daemon, second)).toContainEqual({ role: 'user', text: 'Second historical conversation' });
  const writeHistory = await f.daemon.request(`/api/conversations/${second}/messages`, {
    method: 'POST', body: JSON.stringify({ text: 'This must not execute', requestId: 'old-history-write' }),
  });
  expect(writeHistory.status).toBe(400);
  await f.daemon.close();
  const restarted = await f.start();
  expect((await open(restarted, '/api/projects/p/thread', 'selected-after-restart')).conversationId).toBe(first);
  expect(await transcript(restarted, second)).toContainEqual({ role: 'user', text: 'Second historical conversation' });
}, 60_000);

test('simultaneous identical graph creation requests return one graph', async () => {
  const f = await fixture();
  const project = await open(f.daemon, '/api/projects/p/thread', 'parallel-create-project');
  const body = JSON.stringify({ conversationId: project.conversationId, definition: DEFINITION, requestId: 'parallel-graph' });
  const receipts = await Promise.all(Array.from({ length: 12 }, async () => read(await f.daemon.request('/api/graphs', { method: 'POST', body }))));
  const ids = receipts.map(receipt => {
    if (typeof receipt !== 'object' || receipt === null || !('graphId' in receipt) || typeof receipt.graphId !== 'string') throw new Error(`Missing graph id: ${JSON.stringify(receipt)}`);
    return receipt.graphId;
  });
  expect(new Set(ids).size).toBe(1);
  const changed = await f.daemon.request('/api/graphs', { method: 'POST', body: JSON.stringify({ conversationId: project.conversationId, definition: { ...DEFINITION, name: 'Different graph' }, requestId: 'parallel-graph' }) });
  expect(changed.status).not.toBe(200);
  const db = new DatabaseSync(join(f.root, 'state', 'tasks.sqlite'), { readOnly: true });
  expect(db.prepare("SELECT COUNT(*) AS count FROM kernel_create_requests WHERE request_id='parallel-graph'").get()).toMatchObject({ count: 1 });
  db.close();
}, 60_000);

test('a supervisor can confirm a draft only by quoting the current user message', async () => {
  const provider = await openaiServer([
    { tools: [{ id: 'create-draft', name: 'propose_graph', arguments: JSON.stringify({ requestId: 'draft', proposal: PROPOSAL }) }] },
    { tools: [{ id: 'invent-confirmation', name: 'confirm_draft', arguments: JSON.stringify({ proposalVersion: 1, draftRevision: 1, targetBranch: 'main', instruction: 'Confirm this draft', requestId: 'invented' }) }] },
    { text: 'The draft is ready for your review.' },
    { tools: [{ id: 'user-confirmation', name: 'confirm_draft', arguments: JSON.stringify({ proposalVersion: 1, draftRevision: 1, targetBranch: 'main', instruction: 'Confirm this draft', requestId: 'real-confirmation' }) }] },
    { text: 'The draft was confirmed.' },
  ]);
  cleanup.push(() => provider.close());
  const f = await fixture(provider);
  const project = join(f.root, 'project');
  await writeFile(join(project, 'README.md'), 'fixture\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    execFileSync('git', args, { cwd: project });
  }
  const conversation = identityFromLegacy(await read(await f.daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', text: 'Please prepare a draft.', requestId: 'draft-setup' }),
  })));
  await expect.poll(() => transcript(f.daemon, conversation), { timeout: 30_000 }).toContainEqual({ role: 'assistant', text: 'The draft is ready for your review.' });
  expect(JSON.stringify(provider.requests)).toContain('The confirmation must quote a user message');
  expect(await read(await f.daemon.request(`/api/conversations/${conversation}`))).toMatchObject({ tasks: [] });
  await read(await f.daemon.request(`/api/conversations/${conversation}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Confirm this draft', requestId: 'user-confirms' }) }));
  await expect.poll(() => transcript(f.daemon, conversation), { timeout: 30_000 }).toContainEqual({ role: 'assistant', text: 'The draft was confirmed.' });
  expect(await read(await f.daemon.request(`/api/conversations/${conversation}`))).toMatchObject({ tasks: expect.arrayContaining([expect.objectContaining({ phase: 'running' })]) });
}, 60_000);

test('unpaused pending conversation messages transfer with their source and survive restart', async () => {
  const f = await fixture();
  async function legacy(text: string, requestId: string) {
    return identityFromLegacy(await read(await f.daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', text, requestId }),
    })));
  }
  const selected = await legacy('Selected history', 'pending-selected');
  const source = await legacy('Please examine the previous request.', 'pending-source');
  const preview = await read(await f.daemon.request(`/api/projects/p/thread/preview?conversationId=${encodeURIComponent(selected)}`));
  expect(preview).toMatchObject({ sources: [expect.objectContaining({ conversationId: source, pendingChats: 1, blockedChats: 0 })] });
  await read(await f.daemon.request('/api/projects/p/thread/select', { method: 'POST', body: JSON.stringify({ conversationId: selected, requestId: 'pending-transfer' }) }));
  const db = new DatabaseSync(join(f.root, 'state', 'tasks.sqlite'), { readOnly: true });
  const original = db.prepare("SELECT id,state FROM messages WHERE conversation_id=? AND kind='chat'").get(source);
  const copy = db.prepare("SELECT kind,state,data FROM messages WHERE conversation_id=? AND kind='peer'").get(selected);
  db.close();
  expect(original).toMatchObject({ state: 'cancelled' });
  expect(copy).toMatchObject({ kind: 'peer', state: 'pending' });
  if (typeof copy?.data !== 'string') throw new Error('Missing transferred message provenance');
  expect(JSON.parse(copy.data)).toMatchObject({ sourceConversationId: source, sourceMessageId: original?.id });
  await f.daemon.close();
  const provider = await openaiServer([{ text: 'I will examine the earlier request.' }, { text: 'I will examine the earlier request.' }]);
  cleanup.push(() => provider.close());
  const configPath = join(f.root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: join(f.root, 'project') }], credentials: { local: { secretRef: 'GRAPH_IDENTITY_TEST_KEY' } }, models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
  const restarted = await launchCli(f.root, { configPath, extraArgs: ['--execute'], env: { GRAPH_IDENTITY_TEST_KEY: 'synthetic-identity-key' } });
  cleanup.push(() => restarted.close());
  await expect.poll(() => transcript(restarted, selected), { timeout: 30_000 }).toContainEqual({ role: 'assistant', text: 'I will examine the earlier request.' });
  await expect.poll(() => JSON.stringify(provider.requests).includes('not a new user instruction'), { timeout: 30_000 }).toBe(true);
  expect(JSON.stringify(provider.requests)).toContain('Please examine the previous request.');
  expect((await transcript(restarted, source)).filter(item => item.text === 'Please examine the previous request.')).toHaveLength(1);
  const afterRestart = new DatabaseSync(join(f.root, 'state', 'tasks.sqlite'), { readOnly: true });
  const oldExecutions = afterRestart.prepare('SELECT COUNT(*) AS count FROM operations o JOIN conversations c ON c.anchor_task_id=o.task_id WHERE c.id=?').get(source);
  const oldMasters = afterRestart.prepare('SELECT COUNT(*) AS count FROM nodes n JOIN conversations c ON c.anchor_task_id=n.task_id WHERE c.id=?').get(source);
  afterRestart.close();
  expect(oldExecutions).toMatchObject({ count: 0 });
  expect(oldMasters).toMatchObject({ count: 0 });
}, 60_000);

test('a running legacy supervisor must finish before its conversation becomes history', async () => {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  cleanup.push(async () => { release(); });
  const provider = await openaiServer([
    { text: 'Selected ready.' },
    { beforeReply: async () => { entered(); await held; }, text: 'Earlier supervisor finished.' },
  ]);
  cleanup.push(() => provider.close());
  const f = await fixture(provider);
  async function legacy(text: string, requestId: string) {
    return identityFromLegacy(await read(await f.daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', text, requestId }) })));
  }
  const selected = await legacy('Selected', 'active-selected');
  await expect.poll(() => transcript(f.daemon, selected), { timeout: 30_000 }).toContainEqual({ role: 'assistant', text: 'Selected ready.' });
  const source = await legacy('Do earlier work', 'active-source');
  await started;
  const preview = await read(await f.daemon.request(`/api/projects/p/thread/preview?conversationId=${encodeURIComponent(selected)}`));
  expect(preview).toMatchObject({ sources: [expect.objectContaining({ conversationId: source, activeTurns: 1 })] });
  const blocked = await f.daemon.request('/api/projects/p/thread/select', { method: 'POST', body: JSON.stringify({ conversationId: selected, requestId: 'active-attempt' }) });
  expect(blocked.status).not.toBe(200);
  expect(await read(await f.daemon.request(`/api/conversations/${source}`))).toMatchObject({ role: 'legacy' });
  release();
  await expect.poll(() => transcript(f.daemon, source), { timeout: 30_000 }).toContainEqual({ role: 'assistant', text: 'Earlier supervisor finished.' });
  await read(await f.daemon.request('/api/projects/p/thread/select', { method: 'POST', body: JSON.stringify({ conversationId: selected, requestId: 'active-after-settle' }) }));
  expect(await read(await f.daemon.request(`/api/conversations/${source}`))).toMatchObject({ role: 'history' });
}, 60_000);

test('graph creation racing supervisor selection cannot leave a graph under history', async () => {
  const f = await fixture();
  async function legacy(text: string, requestId: string) {
    return identityFromLegacy(await read(await f.daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', text, requestId }) })));
  }
  const selected = await legacy('Selected', 'graph-race-selected');
  const source = await legacy('Source', 'graph-race-source');
  const [selection, creation] = await Promise.all([
    f.daemon.request('/api/projects/p/thread/select', { method: 'POST', body: JSON.stringify({ conversationId: selected, requestId: 'graph-race-transfer' }) }),
    f.daemon.request('/api/graphs', { method: 'POST', body: JSON.stringify({ conversationId: source, definition: DEFINITION, requestId: 'graph-race-create' }) }),
  ]);
  const chosen = identity(await read(selection));
  if (creation.status === 200) {
    const receipt: unknown = await creation.json();
    if (typeof receipt !== 'object' || receipt === null || !('graphId' in receipt) || typeof receipt.graphId !== 'string') throw new Error('Missing graph id');
    const db = new DatabaseSync(join(f.root, 'state', 'tasks.sqlite'), { readOnly: true });
    expect(db.prepare('SELECT owner_task_id FROM kernel_graph_owners WHERE task_id=?').get(receipt.graphId)).toMatchObject({ owner_task_id: chosen.taskId });
    db.close();
  }
  expect(await read(await f.daemon.request(`/api/conversations/${source}`))).toMatchObject({ role: 'history' });
  const late = await f.daemon.request('/api/graphs', { method: 'POST', body: JSON.stringify({ conversationId: source, definition: DEFINITION, requestId: 'graph-after-transfer' }) });
  expect(late.status).not.toBe(200);
}, 60_000);

test('messages racing supervisor selection are either transferred or refused', async () => {
  const f = await fixture();
  async function legacy(text: string, requestId: string) {
    return identityFromLegacy(await read(await f.daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', text, requestId }) })));
  }
  const selected = await legacy('Selected', 'race-selected');
  const source = await legacy('Source', 'race-source');
  const messages = Array.from({ length: 20 }, (_, index) => ({ text: `Racing message ${index}`, requestId: `race-message-${index}` }));
  const results = await Promise.all([
    f.daemon.request('/api/projects/p/thread/select', { method: 'POST', body: JSON.stringify({ conversationId: selected, requestId: 'race-transfer' }) }),
    ...messages.map(item => f.daemon.request(`/api/conversations/${source}/messages`, { method: 'POST', body: JSON.stringify(item) })),
  ]);
  expect(results[0]?.status).toBe(200);
  const selectedHistory = await transcript(f.daemon, selected);
  for (const [index, message] of messages.entries()) {
    const copies = selectedHistory.filter(item => item.text.endsWith(message.text));
    if (results[index + 1]?.status === 200) expect(copies).toHaveLength(1);
    else expect(copies).toHaveLength(0);
  }
  const late = await f.daemon.request(`/api/conversations/${source}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Too late', requestId: 'after-transfer' }) });
  expect(late.status).not.toBe(200);
}, 60_000);

test('a paused legacy conversation with a queued message blocks migration', async () => {
  const f = await fixture();
  async function legacy(text: string, requestId: string) {
    return identityFromLegacy(await read(await f.daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', text, requestId }) })));
  }
  const selected = await legacy('Selected', 'paused-selected');
  const source = await legacy('Keep this paused.', 'paused-source');
  await read(await f.daemon.request(`/api/conversations/${source}/pause`, { method: 'POST', body: JSON.stringify({ requestId: 'pause-pending' }) }));
  const preview = await read(await f.daemon.request(`/api/projects/p/thread/preview?conversationId=${encodeURIComponent(selected)}`));
  expect(preview).toMatchObject({ sources: [expect.objectContaining({ conversationId: source, pendingChats: 1, blockedChats: 1 })] });
  const result = await f.daemon.request('/api/projects/p/thread/select', { method: 'POST', body: JSON.stringify({ conversationId: selected, requestId: 'paused-transfer' }) });
  expect(result.status).not.toBe(200);
  expect(await read(await f.daemon.request(`/api/conversations/${source}`))).toMatchObject({ role: 'legacy', paused: true });
}, 60_000);

test('a transferred notification lets the new supervisor inspect a stopped graph', async () => {
  let graphID = '';
  const provider = await openaiServer([
    { text: 'First settled.' }, { text: 'Second settled.' },
    { tools: [{ id: 'inspect-stopped', name: 'graph_inspect', arguments: () => JSON.stringify({ graphId: graphID, query: 'summary' }) }] },
    { text: 'I reviewed the stopped graph.' },
  ]);
  cleanup.push(() => provider.close());
  const f = await fixture(provider);
  async function legacy(text: string, requestId: string, reply: string) {
    const id = identityFromLegacy(await read(await f.daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', text, requestId }),
    })));
    await expect.poll(() => transcript(f.daemon, id), { timeout: 30_000 }).toContainEqual({ role: 'assistant', text: reply });
    return id;
  }
  const selected = await legacy('First history', 'stopped-first', 'First settled.');
  const source = await legacy('Second history', 'stopped-second', 'Second settled.');
  const created = await read(await f.daemon.request('/api/graphs', { method: 'POST', body: JSON.stringify({ conversationId: source, definition: DEFINITION, requestId: 'stopped-graph' }) }));
  if (typeof created !== 'object' || created === null || !('graphId' in created) || typeof created.graphId !== 'string') throw new Error('Missing graph id');
  graphID = created.graphId;
  await read(await f.daemon.request(`/api/conversations/${source}/pause`, { method: 'POST', body: JSON.stringify({ requestId: 'stopped-pause-source' }) }));
  await read(await f.daemon.request(`/api/tasks/${graphID}/graph/control`, { method: 'POST', body: JSON.stringify({ action: 'stop' }) }));
  await expect.poll(() => {
    const db = new DatabaseSync(join(f.root, 'state', 'tasks.sqlite'), { readOnly: true });
    try { return db.prepare("SELECT COUNT(*) AS count FROM wake_intents WHERE kind='task_stopped' AND state='ready' AND json_extract(data,'$.graphId')=?").get(graphID); }
    finally { db.close(); }
  }, { timeout: 20_000 }).toMatchObject({ count: 1 });
  const chosen = identity(await read(await f.daemon.request('/api/projects/p/thread/select', { method: 'POST', body: JSON.stringify({ conversationId: selected, requestId: 'stopped-transfer' }) })));
  await expect.poll(() => transcript(f.daemon, selected), { timeout: 20_000 }).toContainEqual({ role: 'assistant', text: 'I reviewed the stopped graph.' });
  const results = provider.requests.flatMap(request => {
    if (typeof request !== 'object' || request === null || !('messages' in request) || !Array.isArray(request.messages)) return [];
    return request.messages.filter(item => typeof item === 'object' && item !== null && 'tool_call_id' in item && item.tool_call_id === 'inspect-stopped');
  });
  expect(results).toHaveLength(1);
  expect(JSON.stringify(results[0])).toContain('stopped');
  expect(JSON.stringify(results[0])).not.toContain('Graph belongs to another conversation');
  const db = new DatabaseSync(join(f.root, 'state', 'tasks.sqlite'), { readOnly: true });
  expect(db.prepare('SELECT owner_task_id FROM kernel_graph_owners WHERE task_id=?').get(graphID)).toMatchObject({ owner_task_id: chosen.taskId });
  db.close();
  expect(await read(await f.daemon.request(`/api/conversations/${source}`))).toMatchObject({ role: 'history', tasks: expect.arrayContaining([expect.objectContaining({ id: graphID })]) });
}, 60_000);

test('selecting a supervisor transfers an undelivered node message exactly once', async () => {
  const provider = await openaiServer([
    { text: 'First settled.' }, { text: 'Second settled.' },
    { tools: [{ id: 'peer', name: 'send_to_peer', arguments: JSON.stringify({ to: 'main', text: 'Please inspect this result.', requestId: 'peer-before-transfer' }) }] },
    { text: 'Node finished.' }, { text: 'I will inspect the result.' },
  ]);
  cleanup.push(() => provider.close());
  const f = await fixture(provider);
  async function legacy(text: string, requestId: string) {
    return identityFromLegacy(await read(await f.daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', text, requestId }),
    })));
  }
  const selected = await legacy('First history', 'peer-first');
  await expect.poll(() => transcript(f.daemon, selected), { timeout: 30_000 }).toContainEqual({ role: 'assistant', text: 'First settled.' });
  const source = await legacy('Second history', 'peer-second');
  await expect.poll(() => transcript(f.daemon, source), { timeout: 30_000 }).toContainEqual({ role: 'assistant', text: 'Second settled.' });
  const created = await read(await f.daemon.request('/api/graphs', { method: 'POST', body: JSON.stringify({ conversationId: source, definition: DEFINITION, requestId: 'peer-graph' }) }));
  if (typeof created !== 'object' || created === null || !('graphId' in created) || typeof created.graphId !== 'string') throw new Error('Missing graph id');
  const graphID = created.graphId;
  await read(await f.daemon.request(`/api/conversations/${source}/pause`, { method: 'POST', body: JSON.stringify({ requestId: 'peer-pause-source' }) }));
  await read(await f.daemon.request(`/api/tasks/${graphID}/nodes/a/messages`, { method: 'POST', body: JSON.stringify({ text: 'Send your result to the supervisor.', requestId: 'peer-start-node' }) }));
  await expect.poll(() => {
    const db = new DatabaseSync(join(f.root, 'state', 'tasks.sqlite'), { readOnly: true });
    try { return db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id=? AND kind='peer' AND state='pending'").get(source); }
    finally { db.close(); }
  }, { timeout: 20_000 }).toMatchObject({ count: 1 });
  await read(await f.daemon.request('/api/projects/p/thread/select', { method: 'POST', body: JSON.stringify({ conversationId: selected, requestId: 'peer-transfer' }) }));
  await expect.poll(() => transcript(f.daemon, selected), { timeout: 20_000 }).toContainEqual({ role: 'assistant', text: 'I will inspect the result.' });
  const selectedMessages = await transcript(f.daemon, selected);
  expect(selectedMessages.filter(item => item.text.includes('Please inspect this result.'))).toHaveLength(1);
  expect((await transcript(f.daemon, source)).filter(item => item.text.includes('Please inspect this result.'))).toHaveLength(1);
  await f.daemon.close();
  const restarted = await f.start();
  expect((await transcript(restarted, selected)).filter(item => item.text.includes('Please inspect this result.'))).toHaveLength(1);
}, 60_000);

test('selecting a project supervisor transfers an unfinished graph and its pending notification', async () => {
  let questionID = '';
  let releaseQuestion: () => void = () => {};
  const questionReady = new Promise<void>(resolve => { releaseQuestion = resolve; });
  cleanup.push(async () => { releaseQuestion(); });
  const provider = await openaiServer([
    { text: 'First settled.' }, { text: 'Second settled.' }, { status: 401, error: 'Fixture denied the node call' }, { text: 'Transferred notification handled.' },
    { tools: [{ id: 'node-ask', name: 'ask_supervisor', arguments: JSON.stringify({ prompt: 'Which source should I use?', why: 'The source is ambiguous.', requestId: 'transferred-question' }) }] },
    { beforeReply: () => questionReady, tools: [{ id: 'answer-node', name: 'resolve_problem', arguments: () => JSON.stringify({ questionId: questionID, expectedRevision: 1, action: 'respond', response: 'Use the verified source.', requestId: 'answer-transferred-question' }) }] },
    { text: 'The verified source was used.' }, { text: 'The verified source was used.' },
  ]);
  cleanup.push(() => provider.close());
  const f = await fixture(provider);
  async function createLegacy(text: string, requestId: string) {
    return identityFromLegacy(await read(await f.daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', text, requestId }),
    })));
  }
  const selected = await createLegacy('First history', 'first');
  await expect.poll(() => transcript(f.daemon, selected), { timeout: 30_000 }).toContainEqual({ role: 'assistant', text: 'First settled.' });
  const source = await createLegacy('Second history', 'second');
  await expect.poll(() => transcript(f.daemon, source), { timeout: 30_000 }).toContainEqual({ role: 'assistant', text: 'Second settled.' });
  const definition = { ...DEFINITION, nodes: { ...DEFINITION.nodes, a: { ...DEFINITION.nodes.a, retry: { automatic: 0, resubmit: 0 } } } };
  const created = await read(await f.daemon.request('/api/graphs', { method: 'POST', body: JSON.stringify({ conversationId: source, definition, requestId: 'old-graph' }) }));
  if (typeof created !== 'object' || created === null || !('graphId' in created) || typeof created.graphId !== 'string') throw new Error('Missing graph id');
  const graphID = created.graphId;
  await read(await f.daemon.request(`/api/conversations/${source}/pause`, { method: 'POST', body: JSON.stringify({ requestId: 'pause-source' }) }));
  await read(await f.daemon.request(`/api/tasks/${graphID}/nodes/a/messages`, { method: 'POST', body: JSON.stringify({ text: 'Start work.', requestId: 'start-node' }) }));
  await expect.poll(() => {
    const state = new DatabaseSync(join(f.root, 'state', 'tasks.sqlite'), { readOnly: true });
    try { return state.prepare("SELECT COUNT(*) AS count FROM wake_intents WHERE kind='node_blocked' AND state='ready' AND json_extract(data,'$.graphId')=?").get(graphID); }
    finally { state.close(); }
  }, { timeout: 20_000 }).toMatchObject({ count: 1 }).catch(async () => { throw new Error(`graph=${JSON.stringify(await read(await f.daemon.request(`/api/tasks/${graphID}`)))}; events=${JSON.stringify(await read(await f.daemon.request(`/api/tasks/${graphID}/events?after=0&limit=500`)))}`); });
  await expect.poll(() => {
    const state = new DatabaseSync(join(f.root, 'state', 'tasks.sqlite'), { readOnly: true });
    try { return state.prepare("SELECT COUNT(*) AS count FROM kernel_provider_calls WHERE task_id=? AND node_id='a' AND state='unknown'").get(graphID); }
    finally { state.close(); }
  }, { timeout: 20_000 }).toMatchObject({ count: 1 });
  const preview = await read(await f.daemon.request(`/api/projects/p/thread/preview?conversationId=${encodeURIComponent(selected)}`));
  expect(preview).toMatchObject({ projectId: 'p', selectedConversationId: selected, sources: [expect.objectContaining({ conversationId: source, activeGraphs: 1, pendingWakes: 1 })] });
  const beforeSelection = new DatabaseSync(join(f.root, 'state', 'tasks.sqlite'), { readOnly: true });
  expect(beforeSelection.prepare('SELECT role FROM conversations WHERE id=?').get(selected)).toMatchObject({ role: 'legacy' });
  expect(beforeSelection.prepare('SELECT role FROM conversations WHERE id=?').get(source)).toMatchObject({ role: 'legacy' });
  beforeSelection.close();
  const chosen = identity(await read(await f.daemon.request('/api/projects/p/thread/select', { method: 'POST', body: JSON.stringify({ conversationId: selected, requestId: 'transfer' }) })));
  const oldReplay = await f.daemon.request('/api/graphs', { method: 'POST', body: JSON.stringify({ conversationId: source, definition, requestId: 'old-graph' }) });
  expect(oldReplay.status).not.toBe(200);
  const db = new DatabaseSync(join(f.root, 'state', 'tasks.sqlite'), { readOnly: true });
  const graph = db.prepare('SELECT t.conversation_id,g.owner_task_id FROM tasks t JOIN kernel_graph_owners g ON g.task_id=t.id WHERE t.id=?').get(graphID);
  db.close();
  expect(graph).toMatchObject({ conversation_id: source, owner_task_id: chosen.taskId });
  const view = await read(await f.daemon.request(`/api/conversations/${selected}`));
  expect(view).toMatchObject({ tasks: expect.arrayContaining([expect.objectContaining({ id: graphID })]) });
  const historyView = await read(await f.daemon.request(`/api/conversations/${source}`));
  expect(historyView).toMatchObject({ role: 'history', tasks: expect.arrayContaining([expect.objectContaining({ id: graphID })]) });
  const historyEvents = await read(await f.daemon.request(`/api/conversations/${source}/events?after=0&limit=500`));
  expect(JSON.stringify(historyEvents)).toContain('graph.supervisor_transferred');
  await expect.poll(() => JSON.stringify(provider.requests), { timeout: 20_000 }).toContain(graphID);
  await expect.poll(() => transcript(f.daemon, selected), { timeout: 20_000 }).toContainEqual({ role: 'assistant', text: 'Transferred notification handled.' });
  expect(await transcript(f.daemon, source)).toContainEqual({ role: 'user', text: 'Second history' });
  await f.daemon.close();
  const activeDaemon = await f.start();
  const inspection = new DatabaseSync(join(f.root, 'state', 'tasks.sqlite'), { readOnly: true });
  const pendingCalls = inspection.prepare("SELECT id FROM kernel_provider_calls WHERE task_id=? AND node_id='a' AND state='unknown'").all(graphID);
  const queued = inspection.prepare("SELECT seq FROM kernel_queue WHERE task_id=? AND node_id='a' AND state='failed'").get(graphID);
  inspection.close();
  for (const call of pendingCalls) {
    if (typeof call.id !== 'string') throw new Error('Missing provider call id');
    await read(await activeDaemon.request(`/api/tasks/${graphID}/graph/control`, { method: 'POST', body: JSON.stringify({ action: 'reconcile_usage', callId: call.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) }));
  }
  if (!queued || typeof queued.seq !== 'number') throw new Error('Missing failed input');
  await read(await activeDaemon.request(`/api/tasks/${graphID}/graph/control`, { method: 'POST', body: JSON.stringify({ action: 'retry', seq: queued.seq }) }));
  await expect.poll(async () => {
    const state = new DatabaseSync(join(f.root, 'state', 'tasks.sqlite'), { readOnly: true });
    try {
      const row = state.prepare("SELECT id FROM questions WHERE task_id=? AND kind='waiting' AND status='open'").get(graphID);
      if (typeof row?.id === 'string') questionID = row.id;
      return Boolean(questionID);
    } finally { state.close(); }
  }, { timeout: 20_000 }).toBe(true);
  releaseQuestion();
  await expect.poll(async () => JSON.stringify(await read(await activeDaemon.request(`/api/tasks/${graphID}/nodes/a/run`))), { timeout: 20_000 }).toContain('The verified source was used.');
  await activeDaemon.close();
  const restarted = await f.start();
  expect(await read(await restarted.request(`/api/conversations/${selected}`))).toMatchObject({ tasks: expect.arrayContaining([expect.objectContaining({ id: graphID })]) });
  expect(await read(await restarted.request(`/api/conversations/${source}`))).toMatchObject({ role: 'history', tasks: expect.arrayContaining([expect.objectContaining({ id: graphID })]) });
}, 60_000);
