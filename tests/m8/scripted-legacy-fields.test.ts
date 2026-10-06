import { expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { liftDefinition } from '../fixtures/v2-lift.ts';
import type { ActionAdapter } from '../../src/core/types.ts';
import type { NodeSpec, Proposal } from '../../src/core/types.ts';

/**
 * Issue #1 HB-310: the fields the lift cannot carry still reach the adapter.
 *
 * HB-309 measured which legacy fields the lift drops: `input` 7 files, `context` 5, and
 * both are exactly what an ActionAdapter reads. The scripted turn reads `input` back from
 * the confirmed proposal; nothing verified that `context` survived the same round trip, so
 * a node asking for a context mode could silently get none.
 *
 * Failure modes first (R24):
 *   G1  a node's declared `input` reaches the adapter
 *   G2  a node's declared `context` reaches the adapter, unchanged
 *   G3  a node that declares neither gets neither - the lift does not invent them
 */

test('G1/G2/G3: legacy node fields survive the lift into the adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-v2-legacy-'));
  const seen: Record<string, unknown>[] = [];
  const work: ActionAdapter = {
    kind: 'agent', reserveTokens: 100,
    prepare: async operation => async () => {
      seen.push({ input: operation.input, context: (operation as unknown as { context?: unknown }).context });
      await writeFile(join(root, 'done.txt'), 'ok');
      return { outcome: 'completed', output: { text: 'ok' }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  const plain: ActionAdapter = {
    kind: 'agent', reserveTokens: 100,
    prepare: async operation => async () => {
      seen.push({ input: operation.input, context: (operation as unknown as { context?: unknown }).context });
      return { outcome: 'completed', output: { text: 'ok' }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    actions: { work, plain },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  try {
    const legacyNodes = [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm',
        input: { files: ['a.ts'] }, context: { purpose: 'implement', predecessors: [{ source: 'x', mode: 'result_handoff' }] } },
      { id: 'plain', kind: 'agent', action: 'plain', definitionVersion: 'coder@1', model: 'm' },
    ] as unknown as NodeSpec[];
    const proposal: Proposal = {
      requirementVersion: 1, summary: 'legacy fields',
      acceptance: [{ id: 'ok', description: 'ran', checkNode: 'work' }],
      nodes: legacyNodes,
      definition: liftDefinition(legacyNodes),
    } as Proposal;
    const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'go', requestId: 'b' });
    const proposed = await runtime.supervisor(taskId).propose(proposal, 'draft');
    await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'a' });
    for (const nodeId of ['work', 'plain']) await runtime.supervisor(taskId).graphSend({ graphId: taskId, nodeId, input: 'in', value: {} });
    for (let i = 0; i < 4 && seen.length < 2; i += 1) await runtime.host.pump();

    const withFields = seen.find(s => s.context !== undefined);
    expect(seen.length).toBeGreaterThan(0);
    expect(withFields?.input).toEqual({ files: ['a.ts'] });
    expect(withFields?.context).toEqual({ purpose: 'implement', predecessors: [{ source: 'x', mode: 'result_handoff' }] });
    // G3: nothing is invented for a node that declared none.
    const without = seen.find(s => s.context === undefined);
    expect(without?.input ?? {}).toEqual({});
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
