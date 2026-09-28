import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { GitIntegration } from '../../src/git/integration.ts';
import { git, mergeConflictFiles } from '../../src/git/git.ts';
import type { NodeSpec } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-merge-lane-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'shared.ts'), 'line1\nline2\nline3\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['-c', 'user.name=G', '-c', 'user.email=g@l', 'add', '.']);
  git(project, ['-c', 'user.name=G', '-c', 'user.email=g@l', 'commit', '-q', '-m', 'init']);
  return { root, project, stateDir: join(root, 'state') };
}

/** Two lanes that edit the same line of the same file: the automatic path must stop. */
async function collidingLanes(project: string, stateDir: string) {
  const runtime = await openTaskRuntime({ stateDir, projects: [{ id: 'p', root: project }], actions: {} });
  cleanup.push(() => runtime.close());
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
  const store = new TaskStore(join(stateDir, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const integration = new GitIntegration(store, stateDir);
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'conflict', requestId: 'begin' });
  const proposal = {
    requirementVersion: 1,
    summary: 'conflict',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'a', kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'm' },
      { id: 'b', kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'm' },
      { id: 'check', kind: 'program' as const, action: 'graph.command', dependsOn: ['a', 'b'], input: { command: 'node', args: ['-v'] } },
    ],
  };
  await runtime.supervisor(taskId).propose(proposal, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  const row = store.db.prepare('SELECT integration_branch FROM tasks WHERE id=?').get(taskId) as { integration_branch: string };
  return { store, integration, taskId, integrationBranch: row.integration_branch };
}

test('lanes that touch different files merge without any agent, and same-line lanes stop the automatic path', async () => {
  const { project, stateDir } = await fixture('disjoint');
  const { store, integration, taskId } = await collidingLanes(project, stateDir);
  const nodeA: NodeSpec = { id: 'a', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm' };
  const treeA = integration.workspace(taskId, 'ia', 'a', 'agent', 'work')!;
  const treeB = integration.workspace(taskId, 'ib', 'b', 'agent', 'work')!;

  // Disjoint: two different files, both must land.
  await writeFile(join(treeA, 'only-a.ts'), 'a\n');
  await writeFile(join(treeB, 'only-b.ts'), 'b\n');
  const first = integration.integrate(operation('a', 'ia', nodeA, taskId));
  const second = integration.integrate(operation('b', 'ib', { ...nodeB() }, taskId));
  expect(first?.ok).toBe(true);
  expect(second?.ok).toBe(true);
  const integrationTree = integration.workspace(taskId, null, 'integration', 'program')!;
  expect(git(integrationTree, ['show', 'HEAD:only-a.ts']).stdout).toBe('a');
  expect(git(integrationTree, ['show', 'HEAD:only-b.ts']).stdout).toBe('b');

  // Same line: the automatic path must refuse and report the conflicting file.
  const again = integration.workspace(taskId, 'ia', 'a', 'agent', 'work')!;
  const other = integration.workspace(taskId, 'ib', 'b', 'agent', 'work')!;
  await writeFile(join(again, 'shared.ts'), 'line1\nfrom-a\nline3\n');
  await writeFile(join(other, 'shared.ts'), 'line1\nfrom-b\nline3\n');
  store.db.prepare('UPDATE worktrees SET path=? WHERE instance_id=?').run(again, 'ia');
  store.db.prepare('UPDATE worktrees SET path=? WHERE instance_id=?').run(other, 'ib');
  const laneA = integration.integrate(operation('a', 'ia', nodeA, taskId));
  expect(laneA?.ok).toBe(true);
  const laneB = integration.integrate(operation('b', 'ib', { ...nodeB() }, taskId));
  expect(laneB?.ok).toBe(false);
  expect(laneB && laneB.ok === false ? laneB.conflicts : []).toContain('shared.ts');
  // The integration branch is left exactly as it was: no half-merge, no invented content.
  expect(git(integrationTree, ['show', 'HEAD:shared.ts']).stdout).toBe('line1\nfrom-a\nline3');
  expect(mergeConflictFiles(integrationTree)).toEqual([]);
});

test('a lane outside its declared scope is restored at the tip, and a file it created is reported instead of silently merged', async () => {
  const { project, stateDir } = await fixture('scoped');
  const { store, integration, taskId } = await collidingLanes(project, stateDir);
  // The declared file list is the lane's scope, and it lives on the node row the gate reads.
  store.db.prepare('UPDATE nodes SET spec=? WHERE task_id=? AND id=?')
    .run(JSON.stringify({ id: 'a', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm', input: { files: ['a-only.ts'] } }), taskId, 'a');
  const spec: NodeSpec = { id: 'a', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm', input: { files: ['a-only.ts'] } };

  const treeA = integration.workspace(taskId, 'ia', 'a', 'agent', 'work')!;
  await writeFile(join(treeA, 'a-only.ts'), 'a\n');
  expect(integration.integrate(operation('a', 'ia', spec, taskId))?.ok).toBe(true);

  // A file that exists at the tip but is outside the scope is restored, never adopted.
  await writeFile(join(treeA, 'shared.ts'), 'line1\nrewritten by a lane that does not own it\nline3\n');
  // A file this lane creates outside its scope cannot be reverted by checkout, so it is reported.
  await writeFile(join(treeA, 'trespass.ts'), 'should not land\n');
  const second = integration.integrate(operation('a', 'ia', spec, taskId));
  expect(second?.ok).toBe(true);

  const integrationTree = integration.workspace(taskId, null, 'integration', 'program')!;
  // The owned file landed, the out-of-scope modification did not.
  expect(git(integrationTree, ['show', 'HEAD:a-only.ts']).stdout).toBe('a');
  expect(git(integrationTree, ['show', 'HEAD:shared.ts']).stdout).toBe('line1\nline2\nline3');

  const restored = store.db.prepare(
    "SELECT data FROM events WHERE task_id=? AND type='git.out-of-scope.restored' ORDER BY cursor DESC LIMIT 1",
  ).get(taskId) as unknown as { data: string } | undefined;
  expect(restored).toBeDefined();
  const payload = JSON.parse(restored!.data) as { restored: string[]; created: string[] };
  expect(payload.restored).toContain('shared.ts');
  expect(payload.created).toContain('trespass.ts');
});

function nodeB(): NodeSpec {
  return { id: 'b', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm' };
}

function operation(nodeId: string, instanceId: string, spec: NodeSpec, taskId: string) {
  return {
    id: `op-${nodeId}-${Math.random().toString(16).slice(2, 10)}`,
    taskId,
    nodeId,
    instanceId,
    kind: 'agent' as const,
    action: spec.action,
  } as unknown as Parameters<GitIntegration['integrate']>[0];
}
