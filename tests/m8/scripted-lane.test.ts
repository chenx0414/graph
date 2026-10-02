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
 *   S2  the scripted action really ran - once, not zero and not twice
 *   S3  the submission went through the real bridge and completed the execution
 */

test('S1/S2/S3: a v2 graph drains through a scripted action with no model configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-scripted-lane-'));
  let ran = 0;
  const work: ActionAdapter = {
    kind: 'agent',
    reserveTokens: 100,
    prepare: async () => async () => {
      ran += 1;
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
    actions: { work },
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
            inputs: {}, outputs: { out: { protocol: 'out' } },
            submission: { required: ['out'] },
          },
        },
        modules: {}, edges: {}, inputs: {}, outputs: {},
      },
    } as never, 'draft');
    await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'a' });

    // `pump()` is the production tick the host drives every 40ms.
    let dispatched = 0;
    for (let i = 0; i < 5 && ran === 0; i += 1) dispatched = (await runtime.host.pump()).dispatched;

    const { TaskStore } = await import('../../src/core/store.ts');
    const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
    const executions = store.db.prepare('SELECT node_id,state FROM kernel_executions WHERE task_id=?').all(taskId) as { node_id: string; state: string }[];
    const submissions = store.db.prepare('SELECT id FROM kernel_submissions WHERE task_id=?').all(taskId) as { id: string }[];

    expect(dispatched).toBeGreaterThan(0);
    expect(ran).toBe(1);
    expect(executions).toEqual([{ node_id: 'work', state: 'completed' }]);
    expect(submissions.length).toBe(1);
    store.db.close();
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);