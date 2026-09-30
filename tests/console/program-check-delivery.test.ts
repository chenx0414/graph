// A delivery has to finish whichever step recorded the last acceptance.
//
// The completion guard runs from two places: an Agent worker reporting its result, and a settle that
// arrives through the lifecycle (a program check, or a question a person answered). The second place
// only handled tasks *without* an integration branch, so a git delivery whose last step was a check or
// a human answer was never re-examined: all its nodes succeeded, every acceptance item was valid, and it
// stayed `running` holding the one active slot - until now nothing said so (HB-201, measured on a real
// task whose nine nodes had succeeded and whose four acceptance items were valid at its integration
// commit, with no delivery ever attempted).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { git } from '../../src/git/git.ts';
import type { ActionAdapter, Proposal } from '../../src/core/types.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test('a delivery whose last acceptance comes from a program check still finishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-program-delivery-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'app.ts'), 'export const value = 1;\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'g@l']);
  git(project, ['config', 'user.name', 'G']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'base']);

  const actions: Record<string, ActionAdapter> = {
    work: {
      kind: 'agent', reserveTokens: 100,
      prepare: async operation => async () => {
        if (operation.workspace) await writeFile(join(operation.workspace, 'app.ts'), 'export const value = 2;\n');
        return { outcome: 'completed', output: { done: true } };
      },
    },
    review: {
      kind: 'agent', reserveTokens: 100,
      prepare: async () => async () => ({ outcome: 'completed', output: { note: 'looks right' }, route: 'pass' }),
    },
    check: {
      kind: 'program',
      prepare: async () => async () => ({
        outcome: 'completed', output: { checked: true },
        evidence: [{ acceptanceId: 'ok', summary: 'the check ran', artifact: { path: join(project, 'ok'), digest: 'a'.repeat(64) } }],
      }),
    },
  };
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], actions });
  cleanup.push(() => runtime.close());
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'deliver the lane', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'deliver',
    acceptance: [{ id: 'ok', description: 'the check ran', checkNode: 'check' }],
    nodes: [
      { id: 'lane', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm' },
      // The delivery carries an independent review, the way every real delivery does: the guard that
      // lets a finished task leave `running` reads that review before it lets the merge happen.
      {
        id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'm', dependsOn: ['lane'],
        routes: ['pass', 'fail'], context: { purpose: 'review', predecessors: [{ source: 'lane', mode: 'evidence_only' }] },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['review'] },
    ],
    loops: [{ from: 'review', to: 'lane', case: 'fail' }],
  } as Proposal, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  // The target branch moves on while the delivery is still waiting its turn - a normal thing on a branch
  // other people (or my own next commit) push to. The harness has to bring its integration up to date and
  // then still deliver; it used to stop after the re-merge and leave the task at `running` forever, with
  // every node succeeded and every acceptance item valid at the integration commit (HB-201: that is the
  // state the real task sat in, and the integration branch still carries the re-merge it stopped at).
  // The move changes no content (an empty commit - how a merge, or a metadata-only push, looks from
  // here). The integration can absorb it without re-checking anything, so the delivery is owed right
  // then; the harness used to re-merge and stop, never delivering, and the task kept the active slot.
  git(project, ['commit', '-q', '--allow-empty', '-m', 'the target branch moves on']);
  // Deliberately not `host.drive()`, whose own completion pass would hide what this test is about: the
  // last step here is settled by the lifecycle alone (a program check), which is exactly the path that
  // used to skip a git delivery. Each iteration also flushes the deferred delivery.
  for (let i = 0; i < 10; i++) await runtime.host.runReady();

  const view = await runtime.user.task(taskId).view();
  expect(view.nodes.map(node => node.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  expect(view.questions).toEqual([]);
  // The delivery really happened: the target branch carries the lane's work. (`git()` trims, so the
  // trailing newline is not part of what is compared here.)
  expect(git(project, ['show', 'main:app.ts']).stdout).toBe('export const value = 2;');
  // And the task says so, instead of sitting at `running` with nothing left to do.
  expect(view.phase).toBe('completed');
});
