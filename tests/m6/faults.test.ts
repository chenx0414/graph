import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { CallBroker } from '../../src/runtime/call-broker.ts';
import { openRestrictedExecutor } from '../../src/runtime/restricted-process.ts';
import { git as runGit } from '../../src/git/git.ts';
import type { ActionAdapter, Operation , Proposal } from '../../src/core/types.ts';
import { withIndependentReview } from '../fixtures/review-gate.ts';
import { withLiftedDefinition } from '../fixtures/v2-lift.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-m6-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'project\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'init']);
  return root;
}
function sandboxedCheck(root: string): ActionAdapter {
  return {
    kind: 'program',
    prepare: async operation => async () => {
      const workspace = operation.workspace!;
      const broker = new CallBroker(join(root, 'state', 'check-calls.sqlite'), 'check');
      const executor = await openRestrictedExecutor();
      try {
        const result = await executor.run({
          broker, cwd: workspace, scratchDir: workspace, executable: '/bin/cat', args: ['feature.txt'],
          readPaths: [workspace], writePaths: [workspace],
        });
        if (result.code !== 0 || result.stdout.trim() !== 'done') throw new Error(result.stderr || 'Sandbox check failed');
      } finally { await executor.close(); broker.close(); }
      const path = join(workspace, 'feature.txt');
      return { outcome: 'completed', output: { passed: true }, evidence: [{ acceptanceId: 'works', summary: 'Sandbox read feature.txt', artifact: { path, digest: digest('done') } }] };
    },
  };
}

test('duplicate commands and reports do not double-merge or change a settled result', async () => {
  const root = await repo();
  const reviewed = withIndependentReview({
    work: { kind: 'agent' as const, reserveTokens: 100, prepare: async (operation: { workspace?: string }) => async () => {
      await writeFile(join(operation.workspace!, 'feature.txt'), 'done');
      return { outcome: 'completed' as const, output: { file: 'feature.txt' }, usage };
    } },
    check: sandboxedCheck(root),
  }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  const options = {
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    limits: { defaultBudgetTokens: 20_000_000 },
    actions: reviewed.actions,
  };
  const runtime = await openTaskRuntime(options);
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const first = await runtime.user.begin({ projectId: 'project', request: 'Idempotent merge', requestId: 'begin' });
  expect(await runtime.user.begin({ projectId: 'project', request: 'Idempotent merge', requestId: 'begin' })).toEqual(first);
  const proposed = await runtime.supervisor(first.taskId).propose(withLiftedDefinition({
    requirementVersion: 1, summary: 'Idempotent merge',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: reviewed.nodes,
  } as Proposal), 'proposal');
  const task = runtime.user.task(first.taskId);
  const accepted = await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  expect(await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' })).toEqual(accepted);
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  const operation = view.operations.find(item => item.nodeId === 'work')!;
  await runtime.host.report(operation.id, operation.generation, operation.result!);
  await expect(runtime.host.report(operation.id, operation.generation, { ...operation.result!, output: { other: true } })).rejects.toMatchObject({ code: 'result_conflict' });
  expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('done');
  expect(git(root, ['rev-list', '--count', 'main'])).toBe(git(root, ['rev-list', '--count', view.integrationSha!]));
});

test('unknown usage after a git write waits for the user and does not replay the write', async () => {
  const root = await repo();
  let writes = 0;
  const reviewed = withIndependentReview({
    work: { kind: 'agent' as const, reserveTokens: 100, prepare: async (operation: { workspace?: string }) => async () => {
      writes++;
      await writeFile(join(operation.workspace!, 'feature.txt'), 'done');
      return { outcome: 'completed' as const, output: { file: 'feature.txt' } };
    } },
    check: sandboxedCheck(root),
  }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  const options = {
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    limits: { defaultBudgetTokens: 20_000_000 },
    actions: reviewed.actions,
  };
  let runtime = await openTaskRuntime(options);
  cleanup.push(async () => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Unknown usage', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose(withLiftedDefinition({
    requirementVersion: 1, summary: 'Unknown usage',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: reviewed.nodes,
  } as Proposal), 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.runReady();
  const blocked = await runtime.user.task(taskId).view();
  expect(blocked.questions[0]).toMatchObject({ kind: 'unknown_usage', status: 'open' });
  expect(writes).toBe(1);
  await runtime.close();
  runtime = await openTaskRuntime(options);
  const task = runtime.user.task(taskId);
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect(writes).toBe(1);
  await task.answer(blocked.questions[0]!.id, { type: 'usage', usage, proof: 'Provider receipt for the write' }, 'usage');
  await runtime.host.drive();
  expect((await task.view()).phase).toBe('completed');
  expect(writes).toBe(1);
  expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('done');
});

test('a killed worker after a git write is stale, recovery integrates the copy, and a moved target is rechecked', async () => {
  const root = await repo();
  const child = fork(fileURLToPath(new URL('../fixtures/m6/crash-git.ts', import.meta.url)), [root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.on('data', data => { stderr += data; });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } });
  const message = await new Promise<{ taskId: string; operation: Operation }>((resolve, reject) => {
    child.once('message', resolve as (value: unknown) => void);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Child exited ${code}: ${stderr}`)));
  });
  child.kill('SIGKILL');
  await once(child, 'exit');
  let checks = 0;
  const result = { outcome: 'completed' as const, output: { file: 'feature.txt' }, usage };
  const reviewed = withIndependentReview({
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => result,
      reconcile: async () => ({ state: 'completed' as const, result, quiescent: true as const, proof: 'Worktree contains feature.txt' }) },
    check: { kind: 'program', prepare: async operation => {
      const inner = await sandboxedCheck(root).prepare(operation);
      return async () => {
        checks++;
        const result = await inner();
        return { ...result, output: { checks } };
      };
    } },
  }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    actions: reviewed.actions,
  });
  cleanup.push(() => runtime.close());
  const task = runtime.user.task(message.taskId);
  expect((await task.view()).operations.find(item => item.nodeId === 'work')?.state).toBe('unknown');
  await expect(runtime.host.report(message.operation.id, message.operation.generation, result)).rejects.toMatchObject({ code: 'stale_generation' });
  await writeFile(join(root, 'extra.txt'), 'from target');
  git(root, ['add', 'extra.txt']);
  git(root, ['commit', '-m', 'target moved']);
  await runtime.host.reconcile(message.operation.id);
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(checks).toBe(2);
  expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('done');
  expect(await readFile(join(root, 'extra.txt'), 'utf8')).toBe('from target');
});
