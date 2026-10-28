import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { DEFINITION, run } from './go-graph-confirmation.fixture.ts';

function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}
function field(value: unknown, key: string): string {
  const result = obj(value)[key];
  if (typeof result !== 'string' || !result) throw new Error(`Missing ${key}: ${JSON.stringify(value)}`);
  return result;
}

test.each(['live', 'crash', 'failed', 'live-fail', 'failed-retry-crash'])('a %s graph preparation transfers without a second worktree', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'graph-preparing-migration-'));
  const project = join(root, 'project');
  const release = join(root, 'release');
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const provider = await openaiServer([{ text: 'First settled.' }, { text: 'Second settled.' }, { text: 'Transfer observed.' }, { text: 'Preparation observed.' }]);
  try {
    await mkdir(project); await mkdir(join(root, 'web')); await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(join(project, 'README.md'), '# project\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) await run('git', args, { cwd: project });
    const entered = join(root, 'entered');
    const calls = join(root, 'calls');
    const pidFile = join(root, 'git-pid');
    const wrapper = join(root, 'bin', 'git');
    await writeFile(wrapper, '#!/bin/sh\ncase " $* " in *" worktree add "*) echo add >> "$GRAPH_TEST_CALLS"; echo $$ > "$GRAPH_TEST_PID"; touch "$GRAPH_TEST_ENTERED"; if [ "$GRAPH_TEST_FAIL_ONCE" = 1 ] && [ ! -f "$GRAPH_TEST_FAILED_ONCE" ]; then touch "$GRAPH_TEST_FAILED_ONCE"; exit 1; fi; if [ "$GRAPH_TEST_FAIL" = 1 ] && [ ! -f "$GRAPH_TEST_RELEASE" ]; then exit 1; fi; while [ ! -f "$GRAPH_TEST_RELEASE" ]; do sleep 0.1; done; if [ "$GRAPH_TEST_FAIL_AFTER" = 1 ] && [ ! -f "$GRAPH_TEST_FAILED_ONCE" ]; then touch "$GRAPH_TEST_FAILED_ONCE"; exit 1; fi;; esac\nexec "$GRAPH_TEST_GIT" "$@"\n');
    await chmod(wrapper, 0o755);
    const config = join(root, 'graph.config.json');
    await writeFile(config, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }], credentials: { local: { secretRef: 'GRAPH_MIGRATE_KEY' } }, models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
    const start = () => launchCli(root, { configPath: config, extraArgs: ['--execute'], env: { GRAPH_MIGRATE_KEY: 'synthetic', GRAPH_TEST_ENTERED: entered, GRAPH_TEST_RELEASE: release, GRAPH_TEST_CALLS: calls, GRAPH_TEST_PID: pidFile, GRAPH_TEST_FAIL: mode === 'failed' ? '1' : '0', GRAPH_TEST_FAIL_ONCE: mode === 'failed-retry-crash' ? '1' : '0', GRAPH_TEST_FAIL_AFTER: mode === 'live-fail' ? '1' : '0', GRAPH_TEST_FAILED_ONCE: join(root, 'failed-once'), GRAPH_TEST_GIT: execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}` } });
    daemon = await start();
    async function request(path: string, body?: object) {
      if (!daemon) throw new Error('Daemon unavailable');
      const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
      const value: unknown = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(200);
      return obj(value);
    }
    const first = field(await request('/api/conversations', { projectId: 'p', text: 'First history', requestId: 'first' }), 'conversationId');
    await expect.poll(async () => JSON.stringify(await request(`/api/conversations/${first}`)), { timeout: 20_000 }).toContain('First settled.');
    const second = field(await request('/api/conversations', { projectId: 'p', text: 'Second history', requestId: 'second' }), 'conversationId');
    await expect.poll(async () => JSON.stringify(await request(`/api/conversations/${second}`)), { timeout: 20_000 }).toContain('Second settled.');
    const creation = request('/api/graphs', { conversationId: second, definition: DEFINITION, targetBranch: 'main', requestId: 'old-preparing' }).then(value => ({ value }), error => ({ error }));
    await expect.poll(async () => access(entered).then(() => true, () => false), { timeout: 20_000 }).toBe(true);
    const state = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
    const original = state.prepare("SELECT graph_id,owner_task_id FROM kernel_create_requests WHERE request_id='old-preparing'").get();
    state.close();
    const graph = field(original, 'graph_id');
    const oldOwner = field(original, 'owner_task_id');
    if (mode === 'failed' || mode === 'failed-retry-crash') expect(await creation).toMatchObject({ value: { graphId: graph, state: 'blocked' } });
    if (mode === 'failed' || mode === 'failed-retry-crash') {
      expect(await request('/api/graphs', { conversationId: second, definition: DEFINITION, targetBranch: 'main', requestId: 'old-preparing' })).toMatchObject({ graphId: graph, state: 'blocked' });
      expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(['add']);
    }
    const selected = await request('/api/projects/p/thread/select', { conversationId: first, requestId: 'select' });
    if (mode === 'crash') {
      const gitPid = Number((await readFile(pidFile, 'utf8')).trim());
      const exited = once(daemon.child, 'exit');
      daemon.child.kill('SIGKILL');
      await exited;
      process.kill(gitPid, 'SIGTERM');
      expect(await creation).toHaveProperty('error');
      daemon = await start();
      await new Promise(resolve => setTimeout(resolve, 800));
      expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(['add']);
      const unsafe = await daemon.request(`/api/tasks/${graph}/graph/control`, { method: 'POST', body: JSON.stringify({ action: 'retry_preparation' }) });
      expect(unsafe.status).not.toBe(200);
    }
    if (mode === 'failed-retry-crash') {
      const retry = request(`/api/tasks/${graph}/graph/control`, { action: 'retry_preparation', proof: 'The failed Git process exited without creating a worktree.' }).then(() => 'returned', () => 'interrupted');
      await expect.poll(async () => (await readFile(calls, 'utf8')).trim().split('\n').length, { timeout: 20_000 }).toBe(2);
      const gitPid = Number((await readFile(pidFile, 'utf8')).trim());
      const exited = once(daemon.child, 'exit');
      daemon.child.kill('SIGKILL');
      await exited;
      process.kill(gitPid, 'SIGTERM');
      expect(await retry).toBe('interrupted');
      daemon = await start();
      const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
      const recovery = db.prepare("SELECT COUNT(*) AS count FROM events WHERE task_id=? AND type='graph.preparation.recovery_required'").get(graph);
      db.close();
      expect(recovery).toMatchObject({ count: 1 });
      expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(['add', 'add']);
    }
    await writeFile(release, '');
    if (mode === 'live') expect(await creation).toMatchObject({ value: { graphId: graph } });
    else {
      if (mode === 'live-fail') {
        expect(await creation).toMatchObject({ value: { graphId: graph, state: 'blocked' } });
        await new Promise(resolve => setTimeout(resolve, 500));
        expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(['add']);
      }
      await request(`/api/tasks/${graph}/graph/control`, { action: 'retry_preparation', proof: 'The previous Git process is stopped and no worktree was created.' });
    }
    await expect.poll(() => {
      const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
      try { return db.prepare("SELECT r.state,r.owner_task_id,g.owner_task_id AS current_owner FROM kernel_create_requests r JOIN kernel_graph_owners g ON g.task_id=r.graph_id WHERE r.graph_id=?").get(graph); }
      finally { db.close(); }
    }, { timeout: 20_000 }).toMatchObject({ state: 'ready', owner_task_id: oldOwner, current_owner: field(selected, 'taskId') });
    expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(mode === 'live' ? ['add'] : mode === 'failed-retry-crash' ? ['add', 'add', 'add'] : ['add', 'add']);
    const worktrees = (await run('git', ['worktree', 'list', '--porcelain'], { cwd: project })).stdout;
    expect(worktrees.match(/\/integration\n/g)).toHaveLength(1);
    expect(await request(`/api/conversations/${first}`)).toMatchObject({ tasks: expect.arrayContaining([expect.objectContaining({ id: graph })]) });
  } finally {
    await writeFile(release, '').catch(() => {});
    await daemon?.close(); await provider.close(); await rm(root, { recursive: true, force: true });
  }
}, 60_000);
