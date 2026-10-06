import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

/** A real native task projection, including held work and revisions; main owns it from outside. */
test('native task and main views retain blocked nodes and follow graph revisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-v2-view-'));
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    limits: { defaultBudgetTokens: 10 } });
  try {
    const owner = await runtime.user.begin({ projectId: 'p', request: 'go', requestId: 'owner' });
    const main = runtime.supervisor(owner.taskId);
    const graph = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'one',
      protocols: { out: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
      nodes: { work: { recipe: 'worker@1', task: 'work', inputs: { job: { protocol: 'out' } }, outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } } },
      modules: {}, edges: {},
    }) }) as { graphId: string };
    await main.graphSend({ graphId: graph.graphId, nodeId: 'work', input: 'job', value: { text: 'go' } });
    await runtime.host.drive();
    const view = await runtime.user.task(graph.graphId).view();
    expect(view.nodes.map(node => node.id)).toEqual(['work']);
    expect(view.nodes[0]).toMatchObject({ status: 'blocked', origin: 'v2' });
    expect.soft(view.graphVersion).toBe(1);
    expect(view.revisions.map(revision => revision.version)).toEqual([1]);
    expect(graph.graphId).not.toBe(owner.taskId);
    await main.graphPatch({ graphId: graph.graphId, baseRevision: 1, changes: { reason: 'Add an independent node', patch: {
      nodes: { audit: { recipe: 'worker@1', task: 'audit', inputs: {}, outputs: {}, submission: {} } },
    } } });
    const updated = await runtime.user.task(graph.graphId).view();
    expect(updated.graphVersion).toBe(2);
    expect(updated.revisions.map(revision => revision.version)).toEqual([1, 2]);
    expect(updated.nodes.find(node => node.id === 'work')?.status).toBe('blocked');
    expect(updated.nodes.find(node => node.id === 'audit')?.status).toBe('idle');
    await expect(runtime.supervisor(graph.graphId).graphState()).resolves.toMatchObject({
      graphVersion: 2, graph: { schemaVersion: 2 }, nodes: expect.arrayContaining([expect.objectContaining({ id: 'work', status: 'blocked' })]),
    });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
