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

function identityFromLegacy(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('conversationId' in value) || typeof value.conversationId !== 'string') {
    throw new Error(`Expected existing conversation: ${JSON.stringify(value)}`);
  }
  return value.conversationId;
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

test('a project gets a new supervisor instead of choosing a legacy conversation', async () => {
  const f = await fixture();
  const legacy = async (text: string, requestId: string) => identityFromLegacy(await read(await f.daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', text, requestId }),
  })));
  const first = await legacy('First historical conversation', 'history-first');
  const second = await legacy('Second historical conversation', 'history-second');
  const thread = await open(f.daemon, '/api/projects/p/thread', 'fresh-project-thread');
  expect(thread.role).toBe('project');
  expect(thread.conversationId).not.toBe(first);
  expect(thread.conversationId).not.toBe(second);
  expect((await open(f.daemon, '/api/projects/p/thread', 'same-project-thread')).conversationId).toBe(thread.conversationId);
  const conversations = await read(await f.daemon.request('/api/conversations')) as { id: string; role: string }[];
  expect(conversations.find(row => row.id === first)?.role).toBe('legacy');
  expect(conversations.find(row => row.id === second)?.role).toBe('legacy');
}, 60_000);
