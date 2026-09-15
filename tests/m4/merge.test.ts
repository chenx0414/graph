import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, NodeSpec } from '../../src/core/types.ts';
import { git as runGit } from '../../src/git/git.ts';
import { passingReviewAction, withIndependentReview } from '../fixtures/review-gate.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-m4-merge-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'project\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'init']);
  return root;
}
async function start(root: string, actions: Record<string, ActionAdapter>, nodes: NodeSpec[]) {
  const reviewed = withIndependentReview(actions, nodes);
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: reviewed.actions });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Merge', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Merge',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }], nodes: reviewed.nodes,
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  return { runtime, task, taskId };
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('a dirty target checkout is not overwritten and waits for the user', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, {
    work: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      await writeFile(join(operation.workspace!, 'feature.txt'), 'done');
      return { outcome: 'completed', output: null, usage };
    } },
    check: { kind: 'program', prepare: async operation => async () => {
      const path = join(operation.workspace!, 'feature.txt');
      return { outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path, digest: digest('done') } }] };
    } },
  }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  // The target checkout becomes dirty after acceptance; delivery must stop
  // instead of overwriting the user's uncommitted work.
  await writeFile(join(root, 'dirty.txt'), 'unstaged');
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('running');
  expect(view.questions).toMatchObject([{ kind: 'git_dirty' }]);
  expect(await readFile(join(root, 'dirty.txt'), 'utf8')).toBe('unstaged');
  await rm(join(root, 'dirty.txt'));
  await task.answer(view.questions[0]!.id, { type: 'acknowledge' }, 'ack-dirty');
  await runtime.host.drive();
  expect((await task.view()).phase).toBe('completed');
  expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('done');
});

test('a target-branch change invalidates prior evidence and re-runs the check before merge', async () => {
  const root = await repo();
  let checks = 0;
  const { runtime, task } = await start(root, {
    work: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      await writeFile(join(operation.workspace!, 'feature.txt'), 'done');
      return { outcome: 'completed', output: null, usage };
    } },
    check: { kind: 'program', prepare: async operation => async () => {
      checks++;
      const path = join(operation.workspace!, 'feature.txt');
      return { outcome: 'completed', output: { checks }, evidence: [{ acceptanceId: 'works', summary: `check ${checks}`, artifact: { path, digest: digest('done') } }] };
    } },
  }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  await runtime.host.runReady();
  await writeFile(join(root, 'extra.txt'), 'from target');
  git(root, ['add', 'extra.txt']);
  git(root, ['commit', '-m', 'target moved']);
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(checks).toBe(2);
  expect(view.evidence.some(item => !item.valid)).toBe(true);
  expect(view.evidence.filter(item => item.valid)).toHaveLength(1);
  expect(view.evidence.find(item => item.valid)?.commitSha).toBe(view.integrationSha);
  expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('done');
  expect(await readFile(join(root, 'extra.txt'), 'utf8')).toBe('from target');
});

test('a merge already present on the target is treated as complete after restore', async () => {
  const root = await repo();
  const reviewed = withIndependentReview({
    work: { kind: 'agent' as const, reserveTokens: 100, prepare: async (operation: { workspace?: string }) => async () => {
      await writeFile(join(operation.workspace!, 'feature.txt'), 'done');
      return { outcome: 'completed' as const, output: null, usage };
    } },
    check: { kind: 'program' as const, prepare: async (operation: { workspace?: string }) => async () => {
      const path = join(operation.workspace!, 'feature.txt');
      return { outcome: 'completed' as const, output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path, digest: digest('done') } }] };
    } },
  }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: reviewed.actions };
  let runtime = await openTaskRuntime(options);
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Restore merge', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Restore merge',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: reviewed.nodes,
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.runReady();
  const view = await runtime.user.task(taskId).view();
  git(root, ['merge', '--ff-only', view.integrationSha!]);
  await runtime.close();
  runtime = await openTaskRuntime(options);
  await runtime.host.drive();
  expect((await runtime.user.task(taskId).view()).phase).toBe('completed');
});

test('a human acceptance check waits for the user before merge', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, {
    work: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      await writeFile(join(operation.workspace!, 'feature.txt'), 'done');
      return { outcome: 'completed', output: null, usage };
    } },
  }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'graph.human_check', dependsOn: ['work'] },
  ]);
  await runtime.host.drive();
  const blocked = await task.view();
  expect(blocked.questions).toMatchObject([{ kind: 'human_check', nodeId: 'check' }]);
  expect(blocked.phase).toBe('running');
  await task.answer(blocked.questions[0]!.id, { type: 'acknowledge' }, 'human');
  await runtime.host.drive();
  expect((await task.view()).phase).toBe('completed');
  expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('done');
});

test('an independent review must succeed before the target branch is updated', async () => {
  const root = await repo();
  let reviewed = false;
  const { runtime, task } = await start(root, {
    work: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      await writeFile(join(operation.workspace!, 'feature.txt'), 'done');
      return { outcome: 'completed', output: null, usage };
    } },
    check: { kind: 'program', prepare: async operation => async () => {
      const path = join(operation.workspace!, 'feature.txt');
      return { outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path, digest: digest('done') } }] };
    } },
    review: { kind: 'agent', reserveTokens: 100, prepare: async operation => {
      const inner = await passingReviewAction.prepare(operation);
      return async () => {
        reviewed = true;
        await writeFile(join(operation.workspace!, 'review.txt'), 'ok');
        return inner();
      };
    } },
  }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'scripted', dependsOn: ['check'] },
  ]);
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(reviewed).toBe(true);
  expect(view.nodes.find(node => node.id === 'review')?.status).toBe('succeeded');
  expect(view.nodes.find(node => node.id === 'review-gate')?.status).toBe('succeeded');
  expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('done');
  expect(await readFile(join(root, 'review.txt'), 'utf8')).toBe('ok');
});

test('merge uses a conditional ref update when the target branch is not checked out', async () => {
  const root = await repo();
  git(root, ['checkout', '-b', 'other']);
  const { runtime, task } = await start(root, {
    work: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      await writeFile(join(operation.workspace!, 'feature.txt'), 'done');
      return { outcome: 'completed', output: null, usage };
    } },
    check: { kind: 'program', prepare: async operation => async () => {
      const path = join(operation.workspace!, 'feature.txt');
      return { outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path, digest: digest('done') } }] };
    } },
  }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  await runtime.host.drive();
  expect((await task.view()).phase).toBe('completed');
  expect(git(root, ['symbolic-ref', '--short', 'HEAD'])).toBe('other');
  await expect(readFile(join(root, 'feature.txt'), 'utf8')).rejects.toThrow();
  git(root, ['checkout', 'main']);
  expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('done');
});

test('a later integration commit invalidates check evidence and re-runs the program', async () => {
  const root = await repo();
  let checks = 0;
  let releaseLate = () => {};
  const lateGate = new Promise<void>(resolve => { releaseLate = resolve; });
  const { runtime, task } = await start(root, {
    work: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      await writeFile(join(operation.workspace!, 'feature.txt'), 'done');
      return { outcome: 'completed', output: null, usage };
    } },
    late: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      await lateGate;
      await writeFile(join(operation.workspace!, 'late.txt'), 'extra');
      return { outcome: 'completed', output: null, usage };
    } },
    check: { kind: 'program', prepare: async operation => async () => {
      checks++;
      if (checks === 1) releaseLate();
      const path = join(operation.workspace!, 'feature.txt');
      return { outcome: 'completed', output: { checks }, evidence: [{ acceptanceId: 'works', summary: `check ${checks}`, artifact: { path, digest: digest('done') } }] };
    } },
  }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'late', kind: 'agent', action: 'late', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(checks).toBeGreaterThanOrEqual(2);
  expect(view.evidence.some(item => !item.valid)).toBe(true);
  expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('done');
  expect(await readFile(join(root, 'late.txt'), 'utf8')).toBe('extra');
});
