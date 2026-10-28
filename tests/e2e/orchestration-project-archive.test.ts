import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { PROPOSAL, run } from './go-graph-confirmation.fixture.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown, key: string): string {
  const item = record(value)[key];
  if (typeof item !== 'string' || !item) throw new Error(`Expected ${key}: ${JSON.stringify(value)}`);
  return item;
}

test('archiving pauses project work, blocks new work, and restore preserves pauses across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-project-archive-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'));
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: join(root, 'project') }] }));
  const start = async () => {
    const daemon = await launchCli(root, { configPath });
    cleanup.push(() => daemon.close());
    return daemon;
  };
  let daemon = await start();
  async function request(path: string, body?: object) {
    const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    const data: unknown = await response.json();
    return { status: response.status, data };
  }
  async function ok(path: string, body?: object) {
    const result = await request(path, body);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    return record(result.data);
  }
  const global = text(await ok('/api/orchestration/global', { requestId: 'global' }), 'conversationId');
  const project = text(await ok('/api/projects/p/thread', { requestId: 'project' }), 'conversationId');
  const source = text(await ok(`/api/conversations/${global}/messages`, { requestId: 'message', text: 'Build a feature' }), 'messageId');
  const input = { conversationId: global, projectId: 'p', sourceMessageId: source, brief: 'Build a feature', acceptance: ['Feature works'] };
  const work = text(await ok('/api/orchestration/work', { ...input, requestId: 'work' }), 'id');
  await ok(`/api/orchestration/work/${work}/drafts`, { requestId: 'draft', workRevision: 1, proposal: PROPOSAL });
  const graph = text(await ok(`/api/orchestration/work/${work}/confirm`, { workRevision: 1, version: 1, draftRevision: 1, graphKey: 'main', requestId: 'confirm' }), 'graphId');
  const manuallyPaused = text(await ok(`/api/orchestration/work/${work}/confirm`, { workRevision: 1, version: 1, draftRevision: 1, graphKey: 'manual', requestId: 'confirm-manual' }), 'graphId');
  const pausedAfterArchive = text(await ok(`/api/orchestration/work/${work}/confirm`, { workRevision: 1, version: 1, draftRevision: 1, graphKey: 'later', requestId: 'confirm-later' }), 'graphId');
  await ok(`/api/tasks/${manuallyPaused}/graph/control`, { action: 'pause' });
  await ok(`/api/tasks/${graph}/graph/control`, { action: 'pause', nodeId: 'a' });
  expect(await ok('/api/projects/p/archive', { requestId: 'archive' })).toMatchObject({ projectId: 'p', archived: true });
  await ok(`/api/tasks/${pausedAfterArchive}/graph/control`, { action: 'pause' });
  expect((await request(`/api/tasks/${graph}/graph/control`, { action: 'resume' })).status).not.toBe(200);
  expect((await request(`/api/tasks/${graph}/graph/control`, { action: 'resume', nodeId: 'a' })).status).not.toBe(200);
  expect(await ok(`/api/orchestration/work/${work}`)).toMatchObject({ executionPaused: true });
  expect(await ok(`/api/tasks/${graph}`)).toMatchObject({ paused: true });
  expect((await request('/api/orchestration/work', { ...input, requestId: 'blocked-work' })).status).not.toBe(200);
  await ok(`/api/conversations/${project}/messages`, { requestId: 'control-message', text: 'Explain the project status' });
  expect(await ok('/api/projects/p/restore', { requestId: 'restore' })).toMatchObject({ archived: false });
  expect(await ok(`/api/orchestration/work/${work}`)).toMatchObject({ executionPaused: true });
  await daemon.close();
  daemon = await start();
  expect(await ok('/api/projects/p/lifecycle')).toMatchObject({ archived: false });
  expect(await ok(`/api/orchestration/work/${work}`)).toMatchObject({ executionPaused: true });
  expect(await ok(`/api/tasks/${graph}`)).toMatchObject({ paused: true });
  expect(await ok(`/api/orchestration/work/${work}/resume`, { requestId: 'resume-work' })).toMatchObject({ executionPaused: false });
  expect(await ok(`/api/tasks/${graph}`)).toMatchObject({ paused: false });
  const state = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
  const node = state.prepare('SELECT paused FROM kernel_node_state WHERE task_id=? AND node_id=?').get(graph, 'a');
  state.close();
  expect(node).toMatchObject({ paused: 1 });
  expect(await ok(`/api/tasks/${manuallyPaused}`)).toMatchObject({ paused: true });
  expect(await ok(`/api/tasks/${pausedAfterArchive}`)).toMatchObject({ paused: true });
  expect(await ok(`/api/orchestration/work/${work}/resume`, { requestId: 'resume-work' })).toMatchObject({ executionPaused: false });
}, 60_000);

test.each(['before', 'after'])('archive during Git preparation resumes when work is resumed %s preparation finishes', async (resumeWhen) => {
  const root = await mkdtemp(join(tmpdir(), 'graph-archive-preparing-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
  await writeFile(join(project, 'README.md'), 'initial\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    await run('git', args, { cwd: project });
  }
  const entered = join(root, 'entered');
  const release = join(root, 'release');
  const bin = join(root, 'bin');
  await mkdir(bin);
  const wrapper = join(bin, 'git');
  await writeFile(wrapper, '#!/bin/sh\ncase " $* " in *" worktree add "*) touch "$GRAPH_TEST_ENTERED"; while [ ! -f "$GRAPH_TEST_RELEASE" ]; do sleep 0.1; done;; esac\nexec "$GRAPH_TEST_GIT" "$@"\n');
  await chmod(wrapper, 0o755);
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }] }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_TEST_ENTERED: entered, GRAPH_TEST_RELEASE: release, GRAPH_TEST_GIT: execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), PATH: `${bin}:${process.env.PATH ?? ''}` } });
  cleanup.push(async () => { await writeFile(release, ''); await daemon.close(); });
  async function ok(path: string, body?: object) {
    const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    const value: unknown = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(200);
    return record(value);
  }
  const global = text(await ok('/api/orchestration/global', { requestId: 'global' }), 'conversationId');
  await ok('/api/projects/p/thread', { requestId: 'project' });
  const source = text(await ok(`/api/conversations/${global}/messages`, { requestId: 'message', text: 'Build a feature' }), 'messageId');
  const work = text(await ok('/api/orchestration/work', { requestId: 'work', conversationId: global, projectId: 'p', sourceMessageId: source, brief: 'Build a feature', acceptance: ['Feature works'] }), 'id');
  await ok(`/api/orchestration/work/${work}/drafts`, { requestId: 'draft', workRevision: 1, proposal: PROPOSAL });
  const confirming = ok(`/api/orchestration/work/${work}/confirm`, { workRevision: 1, version: 1, draftRevision: 1, graphKey: 'main', requestId: 'confirm', targetBranch: 'main' });
  await expect.poll(async () => access(entered).then(() => true, () => false), { timeout: 20_000 }).toBe(true);
  await ok('/api/projects/p/archive', { requestId: 'archive' });
  await ok('/api/projects/p/restore', { requestId: 'restore' });
  if (resumeWhen === 'before') await ok(`/api/orchestration/work/${work}/resume`, { requestId: 'resume' });
  await writeFile(release, '');
  const graph = text(await confirming, 'graphId');
  if (resumeWhen === 'after') {
    expect(await ok(`/api/tasks/${graph}`)).toMatchObject({ paused: true });
    await ok(`/api/orchestration/work/${work}/resume`, { requestId: 'resume' });
  }
  expect(await ok(`/api/tasks/${graph}`)).toMatchObject({ paused: false });
}, 60_000);

test('interrupted work graph preparation waits for inspection before retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-work-preparation-crash-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
  await writeFile(join(project, 'README.md'), 'initial\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) await run('git', args, { cwd: project });
  const entered = join(root, 'entered'), release = join(root, 'release'), calls = join(root, 'calls'), pid = join(root, 'pid');
  const wrapper = join(root, 'bin', 'git');
  await writeFile(wrapper, '#!/bin/sh\ncase " $* " in *" worktree add "*) echo add >> "$GRAPH_TEST_CALLS"; echo $$ > "$GRAPH_TEST_PID"; touch "$GRAPH_TEST_ENTERED"; while [ ! -f "$GRAPH_TEST_RELEASE" ]; do sleep 0.1; done;; esac\nexec "$GRAPH_TEST_GIT" "$@"\n');
  await chmod(wrapper, 0o755);
  const configPath = join(root, 'graph.config.json');
  const provider = await openaiServer([]);
  cleanup.push(() => provider.close());
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }], credentials: { local: { secretRef: 'GRAPH_CRASH_KEY' } }, models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
  const env = { GRAPH_CRASH_KEY: 'synthetic', GRAPH_TEST_ENTERED: entered, GRAPH_TEST_RELEASE: release, GRAPH_TEST_CALLS: calls, GRAPH_TEST_PID: pid, GRAPH_TEST_GIT: execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}` };
  let daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env });
  cleanup.push(async () => { await writeFile(release, ''); await daemon.close(); });
  async function ok(path: string, body?: object) {
    const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    const value: unknown = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(200);
    return record(value);
  }
  const global = text(await ok('/api/orchestration/global', { requestId: 'global' }), 'conversationId');
  await ok('/api/projects/p/thread', { requestId: 'project' });
  const source = text(await ok(`/api/conversations/${global}/messages`, { requestId: 'message', text: 'Build a feature' }), 'messageId');
  const work = text(await ok('/api/orchestration/work', { requestId: 'work', conversationId: global, projectId: 'p', sourceMessageId: source, brief: 'Build a feature', acceptance: ['Feature works'] }), 'id');
  await ok(`/api/orchestration/work/${work}/drafts`, { requestId: 'draft', workRevision: 1, proposal: PROPOSAL });
  const confirmation = daemon.request(`/api/orchestration/work/${work}/confirm`, { method: 'POST', body: JSON.stringify({ workRevision: 1, version: 1, draftRevision: 1, graphKey: 'main', requestId: 'confirm', targetBranch: 'main' }) }).then(() => 'returned', () => 'interrupted');
  await expect.poll(async () => access(entered).then(() => true, () => false), { timeout: 20_000 }).toBe(true);
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
  const graph = text(db.prepare('SELECT graph_id FROM kernel_create_requests').get(), 'graph_id');
  db.close();
  const gitPid = Number((await readFile(pid, 'utf8')).trim());
  const exited = once(daemon.child, 'exit');
  daemon.child.kill('SIGKILL');
  await exited;
  process.kill(gitPid, 'SIGTERM');
  expect(await confirmation).toBe('interrupted');
  daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env });
  await expect.poll(async () => JSON.stringify(await ok(`/api/orchestration/work/${work}/graphs`)), { timeout: 20_000 }).toContain('blocked');
  expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(['add']);
  const refused = await daemon.request(`/api/tasks/${graph}/graph/control`, { method: 'POST', body: JSON.stringify({ action: 'retry_preparation' }) });
  expect(refused.status).not.toBe(200);
  await writeFile(release, '');
  await ok(`/api/tasks/${graph}/graph/control`, { action: 'retry_preparation', proof: 'The Git process was stopped and no worktree was created.' });
  expect(JSON.stringify(await ok(`/api/orchestration/work/${work}/graphs`))).toContain('ready');
  expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(['add', 'add']);
}, 60_000);
