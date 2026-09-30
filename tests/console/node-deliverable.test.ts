import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { ArtifactWorkspace } from '../../src/core/artifact-workspace.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, NodeSpec, Operation, OperationResult } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

function scripted(handler: (operation: Operation) => Promise<OperationResult> | OperationResult): ActionAdapter {
  return { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => handler(operation) };
}

/**
 * A subagent's deliverable must not depend on the subagent remembering a tool call. In the simple
 * tier study three nodes each wrote a note and only one of them also published it, because nothing
 * in the graph had asked for an artifact: the node inputs only said "write notes/x.md". The node
 * declares the deliverable and the harness publishes it, which is where the file's existence can
 * also be enforced.
 */
async function fixture(handler: (operation: Operation) => Promise<OperationResult> | OperationResult) {
  const root = await mkdtemp(join(tmpdir(), 'graph-node-deliverable-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root }],
    actions: { work: scripted(handler) },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => runtime.close());
  return { root, runtime, stateDir: join(root, 'state') };
}

function nodeStatus(stateDir: string, taskId: string, nodeId: string) {
  const store = new TaskStore(join(stateDir, 'tasks.sqlite'));
  const row = store.db.prepare('SELECT status FROM nodes WHERE task_id=? AND id=?').get(taskId, nodeId) as { status: string } | undefined;
  store.close();
  return row?.status;
}

function graph(deliverable: NonNullable<NodeSpec['deliverable']>) {
  return {
    requirementVersion: 1,
    summary: '一条车道交回一份笔记',
    acceptance: [{ id: 'ok', description: '笔记存在', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'm', deliverable },
      { id: 'check', kind: 'program' as const, action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['--version'] } },
    ],
  };
}

test('a node that declares a deliverable has it published for it, without the node asking', async () => {
  const { root, runtime, stateDir } = await fixture(async operation => {
    // A real subagent writes into its own workspace, which for a git-prepared project is its lane
    // worktree rather than the project root.
    const workspace = operation.workspace ?? root;
    await mkdir(join(workspace, 'notes'), { recursive: true });
    await writeFile(join(workspace, 'notes/lane.md'), '# lane notes\n');
    return { outcome: 'completed', output: { wrote: 'notes/lane.md' }, usage };
  });
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: '调研一条车道', requestId: 'begin' });
  await runtime.supervisor(taskId).propose(graph({ path: 'notes/lane.md', namespace: 'research', name: 'lane-notes', title: 'lane notes' }), 'draft');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  const listed = await runtime.artifacts.list(taskId);
  const published = listed.artifacts.find(item => item.name === 'lane-notes');
  expect(published, 'the declared deliverable should have been published').toBeTruthy();
  expect(published!.scope).toBe('task');
  expect(published!.namespace).toBe('research');
  expect(published!.title).toBe('lane notes');

  // The published bytes are the file the node actually wrote.
  const read = await runtime.artifacts.read(taskId, published!.artifactId, published!.version);
  expect(read.text).toContain('# lane notes');

  // It is recorded as that node's product, so a reviewer or the main Agent can tell where it came
  // from without opening the node.
  expect(published!.producer?.nodeId).toBe('work');

  expect(nodeStatus(stateDir, taskId, 'work')).toBe('succeeded');
}, 90_000);

test('the same bytes are published once, not twice: the harness does not re-publish what the node already published', async () => {
  const { root, runtime, stateDir } = await fixture(async operation => {
    const workspace = operation.workspace ?? root;
    await mkdir(join(workspace, 'reviews'), { recursive: true });
    await writeFile(join(workspace, 'reviews/lane.md'), '# lane review\n\nverdict: pass\n');
    // The node publishes its own review through the product's own write path, which is what a
    // reviewer Agent does with the artifact_publish tool. The harness then publishes the declared
    // deliverable too; if it does that without looking, one review becomes two identical versions.
    const own = new TaskStore(join(stateDir, 'tasks.sqlite'));
    const artifacts = new ArtifactWorkspace(own, join(stateDir, 'artifact-workspace'));
    await artifacts.publish({
      taskId: operation.taskId, workspace, namespace: 'reviews', name: 'lane',
      sourcePath: 'reviews/lane.md', title: 'lane review', requestId: `node-publish:${operation.id}`,
      producer: { nodeId: operation.nodeId, instanceId: operation.instanceId!, operationId: operation.id, activationId: operation.activationId },
    });
    own.close();
    return { outcome: 'completed', output: { wrote: 'reviews/lane.md' }, usage };
  });
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: '调研一条车道', requestId: 'begin' });
  await runtime.supervisor(taskId).propose(graph({ path: 'reviews/lane.md', namespace: 'reviews', name: 'lane', title: 'lane review' }), 'draft');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  // Every version of that key, not just the latest: a duplicate version is the thing being ruled out.
  const all = runtime.artifacts.list(taskId, { namespace: 'reviews', latestOnly: false });
  const mine = all.artifacts.filter(item => item.name === 'lane');
  expect(mine.map(item => item.version), 'identical bytes must not mint a second version').toEqual([1]);
  expect(runtime.artifacts.list(taskId).artifacts.find(item => item.name === 'lane')!.title).toBe('lane review');
}, 90_000);

test('a declared deliverable that was never written fails the node instead of passing silently', async () => {
  const { runtime, stateDir } = await fixture(async () => ({ outcome: 'completed', output: { wrote: 'nothing' }, usage }));
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: '调研一条车道', requestId: 'begin' });
  await runtime.supervisor(taskId).propose(graph({ path: 'notes/missing.md', namespace: 'research', name: 'missing-notes' }), 'draft');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  // The work is not accepted: a deliverable the graph promised and nobody produced is a defect,
  // not a pass with a missing file.
  expect(nodeStatus(stateDir, taskId, 'work')).not.toBe('succeeded');

  const listed = await runtime.artifacts.list(taskId);
  expect(listed.artifacts.map(item => item.name)).not.toContain('missing-notes');
}, 90_000);
