import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';
import { nativeGitAcceptance, git, commit } from '../fixtures/native-git-acceptance.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const tool = (name: string, value: unknown): ResponsePlan => ({ tools: [{ id: name, name, arguments: JSON.stringify(value) }] });
const submit = (value: unknown = {}) => tool('submit', { outputs: { result: { enable: true, value } } });
const write = () => tool('write_file', { path: 'feature.txt', content: 'done' });
const save = () => tool('workspace_commit', { paths: ['feature.txt'], message: 'Implement the feature once' });
const tree = (disk: TaskStore, graphId: string) => (disk.db.prepare('SELECT path FROM worktrees WHERE task_id=? AND node_id=?').get(graphId, 'work') as { path: string }).path;

test('duplicate native submissions and completion commands cannot change the accepted result or deliver twice', async () => {
  const f = await nativeGitAcceptance(cleanup, { workPlans: [write(), submit(), submit(), submit({ different: true }), { text: 'Submitted the result once' }] });
  const execution = f.runtime.nodeRun(f.graphId, 'work').operations[0]!;
  expect(execution.state).toBe('completed'); expect(f.work.requests).toHaveLength(5);
  expect(JSON.stringify(f.work.requests[4])).toContain('already_submitted');
  expect(f.disk.db.prepare('SELECT COUNT(*) AS n FROM kernel_submissions WHERE task_id=?').get(f.graphId)).toEqual({ n: 1 });
  await f.check(); await f.review(); const verified = f.disk.task(f.graphId).integration_sha!;
  const first = await f.complete(); const again = await f.complete();
  expect(first.phase).toBe('completed'); expect(again.phase).toBe('completed');
  expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(verified);
  expect(git(f.root, ['rev-list', '--count', 'main'])).toBe(git(f.root, ['rev-list', '--count', verified]));
  expect(await readFile(join(f.root, 'feature.txt'), 'utf8')).toBe('done');
  await f.restart(); expect((await f.runtime.user.task(f.graphId).view()).phase).toBe('completed');
  expect(f.work.requests).toHaveLength(5); expect(f.reviewer.requests).toHaveLength(3);
  expect(f.disk.db.prepare('SELECT COUNT(*) AS n FROM kernel_completion_delivery WHERE task_id=?').get(f.graphId)).toEqual({ n: 1 });
}, 60000);

test('unknown usage after an actual Git commit survives restart and cannot replay the write or commit', async () => {
  const f = await nativeGitAcceptance(cleanup, { workPlans: [write(), save(), { text: 'Unmetered response after commit', usage: null }, submit(), { text: 'Recovered after reconciliation' }] });
  const before = f.runtime.nodeRun(f.graphId, 'work'); const path = tree(f.disk, f.graphId); const saved = git(path, ['rev-parse', 'HEAD']);
  expect(before.node.status).toBe('blocked'); expect(before.instance!.used).toBe(100); expect(before.operations[0]!.reserved).toBeGreaterThan(0);
  expect(git(path, ['show', `${saved}:feature.txt`])).toBe('done'); expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(f.baseline);
  const calls = await f.main.graphInspect({ graphId: f.graphId, query: 'provider_calls', id: 'work' }) as { id: string; state: string }[];
  expect(calls.map(call => call.state)).toEqual(['settled', 'settled', 'unknown']);
  await f.restart(); expect(f.work.requests).toHaveLength(3); expect(git(path, ['rev-parse', 'HEAD'])).toBe(saved);
  await f.main.graphControl({ graphId: f.graphId, action: 'reconcile_usage', callId: calls[2]!.id, usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } });
  await f.main.graphControl({ graphId: f.graphId, nodeId: 'work', action: 'resume' }); await f.runtime.host.drive();
  const after = f.runtime.nodeRun(f.graphId, 'work'); expect(after.instance).toMatchObject({ id: before.instance!.id, used: 250 });
  expect(after.session!.sessionId).toBe(before.session!.sessionId); expect(after.operations[0]!.id).toBe(before.operations[0]!.id);
  expect(git(path, ['rev-parse', 'HEAD'])).toBe(saved); expect(f.work.requests).toHaveLength(5);
  await f.check(); await f.review(); expect((await f.complete()).phase).toBe('completed');
  expect(await readFile(join(f.root, 'feature.txt'), 'utf8')).toBe('done');
}, 60000);

test('a hard-killed native worker retains its committed copy and unknown call; target advancement needs fresh check and review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-git-crash-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'README.md'), 'project\n'); await writeFile(join(project, 'check.cjs'), "if(require('fs').readFileSync('feature.txt','utf8')!=='done')process.exit(1)");
  git(project, ['init', '-q', '-b', 'main']); git(project, ['add', '.']); commit(project, 'baseline'); const baseline = git(project, ['rev-parse', 'HEAD']);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); cleanup.push(() => release());
  const worker = await openaiServer([write(), save(), { text: 'Late response from killed owner', beforeReply: () => held }, submit(), { text: 'Recovered original work' }]); cleanup.push(() => worker.close());
  let graphId = ''; let disk!: TaskStore;
  const reviewPlans = () => [tool('read_file', { path: 'feature.txt' }), { tools: [{ id: 'review', name: 'artifact_publish', arguments: () => JSON.stringify({ namespace: 'reviews', name: 'review', mediaType: 'application/json', schema: 'graph.review@1',
    content: JSON.stringify({ commit: disk.task(graphId).integration_sha, passed: true, reason: 'Read the implemented feature at this exact commit' }), requestId: `review-${disk.task(graphId).integration_sha}` }) }] }, { text: 'Reviewed the current commit' }];
  const reviewer = await openaiServer([...reviewPlans(), ...reviewPlans()]); cleanup.push(() => reviewer.close());
  const child = fork(fileURLToPath(new URL('../fixtures/m6/crash-git.ts', import.meta.url)), [root, project, worker.model.baseUrl, reviewer.model.baseUrl], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', data => { stderr += data; });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } });
  const state = await new Promise<{ graphId: string; ownerId: string; instanceId: string; sessionId: string; executionId: string; callId: string }>((resolve, reject) => {
    child.once('message', resolve as (value: unknown) => void); child.once('error', reject); child.once('exit', code => reject(new Error(`Child exited ${code}: ${stderr}`)));
  }); graphId = state.graphId;
  await expect.poll(() => worker.requests.length).toBe(3); child.kill('SIGKILL'); await once(child, 'exit'); release();
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], limits: { defaultBudgetTokens: 20000000 },
    catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') }, models: { apiKey: 'local-only', modelRuntime: worker.runtime, entries: ([['work', worker], ['review', reviewer]] as const).map(([id, provider]) => ({
      id, modelId: id === 'work' ? 'implementer' : 'independent', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256,
    })) } }); cleanup.push(() => runtime.close());
  disk = new TaskStore(join(root, 'state', 'tasks.sqlite')); cleanup.push(() => disk.close()); const main = runtime.supervisor(state.ownerId);
  const before = runtime.nodeRun(graphId, 'work'); const path = tree(disk, graphId); const saved = git(path, ['rev-parse', 'HEAD']);
  expect(before.node.status).toBe('blocked'); expect(before.operations[0]).toMatchObject({ id: state.executionId, state: 'blocked', workerActive: false });
  expect(before.timing).toMatchObject({ runMs: null, waitingMs: null });
  expect(before.instance).toMatchObject({ id: state.instanceId, used: 100 }); expect(git(path, ['show', `${saved}:feature.txt`])).toBe('done');
  await runtime.host.drive(); expect(worker.requests).toHaveLength(3); expect(git(project, ['rev-parse', 'HEAD'])).toBe(baseline);
  await expect(main.graphInspect({ graphId, query: 'provider_calls', id: 'work' })).resolves.toMatchObject([{ state: 'settled' }, { state: 'settled' }, { id: state.callId, state: 'unknown' }]);
  await main.graphControl({ graphId, action: 'reconcile_usage', callId: state.callId, usage: { input: 25, output: 10, cacheRead: 15, cacheWrite: 0 } });
  await main.graphControl({ graphId, nodeId: 'work', action: 'resume' }); await runtime.host.drive();
  const after = runtime.nodeRun(graphId, 'work'); expect(after.session!.sessionId).toBe(state.sessionId);
  expect(after.operations[0]).toMatchObject({ id: state.executionId, state: 'completed' }); expect(after.instance!.used).toBe(250);
  // Recovering the remaining work cannot retrospectively measure the killed segment.
  expect(after.timing).toMatchObject({ runMs: null, waitingMs: null });
  expect(git(path, ['rev-parse', 'HEAD'])).toBe(saved); expect(worker.requests).toHaveLength(5);
  const verify = async () => { for (const nodeId of ['check', 'review']) { await main.graphSend({ graphId, nodeId, input: 'job', value: {} }); await runtime.host.drive(); } };
  await verify(); const old = disk.task(graphId).integration_sha!;
  await writeFile(join(project, 'extra.txt'), 'from target'); git(project, ['add', 'extra.txt']); commit(project, 'target moved');
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive(); expect((await runtime.user.task(graphId).view()).phase).toBe('blocked');
  const stale = await main.graphInspect({ graphId, query: 'acceptance' }) as { items: { id: string; status: string }[] };
  expect(stale.items.map(item => item.status)).toEqual(['stale', 'stale']); expect(reviewer.requests).toHaveLength(3);
  await main.graphControl({ graphId, action: 'withdraw_complete' }); await verify(); await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  expect((await runtime.user.task(graphId).view()).phase).toBe('completed'); expect(disk.task(graphId).integration_sha).not.toBe(old);
  expect(disk.db.prepare('SELECT COUNT(*) AS n FROM kernel_module_operations WHERE task_id=?').get(graphId)).toEqual({ n: 2 });
  expect(reviewer.requests).toHaveLength(6); expect(worker.requests).toHaveLength(5);
  expect(await readFile(join(project, 'feature.txt'), 'utf8')).toBe('done'); expect(await readFile(join(project, 'extra.txt'), 'utf8')).toBe('from target');
}, 90000);
