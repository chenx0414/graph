import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { graphManagement } from '../../src/core/graph-service.ts';
import { GraphRuntime } from '../../src/core/graph-runtime.ts';
import { OperationLifecycle } from '../../src/core/operation-lifecycle.ts';
import { approveHumanCheck, insertQuestion } from '../../src/core/question-routing.ts';
import { parseGraphDefinition, type GraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §5, §8 — the main agent's graph control surface.
 *
 * Failure modes first (R24):
 *   G1  a stale baseRevision is refused with the current version, zero changes
 *   G2  an accepted delivery keeps its snapshot across a later patch
 *   G3  completing refuses external delivery and execution-triggering chat
 *   G4  completed requires a drained queue; a blocked node keeps the graph blocked
 *   G5  stop cancels queued items and blocks new dispatch
 *   G6  a completion request can be withdrawn, restoring external input
 *   G7  create is whole-or-nothing: a bad definition leaves no graph behind
 */

function opened(): { store: TaskStore; kernel: KernelStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'graph-'));
  const store = new TaskStore(join(dir, 'state.db'));
  store.db.prepare('INSERT OR IGNORE INTO projects(id,root,grants) VALUES(?,?,?)').run('p1', dir, '[]');
  return { store, kernel: new KernelStore(store), dir };
}

const definition = (name = 'g'): GraphDefinition => parseGraphDefinition({
  schemaVersion: 2, name,
  protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  nodes: { a: { recipe: 'a@1', task: 'a', inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } } },
  modules: {}, edges: {},
});

const twoNode = (name = 'g'): GraphDefinition => parseGraphDefinition({
  ...definition(name),
  nodes: {
    a: { recipe: 'a@1', task: 'a', inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
    b: { recipe: 'b@1', task: 'b', inputs: { in: { protocol: 'ping' } }, outputs: {}, submission: {} },
  },
  edges: { e: { from: 'a.out', to: 'b.in', enabled: true } },
});

describe('GraphRuntime — lifecycle and control (§5, §8)', () => {

  test('G4: completed requires a drained queue; a paused node keeps the graph blocked', () => {
    const { kernel } = opened();
    const runtime = new GraphRuntime(kernel, 't1');
    runtime.create(definition());
    kernel.admitNode('t1', 1, 'a', { instanceId: 'i-a' });
    runtime.deliver({ nodeId: 'a', input: 'in', value: { n: 1 } });

    runtime.complete();
    // Work is still queued: completion cannot settle.
    expect(runtime.settleCompletion()).toBe('completing');

    // Drain the queue but record a paused (failed) node: blocked, not completed.
    kernel.store.db.prepare("UPDATE kernel_queue SET state='done' WHERE task_id='t1'").run();
    kernel.setNodeQueuePaused('t1', 'a', true);
    expect(runtime.settleCompletion()).toBe('blocked');
    expect(runtime.state()!.phase).toBe('blocked');
  });

  test.each(['acknowledge', 'reject'] as const)('native completion waits for the user, and %s settles without legacy node rows', answer => {
    const { kernel, store } = opened();
    const runtime = new GraphRuntime(kernel, 't1');
    runtime.create(definition());
    const question = insertQuestion(store, { taskId: 't1', nodeId: 'a', kind: 'human_check', data: { prompt: 'Inspect the delivered result' } });
    expect(approveHumanCheck(store, question.id, 'main reviewed it')).toBe(true);
    runtime.complete();
    expect.soft(runtime.settleCompletion()).toBe('blocked');
    expect.soft(() => runtime.chat({ nodeId: 'a', text: 'new work' })).toThrow(/completing/);
    const lifecycle = new OperationLifecycle(store);
    expect.soft(() => lifecycle.answer('t1', question.id, { type: answer })).not.toThrow();
    expect(store.db.prepare('SELECT status FROM questions WHERE id=?').get(question.id)).toEqual({ status: 'resolved' });
    expect(runtime.state()?.phase).toBe(answer === 'acknowledge' ? 'completing' : 'blocked');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE task_id=?').get('t1')).toEqual({ n: 0 });
    expect(runtime.settleCompletion()).toBe(answer === 'acknowledge' ? 'completed' : 'blocked');
    if (answer === 'reject') expect(store.db.prepare("SELECT kind FROM questions WHERE task_id=? AND status='open'").get('t1')).toEqual({ kind: 'rework' });
  });

  test.each(['agent', 'module'])('stop refuses a fresh late %s output but preserves an accepted receipt', mode => {
    const { kernel } = opened();
    const runtime = new GraphRuntime(kernel, 't1');
    const graph = twoNode();
    graph.modules.gate = { type: 'router', trigger: 'each', inputs: {}, outputs: { out: { protocol: 'ping' } }, rules: [] };
    graph.edges.gb = { from: 'gate.out', to: 'b.in', enabled: true };
    runtime.create(graph);
    kernel.admitNode('t1', 1, 'a', { instanceId: 'i-a' });
    kernel.admitNode('t1', 1, 'b', { instanceId: 'i-b' });
    kernel.admitModule('t1', 1, 'gate', { moduleType: 'router', trigger: 'each' });
    kernel.startExecution('t1', { executionId: 'accepted', nodeId: 'a', revisionVersion: 1 });
    const request = { submissionId: 's1', outputs: { out: { enable: true, value: { n: 1 } } } };
    const receipt = kernel.submit('accepted', request);
    kernel.finishExecution('accepted', 'completed');
    kernel.startExecution('t1', { executionId: 'late', nodeId: 'a', revisionVersion: 1 });
    runtime.stop();
    expect(kernel.submit('accepted', request)).toMatchObject({ replayed: true, submissionId: receipt.submissionId });
    expect(() => mode === 'agent'
      ? kernel.submit('late', { submissionId: 'late-s', outputs: { out: { enable: true, value: { n: 2 } } } })
      : kernel.broadcastModule('t1', 'gate', { out: { n: 2 } })).toThrow(/stopping/);
    expect(kernel.deliveriesForEdge('t1', 'e')).toHaveLength(1);
    expect(kernel.deliveriesForEdge('t1', 'gb')).toHaveLength(0);
    expect(kernel.execution('late')?.submissionId).toBeNull();
    expect(kernel.nextQueued('t1', 'b')).toBeNull();
    kernel.finishExecution('late', 'failed');
    expect(runtime.settleStop()).toBe('stopped');
  });

});

test('main management creates idle nodes, validates sends and publishes a completion result', async () => {
  const { kernel } = opened();
  new GraphRuntime(kernel, 'owner').create(definition());
  const service = graphManagement(kernel, 'owner');
  const created = await service.graphCreate({ definition: parseGraphDefinition({
    ...definition(), outputs: { result: { from: 'a.out', protocol: 'ping' } }, completion: { on: 'result', drain: true },
  }) }) as { graphId: string };
  expect(kernel.nextQueued(created.graphId, 'a')).toBeNull();
  await expect(service.graphSend({ graphId: created.graphId, nodeId: 'a', input: 'in', value: { n: 'bad' } })).rejects.toThrow(/number/);
  await service.graphSend({ graphId: created.graphId, nodeId: 'a', input: 'in', value: { n: 7 } });
  kernel.startExecution(created.graphId, { executionId: 'answer', nodeId: 'a', revisionVersion: 1 });
  kernel.submit('answer', { submissionId: 'answer-submit', outputs: { out: { enable: true, value: { n: 8 } } } });
  expect((await service.graphInspect({ graphId: created.graphId, query: 'results' }) as unknown[])).toHaveLength(1);
  expect(new GraphRuntime(kernel, created.graphId).state()?.phase).toBe('completing');
  await expect(service.graphSend({ graphId: created.graphId, nodeId: 'a', text: 'extra' })).rejects.toThrow(/completing/);
});

test('main public and module inputs create durable deliveries atomically and honor completion gate', async () => {
  const { kernel } = opened();
  const graph = new GraphRuntime(kernel, 't1');
  const def = definition();
  def.modules.route = { type: 'router', trigger: 'each', inputs: { in: { protocol: 'ping' } }, outputs: {}, rules: [] };
  def.inputs.start = { to: 'route.in', protocol: 'ping' };
  graph.create(def);
  const management = graphManagement(kernel, 't1');
  await expect(management.graphSend({ graphId: 't1', input: 'start', value: { n: 'bad' } })).rejects.toThrow();
  expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM kernel_deliveries').get()).toEqual({ n: 0 });
  await management.graphSend({ graphId: 't1', input: 'start', value: { n: 7 } });
  expect(kernel.db.prepare('SELECT source,edge_id,to_endpoint,value FROM kernel_deliveries').get()).toEqual({ source: 'direct', edge_id: null, to_endpoint: 'route.in', value: '{"n":7}' });
  expect(kernel.db.prepare('SELECT processed FROM kernel_module_inbox').get()).toEqual({ processed: 0 });
  graph.complete();
  await expect(management.graphSend({ graphId: 't1', nodeId: 'route', input: 'in', value: { n: 8 } })).rejects.toThrow(/completing/);
  expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM kernel_deliveries').get()).toEqual({ n: 1 });
});

test('main can patch named objects while preserving accepted work and enforcing atomic revisions and retirement', async () => {
  const { kernel, store } = opened();
  try {
    new GraphRuntime(kernel, 'owner').create(definition());
    const main = graphManagement(kernel, 'owner');
    const { graphId } = await main.graphCreate({ definition: twoNode() }) as { graphId: string };
    const before = kernel.listNodes(graphId).find(node => node.nodeId === 'b')!;
    await main.graphSend({ graphId, nodeId: 'b', input: 'in', value: { n: 7 } });
    const queued = kernel.nextQueued(graphId, 'b')!;
    await main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'adjust running work',
      patch: { nodes: { a: { task: 'updated task' } }, edges: { e: { enabled: false } } },
    } });
    const updated = kernel.latestRevision(graphId)!;
    expect(updated.version).toBe(2);
    expect(updated.definition.nodes.a).toMatchObject({ task: 'updated task', recipe: 'a@1', outputs: { out: { protocol: 'ping' } } });
    expect(updated.definition.edges.e).toEqual({ from: 'a.out', to: 'b.in', enabled: false });
    expect(kernel.listNodes(graphId).find(node => node.nodeId === 'b')!.instanceId).toBe(before.instanceId);
    expect(kernel.nextQueued(graphId, 'b')).toEqual(queued);
    await expect(main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'stale', patch: { name: 'stale' } } })).rejects.toMatchObject({ code: 'stale_revision' });
    await expect(main.graphPatch({ graphId, baseRevision: 2, changes: { reason: 'invalid',
      patch: { nodes: { b: { inputs: { in: { protocol: 'missing' } } } } },
    } })).rejects.toMatchObject({ code: 'invalid_definition' });
    await expect(main.graphPatch({ graphId, baseRevision: 2, changes: { reason: 'ambiguous', definition: twoNode(), patch: {} } })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(main.graphPatch({ graphId, baseRevision: 2, changes: { reason: 'not an object', patch: [] } })).rejects.toMatchObject({ code: 'invalid_input' });
    const retirement = { reason: 'remove b', patch: { nodes: { b: null }, edges: { e: null } }, retire: ['b'] };
    await expect(main.graphPatch({ graphId, baseRevision: 2, changes: retirement })).rejects.toMatchObject({ code: 'pending_work' });
    expect(kernel.latestRevision(graphId)?.version).toBe(2);
    await main.graphControl({ graphId, action: 'cancel', seq: queued.seq });
    const cancelled = await main.graphInspect({ graphId, query: 'queue' });
    for (const action of ['retry', 'skip', 'cancel']) {
      await expect(main.graphControl({ graphId, action, seq: queued.seq })).rejects.toMatchObject({ code: 'invalid_queue' });
    }
    expect(await main.graphInspect({ graphId, query: 'queue' })).toEqual(cancelled);
    await main.graphPatch({ graphId, baseRevision: 2, changes: retirement });
    expect(kernel.latestRevision(graphId)?.version).toBe(3);
    expect(kernel.latestRevision(graphId)?.definition.nodes.b).toBeUndefined();
    expect(kernel.latestRevision(graphId)?.definition.edges.e).toBeUndefined();
    expect(kernel.revision(graphId, 1)?.definition.nodes.a?.task).toBe('a');
    expect(kernel.revision(graphId, 1)?.definition.edges.e?.enabled).toBe(true);
    const states = kernel.db.prepare('SELECT * FROM kernel_node_state WHERE task_id=?').all(graphId);
    for (const nodeId of ['b', 'ghost', 'constructor']) {
      for (const action of ['pause', 'resume']) {
        await expect(main.graphControl({ graphId, action, nodeId })).rejects.toMatchObject({ code: 'invalid_input' });
      }
    }
    expect(kernel.db.prepare('SELECT * FROM kernel_node_state WHERE task_id=?').all(graphId)).toEqual(states);

  } finally { store.close(); }
});
