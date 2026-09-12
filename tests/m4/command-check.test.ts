import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, NodeSpec } from '../../src/core/types.ts';
import { git as runGit } from '../../src/git/git.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-command-check-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'project\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

async function start(root: string, actions: Record<string, ActionAdapter>, nodes: NodeSpec[], input: unknown) {
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Run the check', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Run the check',
    acceptance: [{ id: 'tests', description: 'Tests pass', checkNode: 'check' }],
    nodes: nodes.map(node => node.id === 'check' ? { ...node, ...(input === undefined ? {} : { input: input as import('../../src/core/types.ts').Json }) } : node),
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  return { runtime, task };
}

const workAction: ActionAdapter = {
  kind: 'agent', reserveTokens: 100,
  prepare: async operation => async () => {
    await mkdir(join(operation.workspace!, 'test'), { recursive: true });
    await writeFile(join(operation.workspace!, 'test', 'ok.test.js'), [
      "import { test } from 'node:test';",
      "import assert from 'node:assert';",
      "test('ok', () => assert.equal(1, 1));",
    ].join('\n'));
    return { outcome: 'completed', output: null, usage };
  },
};

const nodes: NodeSpec[] = [
  { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
  { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'] },
];

test('a graph.command program node runs an allowed check on the integration copy and emits bound evidence', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, { work: workAction }, nodes, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions).toEqual([]);
  expect(view.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
  const evidence = view.evidence.find(item => item.acceptanceId === 'tests');
  expect(evidence).toMatchObject({ valid: true, nodeId: 'check', commitSha: view.integrationSha });
  const body = JSON.parse(await readFile(evidence!.artifact.path, 'utf8')) as { code: number; stdout: string };
  expect(body.code).toBe(0);
  expect(body.stdout).toContain('pass');
});

test('a graph.command node that fails its check does not produce acceptance evidence', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, { work: workAction }, nodes, { command: 'node', args: ['--test', 'test/missing.test.js'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.evidence.some(item => item.acceptanceId === 'tests')).toBe(false);
  expect(view.questions.map(question => question.kind)).toContain('execution_failed');
});

test('a graph.command node refuses an unallowed command instead of running it', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, { work: workAction }, nodes, { command: 'sh', args: ['-c', 'touch proof.txt'] });
  await runtime.host.drive();
  const view = await task.view();
  expect(view.questions.map(question => question.kind)).toContain('adapter_error');
  const hash = createHash('sha256').update('absent').digest('hex');
  expect(view.evidence.every(item => item.artifact.digest !== hash)).toBe(true);
});

test('a graph revision cannot weaken the confirmed command of an acceptance check', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, { work: workAction }, nodes, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const before = await task.view();
  expect(before.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
  const weakened = nodes.map(node => node.id === 'check' ? { ...node, input: { command: 'node', args: ['--version'] } } : node);
  await expect(runtime.supervisor(before.id).revise({
    baseVersion: before.graphVersion, reason: 'Skip the required test', nodes: weakened, requestId: 'weaken',
  })).rejects.toMatchObject({ code: 'invalid_proposal' });
  const after = await task.view();
  expect(after.graphVersion).toBe(before.graphVersion);
  expect(after.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
  expect(after.nodes.find(node => node.id === 'check')?.input).toEqual({ command: 'node', args: ['--test'] });
  expect(after.evidence.find(item => item.acceptanceId === 'tests')?.valid).toBe(true);
});

test('a graph revision that keeps confirmed check inputs intact still applies', async () => {
  const root = await repo();
  const { runtime, task } = await start(root, { work: workAction }, nodes, { command: 'node', args: ['--test'] });
  await runtime.host.drive();
  const before = await task.view();
  const extra: NodeSpec = { id: 'extra', kind: 'program', action: 'graph.command', dependsOn: ['check'], input: { command: 'node', args: ['--version'] } };
  const confirmed = nodes.map(node => node.id === 'check' ? { ...node, input: { command: 'node', args: ['--test'] } } : node);
  const revised = await runtime.supervisor(before.id).revise({
    baseVersion: before.graphVersion, reason: 'Add an environment probe', nodes: [...confirmed, extra], requestId: 'add-probe',
  });
  expect(revised.graphVersion).toBe(before.graphVersion + 1);
  await runtime.host.drive();
  const after = await task.view();
  expect(after.nodes.find(node => node.id === 'extra')?.status).toBe('succeeded');
  expect(after.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
});
