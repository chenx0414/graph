import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { git } from '../../src/git/git.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

/**
 * Two lanes that both rewrite the same line of the same file, driven through the real runtime.
 * The lane's content is scripted by the "agent" action, so the collision is deterministic.
 */
async function fixture(name: string, resolve: (input: { prompt: string; workspace: string }) => Promise<void>, enabled = true) {
  const root = await mkdtemp(join(tmpdir(), `graph-merge-loop-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'shared.ts'), 'top\nmiddle\nbottom\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'g@l']);
  git(project, ['config', 'user.name', 'G']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'base']);

  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: project }],
    actions: {
      // Each lane writes its own version of the shared line, so the second merge must collide.
      work: {
        kind: 'agent',
        reserveTokens: 1_000,
        prepare: async operation => async () => {
          const workspace = operation.workspace!;
          // The lane's own identity decides what it writes, so the two parallel lanes really
          // produce colliding content no matter which one merges first.
          const lane = operation.nodeId === 'lane1' ? 1 : 2;
          await writeFile(join(workspace, 'shared.ts'), `top\nfrom-lane-${lane}\nbottom\n`);
          return { outcome: 'completed', output: { lane } };
        },
      },
      check: {
        kind: 'program',
        prepare: async () => async () => ({
          outcome: 'completed', output: null,
          evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(project, 'ok'), digest: 'a'.repeat(64) } }],
        }),
      },
    },
    // The channel reports what the turn cost; these scripted turns cost nothing, which is itself
    // the honest answer for a resolver that never sent a request.
    ...(enabled ? { mergeResolvers: { resolve: async input => { await resolve(input); return null; } } } : {}),
  });
  cleanup.push(() => runtime.close());
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'collide', requestId: 'begin' });
  // Two lanes must be admitted together; the sequential requirement here is the merge order,
  // not the dispatch order, so the check waits for both.
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1,
    summary: 'collide',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'lane1', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm', input: { files: ['shared.ts'] } },
      { id: 'lane2', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm', input: { files: ['shared.ts'] } },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['lane1', 'lane2'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  // The ledger of what happened is durable state, so it is read the same way a recovery test does.
  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const events = (type: string) => (store.db.prepare(
    'SELECT data FROM events WHERE task_id=? AND type=? ORDER BY cursor',
  ).all(taskId, type) as unknown as { data: string }[]).map(row => JSON.parse(row.data) as Record<string, unknown>);
  return { root, project, runtime, taskId, events };
}

test('a lane collision is resolved by one merge Agent and the integration tip keeps both lanes readable', async () => {
  let sawPrompt = '';
  const { runtime, taskId, events, project } = await fixture('resolved', async input => {
    sawPrompt = input.prompt;
    // The agent produces a genuine two-sided resolution of the conflicted line.
    await writeFile(join(input.workspace, 'shared.ts'), 'top\nfrom-lane-1\nfrom-lane-2\nbottom\n');
  });
  const view = await runtime.user.task(taskId).view();
  expect(view.nodes.find(node => node.id === 'lane2')?.status).toBe('succeeded');
  expect(view.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');

  // The prompt carried both sides and the ancestor, so the Agent could really merge them.
  expect(sawPrompt).toContain('from-lane-1');
  expect(sawPrompt).toContain('middle');
  expect(sawPrompt).toMatch(/do not touch any other file/i);

  const mergedEvents = events('git.conflict.merge_attempt_merged');
  expect(mergedEvents).toHaveLength(1);
  const sha = mergedEvents[0]!.sha as string;
  // The merge commit exists in the project repository and carries both lanes' work.
  expect(git(project, ['cat-file', '-t', sha]).stdout).toBe('commit');
  expect(git(project, ['show', `${sha}:shared.ts`]).stdout).toBe('top\nfrom-lane-1\nfrom-lane-2\nbottom');
});

test('a merge Agent that drops one lane is refused, whichever lane collided second', async () => {
  const { runtime, taskId, events } = await fixture('refused', async input => {
    // A one-sided "resolution": it keeps lane 2's text and drops whatever the other side wrote.
    // Which lane that is depends on merge order, so the assertion below must not name one.
    await writeFile(join(input.workspace, 'shared.ts'), 'top\nfrom-lane-2\nbottom\n');
  });
  const refused = events('git.conflict.merge_attempt_refused');
  expect(refused).toHaveLength(1);
  // The collision really was a collision, and the refusal names the lane that had to be merged.
  expect(['lane1', 'lane2']).toContain(refused[0]!.nodeId);
  expect(String(refused[0]!.reason)).toMatch(/dropped/i);

  // A refusal means the task does not complete: whichever lane lost its work is not succeeded.
  const view = await runtime.user.task(taskId).view();
  const statuses = ['lane1', 'lane2'].map(id => view.nodes.find(node => node.id === id)?.status);
  expect(statuses.filter(status => status === 'succeeded').length).toBeLessThanOrEqual(1);
  expect(events('git.conflict.merge_attempt_merged')).toHaveLength(0);
});

test('with no merge Agent configured a collision still blocks, so the feature is opt-in', async () => {
  const { runtime, taskId } = await fixture('disabled', async () => { throw new Error('must not run'); }, false);
  const view = await runtime.user.task(taskId).view();
  expect(view.nodes.find(node => node.id === 'lane2')?.status).not.toBe('succeeded');
});
