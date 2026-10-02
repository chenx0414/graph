import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { git as runGit } from '../../src/git/git.ts';
import { testModelRuntime } from '../fixtures/models.ts';
import { withIndependentReview } from '../fixtures/review-gate.ts';
import type { Proposal } from '../../src/core/types.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-m4-accept-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'project\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

const work = { kind: 'agent' as const, reserveTokens: 100, prepare: async (operation: { workspace?: string }) => async () => {
  await writeFile(join(operation.workspace!, 'feature.txt'), 'done');
  return { outcome: 'completed' as const, output: null, usage };
} };
const check = { kind: 'program' as const, prepare: async (operation: { workspace?: string }) => async () => {
  const path = join(operation.workspace!, 'feature.txt');
  return { outcome: 'completed' as const, output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path, digest: digest('done') } }] };
} };

test('a git-backed work-check graph without an independent reviewer cannot merge', async () => {
  const root = await repo();
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    actions: { work, check },
  });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'No review', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'No review',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('running');
  expect(view.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
  await expect(readFile(join(root, 'feature.txt'), 'utf8')).rejects.toThrow();
});

test('a completed reviewer agent without a program-owned review gate cannot merge', async () => {
  const root = await repo();
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    actions: {
      work,
      check,
      review: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: { verdict: 'fail', reason: 'Must fix regression' }, usage }) },
    },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Review gate', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Review gate',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
      { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'scripted', dependsOn: ['check'] },
    ],
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('running');
  expect(view.nodes.find(node => node.id === 'review')?.status).toBe('succeeded');
  await expect(readFile(join(root, 'feature.txt'), 'utf8')).rejects.toThrow();
});

test('a structured failing independent review does not merge', async () => {
  const root = await repo();
  const reviewed = withIndependentReview({
    work,
    check,
    review: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      const path = join(operation.workspace!, 'README.md');
      const body = await readFile(path, 'utf8');
      return {
        outcome: 'completed', usage,
        output: { schemaVersion: 1, body: { kind: 'independent', verdict: 'fail', reason: 'Must fix regression', evidence: [{ path, digest: digest(body) }] } },
      };
    } },
  }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'scripted', dependsOn: ['check'] },
  ]);
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: reviewed.actions });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Failing review', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Failing review',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }], nodes: reviewed.nodes,
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('running');
  expect(view.questions.some(question => question.kind === 'rework')).toBe(true);
  await expect(readFile(join(root, 'feature.txt'), 'utf8')).rejects.toThrow();
});

test('review model exclusion walks through program nodes to the implementer', async () => {
  const root = await repo();
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    models: { entries: [{ id: 'writer', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', contextWindow: 32000, maxTokens: 256 }], apiKey: 'local-unused', modelRuntime: await testModelRuntime() },
    actions: { work, check, review: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: { verdict: 'pass' }, usage }) } },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Same model', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Same model',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'writer' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
      { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'writer', dependsOn: ['check'] },
    ],
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toMatchObject([{ kind: 'model_unavailable', nodeId: 'review' }]);
  expect(view.phase).toBe('running');
});

test('a dirty target checkout in another worktree is not overwritten', async () => {
  const root = await repo();
  git(root, ['checkout', '-b', 'other']);
  const target = join(root, '..', `${root.split('/').at(-1)}-target`);
  git(root, ['worktree', 'add', target, 'main']);
  cleanup.push(() => rm(target, { recursive: true, force: true }));
  await writeFile(join(target, 'README.md'), 'human dirty edit\n');
  const reviewed = withIndependentReview({ work, check }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: reviewed.actions });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Worktree target', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Worktree target',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }], nodes: reviewed.nodes,
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('running');
  expect(view.questions).toMatchObject([{ kind: 'git_dirty' }]);
  expect(git(target, ['status', '--porcelain'])).toMatch(/README\.md/);
  await expect(readFile(join(target, 'feature.txt'), 'utf8')).rejects.toThrow();
});

test('a human rejection keeps the check blocked and asks the main Agent for rework', async () => {
  const root = await repo();
  const reviewed = withIndependentReview({ work }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'graph.human_check', dependsOn: ['work'] },
  ], 'work');
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: reviewed.actions });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Human reject', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Human reject',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }], nodes: reviewed.nodes,
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  let view = await task.view();
  const acceptance = view.questions.find(question => question.kind === 'human_check' && question.status === 'open')!;
  await task.answer(acceptance.id, { type: 'reject', reason: 'copy button still shows text' }, 'human-reject');
  await runtime.host.drive();
  view = await task.view();
  // The rejection is a verdict: the acceptance must not pass, and the main Agent owns the rework.
  expect(view.phase).toBe('running');
  expect(view.nodes.find(node => node.id === 'check')!.status).toBe('blocked');
  const rework = view.questions.find(question => question.kind === 'rework' && question.status === 'open')!;
  expect(rework.data).toMatchObject({ reason: 'copy button still shows text' });
  expect(view.evidence.some(entry => entry.acceptanceId === 'works' && entry.valid)).toBe(false);
});

test('a human check is bound to the current activation and commit', async () => {
  const root = await repo();
  const reviewed = withIndependentReview({ work }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'graph.human_check', dependsOn: ['work'] },
  ], 'work');
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: reviewed.actions });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Human', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Human',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }], nodes: reviewed.nodes,
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  let view = await task.view();
  await writeFile(join(root, 'target.txt'), 'target moved after inspection');
  git(root, ['add', 'target.txt']);
  git(root, ['commit', '-m', 'target advanced']);
  await task.answer(view.questions.find(question => question.kind === 'human_check')!.id, { type: 'acknowledge' }, 'human-once');
  await runtime.host.drive();
  view = await task.view();
  expect(view.phase).toBe('running');
  expect(view.questions.filter(question => question.kind === 'human_check' && question.status === 'open')).toHaveLength(1);
  expect(view.operations.filter(operation => operation.nodeId === 'check')).toHaveLength(1);
});

test('unknown usage keeps the instance blocked across a later integration recheck', async () => {
  const root = await repo();
  let releaseLate!: () => void;
  const gate = new Promise<void>(resolve => { releaseLate = resolve; });
  let reviews = 0;
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    limits: { defaultBudgetTokens: 20_000_000 },
    actions: {
      work,
      late: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
        await gate;
        await writeFile(join(operation.workspace!, 'late.txt'), 'late');
        return { outcome: 'completed', output: null, usage };
      } },
      check,
      review: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
        reviews++;
        return { outcome: 'completed', output: { reviews }, usage: reviews === 1 ? null : usage };
      } },
    },
  });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Unknown recheck', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Unknown recheck',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'late', kind: 'agent', action: 'late', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
      { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'scripted', dependsOn: ['check'] },
    ],
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  const running = runtime.host.drive();
  let before;
  for (let i = 0; i < 300; i++) {
    before = await task.view();
    if (before.questions.some(question => question.kind === 'unknown_usage' && question.status === 'open')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(before?.questions.some(question => question.kind === 'unknown_usage')).toBe(true);
  expect(reviews).toBe(1);
  releaseLate();
  await running;
  const after = await task.view();
  expect(reviews).toBe(1);
  expect(after.nodes.find(node => node.id === 'review')?.status).toBe('blocked');
  expect(after.questions.filter(question => question.kind === 'unknown_usage' && question.status === 'open')).toHaveLength(1);
  expect(after.operations.filter(operation => operation.nodeId === 'review')).toHaveLength(1);
});
