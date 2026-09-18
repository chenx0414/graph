import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, Json, NodeSpec } from '../../src/core/types.ts';
import { git as runGit } from '../../src/git/git.ts';
import { withIndependentReview } from '../fixtures/review-gate.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-m4-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'project\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

async function run(
  root: string,
  actions: Record<string, ActionAdapter>,
  nodes: NodeSpec[],
  options: { coderSnapshot?: Json } = {},
) {
  const reviewed = withIndependentReview(actions, nodes);
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: reviewed.actions });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', {
    recommendedGrade: 'high',
    ...(options.coderSnapshot ? { snapshot: options.coderSnapshot } : {}),
  }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Integrate', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Integrate',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }], nodes: reviewed.nodes,
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  return { runtime, task, taskId };
}

test('an Agent worktree commit uses the recipe display name as author and committer', async () => {
  const root = await repo();
  const { runtime, task } = await run(root, {
    work: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      await writeFile(join(operation.workspace!, 'agent.txt'), 'named commit\n');
      return { outcome: 'completed', output: { file: 'agent.txt' }, usage };
    } },
    check: { kind: 'program', prepare: async () => async () => ({
      outcome: 'completed',
      output: null,
      evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: join(root, 'README.md'), digest: createHash('sha256').update('project\n').digest('hex') } }],
    }) },
  }, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ], {
    coderSnapshot: { agentCombination: { name: '代码实现' } },
  });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  const worktree = view.worktrees.find(tree => tree.nodeId === 'work')!.path;
  expect(git(worktree, ['log', '-1', '--format=%an <%ae>|%cn <%ce>']))
    .toBe('代码实现 <coder@agents.graph.local>|代码实现 <coder@agents.graph.local>');
});

test('parallel instances write in separate work copies and both land on the integration and target branches', async () => {
  const root = await repo();
  const { runtime, task } = await run(root, {
    left: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      await writeFile(join(operation.workspace!, 'left.txt'), 'L');
      return { outcome: 'completed', output: { file: 'left.txt' }, usage };
    } },
    right: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      await writeFile(join(operation.workspace!, 'right.txt'), 'R');
      return { outcome: 'completed', output: { file: 'right.txt' }, usage };
    } },
    check: { kind: 'program', prepare: async operation => async () => {
      const left = await readFile(join(operation.workspace!, 'left.txt'), 'utf8');
      const right = await readFile(join(operation.workspace!, 'right.txt'), 'utf8');
      const path = join(operation.workspace!, 'ok.txt');
      await writeFile(path, `${left}${right}`);
      return { outcome: 'completed', output: { left, right }, evidence: [{ acceptanceId: 'works', summary: 'Both files present', artifact: { path, digest: createHash('sha256').update(`${left}${right}`).digest('hex') } }] };
    } },
  }, [
    { id: 'left', kind: 'agent', action: 'left', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'right', kind: 'agent', action: 'right', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['left', 'right'] },
  ]);
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(view.worktrees.length).toBeGreaterThan(2);
  expect(view.worktrees.find(tree => tree.nodeId === 'left')?.path).not.toBe(view.worktrees.find(tree => tree.nodeId === 'right')?.path);
  expect(view.evidence.filter(item => item.valid).every(item => item.commitSha === view.integrationSha)).toBe(true);
  expect(await readFile(join(root, 'left.txt'), 'utf8')).toBe('L');
  expect(await readFile(join(root, 'right.txt'), 'utf8')).toBe('R');
});

test('a merge conflict keeps both instance copies and blocks only the conflicting join', async () => {
  const root = await repo();
  const { runtime, task } = await run(root, {
    left: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      await writeFile(join(operation.workspace!, 'same.txt'), 'left');
      return { outcome: 'completed', output: null, usage };
    } },
    right: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
      await writeFile(join(operation.workspace!, 'same.txt'), 'right');
      return { outcome: 'completed', output: null, usage };
    } },
    check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: join(root, 'README.md'), digest: createHash('sha256').update('project\n').digest('hex') } }] }) },
  }, [
    { id: 'left', kind: 'agent', action: 'left', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'right', kind: 'agent', action: 'right', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['left', 'right'] },
  ]);
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('running');
  expect(view.questions.some(question => question.kind === 'execution_failed' && JSON.stringify(question.data).includes('same.txt'))).toBe(true);
  const leftPath = view.worktrees.find(tree => tree.nodeId === 'left')!.path;
  const rightPath = view.worktrees.find(tree => tree.nodeId === 'right')!.path;
  expect(await readFile(join(leftPath, 'same.txt'), 'utf8')).toBe('left');
  expect(await readFile(join(rightPath, 'same.txt'), 'utf8')).toBe('right');
});
