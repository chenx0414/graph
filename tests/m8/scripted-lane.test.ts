import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter } from '../../src/core/types.ts';

/**
 * Issue #1 HB-282: a v2 graph must be runnable without a configured model.
 *
 * The lane resolved a real session and started a real Pi process, so most of the suite -
 * which drives nodes with a scripted ActionAdapter and configures no model at all - could
 * create a v2 graph but never run it. The graph sat there with every node `idle`.
 *
 * This is the end-to-end proof that the scripted path is real rather than a second
 * execution path: the node submits through the same `onToolCall` and the same
 * NodeSubmitBridge, so the kernel settles the submission and advances the graph exactly as
 * a real turn would. Only the process that produces the tool call is replaced.
 *
 * Failure modes first (R24):
 *   S1  a confirmed v2 graph drains with no model, credential or Pi process
 *   S2  the scripted action runs under its frozen task and recipe through resubmission
 *   S3  the submission went through the real bridge and completed the execution
 */

test('S1/S2/S3: a v2 graph drains without a model and freezes its action across resubmission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-scripted-lane-'));
  let ran = 0;
  let changedRuns = 0;
  const identities: { action: string; recipe: unknown }[] = [];
  let received: unknown;
  const briefings: string[] = [];
  const work: ActionAdapter = {
    kind: 'agent',
    reserveTokens: 100,
    prepare: async operation => async () => {
      received = operation.input;
      briefings.push(operation.context?.briefing ?? '');
      ran += 1;
      identities.push({ action: operation.action, recipe: 'recipe' in operation ? operation.recipe : null });
      if (ran === 1) {
        await runtime.supervisor(operation.taskId).graphPatch({ graphId: operation.taskId, baseRevision: 1, changes: {
          reason: 'Apply the new action only to the next execution', patch: { nodes: { work: { task: 'modified', recipe: 'worker@2' } } },
        } });
        return { outcome: 'failed', output: null };
      }
      await writeFile(join(root, 'out.txt'), 'done\n');
      return {
        outcome: 'completed',
        output: { text: 'work done' },
        usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 },
      };
    },
  };

  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root }],
    actions: { work, modified: { kind: 'agent', prepare: async operation => async () => {
      changedRuns += 1;
      identities.push({ action: operation.action, recipe: 'recipe' in operation ? operation.recipe : null });
      return { outcome: 'completed', output: { text: 'new configuration' } };
    } } },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });

  try {
    const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'do it', requestId: 'b' });
    const proposed = await runtime.supervisor(taskId).propose({
      requirementVersion: 1,
      summary: 'one node',
      acceptance: [{ id: 'ok', description: 'ran', checkNode: 'work' }],
      nodes: [],
      definition: {
        schemaVersion: 2,
        name: 'one',
        protocols: { out: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
        nodes: {
          work: {
            recipe: 'worker@1', task: 'do the work',
            inputs: { job: { protocol: 'out' } }, outputs: { out: { protocol: 'out' } },
            submission: { required: ['out'] },
          },
        },
        modules: {}, edges: {}, inputs: {}, outputs: {},
        acceptance: [{ id: 'ok', description: 'ran', kind: 'human' }],
      },
    } as never, 'draft');
    await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'a' });
    await runtime.supervisor(taskId).graphSend({ graphId: taskId, nodeId: 'work', input: 'job', value: { text: 'go' } });

    // `pump()` is the production tick the host drives every 40ms.
    let dispatched = 0;
    for (let i = 0; i < 5 && ran === 0; i += 1) dispatched += (await runtime.host.pump()).dispatched;

    await runtime.host.drive();
    const { TaskStore } = await import('../../src/core/store.ts');
    const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
    const executions = store.db.prepare('SELECT node_id,state FROM kernel_executions WHERE task_id=?').all(taskId) as { node_id: string; state: string }[];
    const submissions = store.db.prepare('SELECT id FROM kernel_submissions WHERE task_id=?').all(taskId) as { id: string }[];
    store.close();

    expect(received).toEqual({ text: 'go' });
    expect(briefings[0]).toContain('GRAPH OVERVIEW');
    expect(briefings[1]).toContain('required output(s) out');
    expect(briefings[1]).not.toContain('GRAPH OVERVIEW');
    expect(dispatched).toBeGreaterThan(0);
    expect(ran).toBe(2);
    expect(changedRuns).toBe(0);
    expect(identities).toEqual([{ action: 'do the work', recipe: 'worker@1' }, { action: 'do the work', recipe: 'worker@1' }]);
    expect(executions).toEqual([{ node_id: 'work', state: 'completed' }]);
    expect(submissions.length).toBe(1);
    await runtime.supervisor(taskId).graphSend({ graphId: taskId, nodeId: 'work', input: 'job', value: { text: 'next' } });
    await runtime.host.drive();
    expect(changedRuns).toBe(1);
    expect(ran).toBe(2);
    expect(identities.at(-1)).toEqual({ action: 'modified', recipe: 'worker@2' });
    expect(runtime.nodeRun(taskId, 'work').operations).toHaveLength(2);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);