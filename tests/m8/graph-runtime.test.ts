import { kernelGraphView, kernelNodePrompt, kernelNodeRun } from '../../src/core/kernel-views.ts';
import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { graphManagement } from '../../src/core/graph-service.ts';
import { GraphRuntime } from '../../src/core/graph-runtime.ts';
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
  test('completion intent stays closed and withdrawable when a node is blocked', () => {
    const { kernel } = opened();
    const runtime = new GraphRuntime(kernel, 't1');
    runtime.create(twoNode());
    kernel.admitNode('t1', 1, 'a', { instanceId: 'i-a' });
    kernel.setNodeQueuePaused('t1', 'a', true);
    runtime.complete();
    expect(runtime.settleCompletion()).toBe('blocked');
    expect(() => runtime.chat({ nodeId: 'a', text: 'new work' })).toThrow(/completing/);
    runtime.withdrawComplete();
    expect(runtime.state()?.phase).toBe('running');
  });

  test('disabling a connection during an execution affects its subsequent submit', () => {
    const { kernel } = opened();
    const runtime = new GraphRuntime(kernel, 't1');
    runtime.create(twoNode());
    kernel.admitNode('t1', 1, 'a', { instanceId: 'i-a' });
    kernel.admitNode('t1', 1, 'b', { instanceId: 'i-b' });
    kernel.startExecution('t1', { executionId: 'x', nodeId: 'a', revisionVersion: 1 });
    runtime.patch({ baseRevision: 1, changes: { reason: 'disable edge', definition: parseGraphDefinition({ ...twoNode(), edges: { e: { from: 'a.out', to: 'b.in', enabled: false } } }) } });
    const receipt = kernel.submit('x', { submissionId: 's', outputs: { out: { enable: true, value: { n: 1 } } } });
    expect(receipt.deliveries).toHaveLength(0);
    expect(kernel.nextQueued('t1', 'b')).toBeNull();
  });

  test('v2 views expose named connections and record absence without fabricating a sent prompt', async () => {
    const { kernel } = opened();
    const runtime = new GraphRuntime(kernel, 't1');
    runtime.create(twoNode());
    kernel.admitNode('t1', 1, 'a', { instanceId: 'ia' });
    kernel.admitNode('t1', 1, 'b', { instanceId: 'ib' });
    kernel.startExecution('t1', { executionId: 'x', nodeId: 'a', revisionVersion: 1 });
    kernel.submit('x', { submissionId: 's', outputs: { out: { enable: true, value: { n: 42 } } } });
    expect(kernelGraphView(kernel, 't1')?.edges[0]?.latest).toEqual({ n: 42 });
    expect(kernelNodePrompt(kernel, 't1', 'a').recorded).toBeNull();
    expect(kernelNodeRun(kernel, 't1', 'a', {}).timing.inProgress).toBe(true);
    kernel.db.prepare('INSERT INTO kernel_prompts(task_id,node_id,execution_id,system_prompt,tools,created_at) VALUES(?,?,?,?,?,?)').run('t1', 'a', 'x', 'actual provider text', '[]', 1);
    expect(kernelNodePrompt(kernel, 't1', 'a').recorded?.text).toBe('actual provider text');
  });

  test('G7: create is whole-or-nothing and returns the validated definition', () => {
    const { kernel } = opened();
    const runtime = new GraphRuntime(kernel, 't1');
    const created = runtime.create(definition());
    expect(created.revision.version).toBe(1);
    expect(created.definition.name).toBe('g');
    expect(runtime.state()!.phase).toBe('running');
    // A second create on the same graph is refused and writes nothing new.
    expect(() => runtime.create(definition())).toThrow(/already exists/);
    expect(kernel.latestRevision('t1')!.version).toBe(1);
  });

  test('G1: a stale baseRevision is refused with the current version, zero changes', () => {
    const { kernel } = opened();
    const runtime = new GraphRuntime(kernel, 't1');
    runtime.create(definition());
    runtime.patch({ baseRevision: 1, changes: { reason: 'first', definition: definition('g1') } });
    // Base 1 is now stale; the refusal names the current version (2) and writes nothing.
    expect(() => runtime.patch({ baseRevision: 1, changes: { reason: 'stale', definition: definition('g2') } }))
      .toThrow(/current revision is 2/);
    expect(kernel.latestRevision('t1')!.version).toBe(2);
    expect(kernel.latestRevision('t1')!.definition.name).toBe('g1');
  });

  test('G2: an accepted delivery keeps its snapshot across a later patch', () => {
    const { kernel } = opened();
    const runtime = new GraphRuntime(kernel, 't1');
    const created = runtime.create(twoNode());
    kernel.admitNode('t1', created.revision.version, 'a', { instanceId: 'i-a' });
    kernel.admitNode('t1', created.revision.version, 'b', { instanceId: 'i-b' });
    kernel.startExecution('t1', { executionId: 'exec-1', nodeId: 'a', revisionVersion: created.revision.version });
    kernel.submit('exec-1', { outputs: { out: { enable: true, value: { n: 1 } } }, submissionId: 'sub-1' });

    runtime.patch({ baseRevision: 1, changes: { reason: 'disable e', definition: parseGraphDefinition({ ...twoNode(), edges: { e: { from: 'a.out', to: 'b.in', enabled: false } } }) } });

    // The delivery to b was frozen at revision 1 and survives the new revision.
    const deliveries = kernel.deliveriesFor('exec-1');
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.revisionVersion).toBe(1);
  });

  test('G3/G6: completing refuses external input, and the request can be withdrawn', () => {
    const { kernel } = opened();
    const runtime = new GraphRuntime(kernel, 't1');
    runtime.create(definition());
    kernel.admitNode('t1', 1, 'a', { instanceId: 'i-a' });

    runtime.complete();
    expect(runtime.state()!.phase).toBe('completing');
    expect(() => runtime.deliver({ nodeId: 'a', input: 'in', value: { n: 1 } })).toThrow(/completing/);
    expect(() => runtime.chat({ nodeId: 'a', text: 'go' })).toThrow(/completing/);

    runtime.withdrawComplete();
    expect(runtime.state()!.phase).toBe('running');
    // External input is open again.
    expect(runtime.deliver({ nodeId: 'a', input: 'in', value: { n: 1 } }).nodeId).toBe('a');
  });

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

  test('G4b: a drained graph with no failure settles as completed', () => {
    const { kernel } = opened();
    const runtime = new GraphRuntime(kernel, 't1');
    runtime.create(definition());
    runtime.complete();
    expect(runtime.settleCompletion()).toBe('completed');
    expect(runtime.state()!.phase).toBe('completed');
  });

  test('G5: stop cancels queued items and blocks new dispatch even while paused', async () => {
    const { kernel } = opened();
    const runtime = new GraphRuntime(kernel, 't1');
    runtime.create(definition());
    kernel.admitNode('t1', 1, 'a', { instanceId: 'i-a' });
    const accepted = runtime.deliver({ nodeId: 'a', input: 'in', value: { n: 1 } });

    const main = graphManagement(kernel, 't1');
    await main.graphControl({ graphId: 't1', action: 'pause' });
    expect(runtime.state()?.phase).toBe('paused');
    runtime.stop();
    expect(kernel.store.task('t1').paused).toBe(0);
    expect(runtime.state()!.phase).toBe('stopping');
    expect(() => runtime.deliver({ nodeId: 'a', input: 'in', value: { n: 2 } })).toThrow(/stopping/);
    // The queued item was cancelled, so stop settles immediately.
    expect(runtime.settleStop()).toBe('stopped');
    expect(runtime.state()!.phase).toBe('stopped');
    const queue = await main.graphInspect({ graphId: 't1', query: 'queue' }) as { items: { seq: number; state: string; reason: string }[] };
    expect(queue.items[0]).toMatchObject({ seq: accepted.seq, state: 'done', reason: 'cancelled by stop' });
  });

  test('inspect: summary, nodes, revision and deliveries are all readable', () => {
    const { kernel } = opened();
    const runtime = new GraphRuntime(kernel, 't1');
    runtime.create(twoNode());
    kernel.admitNode('t1', 1, 'a', { instanceId: 'i-a' });
    kernel.admitNode('t1', 1, 'b', { instanceId: 'i-b' });
    kernel.startExecution('t1', { executionId: 'exec-1', nodeId: 'a', revisionVersion: 1 });
    // a.out feeds b.in, so the accepted submission freezes one delivery.
    kernel.submit('exec-1', { outputs: { out: { enable: true, value: { n: 1 } } }, submissionId: 's1' });

    expect((runtime.inspect({ kind: 'summary' }) as { phase: string }).phase).toBe('running');
    expect((runtime.inspect({ kind: 'revision' }) as { name: string }).name).toBe('g');
    expect((runtime.inspect({ kind: 'nodes' }) as unknown[]).length).toBe(2);
    expect((runtime.inspect({ kind: 'deliveries', executionId: 'exec-1' }) as unknown[]).length).toBe(1);
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

test('pending node removal is refused without changing the revision or queued input', () => {
  const { kernel } = opened();
  const runtime = new GraphRuntime(kernel, 't1');
  runtime.create(twoNode());
  kernel.admitNode('t1', 1, 'b', { instanceId: 'i-b' });
  runtime.deliver({ nodeId: 'b', input: 'in', value: { n: 1 } });
  expect(() => runtime.patch({ baseRevision: 1, changes: { reason: 'remove b', retire: ['b'], definition: definition() } })).toThrow(/pending work/);
  expect(kernel.latestRevision('t1')?.version).toBe(1);
  expect(kernel.nextQueued('t1', 'b')?.payload).toMatchObject({ value: { n: 1 } });
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


test('graph creation retries preparation with the same graph and refuses changed request content', async () => {
  const { kernel } = opened();
  new GraphRuntime(kernel, 't1').create(definition());
  let prepares = 0;
  const management = graphManagement(kernel, 't1', () => { prepares++; if (prepares === 1) throw new Error('git unavailable'); });
  const input = { definition: definition('child'), targetBranch: 'main', requestId: 'create-once' };
  const first = await management.graphCreate(input) as { graphId: string; state: string };
  expect(first.state).toBe('blocked');
  expect(kernel.store.task(first.graphId).paused).toBe(1);
  const second = await management.graphCreate(input) as { graphId: string; replayed: boolean };
  expect(second.graphId).toBe(first.graphId);
  expect(second.replayed).toBe(true);
  expect(kernel.store.task(first.graphId).paused).toBe(0);
  await management.graphCreate(input);
  expect(prepares).toBe(2);
  await expect(management.graphCreate({ ...input, definition: definition('different') })).rejects.toThrow(/requestId/);
  expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM kernel_graph_owners').get()).toEqual({ n: 1 });
});


test.each(['completed', 'stopped'])('terminal %s graph cannot reopen through completion controls or patch', async phase => {
  const { kernel } = opened();
  const runtime = new GraphRuntime(kernel, 't1');
  const declared = definition();
  declared.modules.gate = { type: 'router', trigger: 'once', inputs: {}, outputs: {}, rules: [] };
  runtime.create(declared);
  kernel.admitNode('t1', 1, 'a', { instanceId: 'ia' });
  kernel.admitModule('t1', 1, 'gate', { moduleType: 'router', trigger: 'once' });
  kernel.db.prepare("UPDATE kernel_modules SET triggered=1 WHERE task_id='t1' AND module_id='gate'").run();
  const main = graphManagement(kernel, 't1');
  const queued = runtime.chat({ nodeId: 'a', text: 'cancel this input' });
  await main.graphControl({ graphId: 't1', action: 'cancel', seq: queued.seq });
  runtime.complete();
  if (phase === 'completed') runtime.settleCompletion();
  else { runtime.stop(); runtime.settleStop(); }
  expect(() => runtime.withdrawComplete()).toThrow(/not completing/);
  expect(() => runtime.patch({ baseRevision: 1, changes: { reason: 'reopen', definition: definition('new') } })).toThrow(/Ended graph/);
  if (phase === 'stopped') {
    expect(() => runtime.complete()).toThrow(/Stopped graph/);
    expect(() => runtime.settleCompletion()).toThrow(/Stopped graph/);
  }
  else expect(runtime.complete().phase).toBe('completed');
  expect(runtime.stop().phase).toBe(phase);
  expect(runtime.state()?.phase).toBe(phase);
  expect(kernel.latestRevision('t1')?.version).toBe(1);
  for (const control of [
    { action: 'pause' }, { action: 'resume' }, { action: 'pause', nodeId: 'a' }, { action: 'resume', nodeId: 'a' },
    { action: 'reopen', moduleId: 'gate' }, { action: 'retry', seq: queued.seq }, { action: 'skip', seq: queued.seq }, { action: 'cancel', seq: queued.seq },
  ]) await expect(main.graphControl({ graphId: 't1', ...control })).rejects.toThrow(/Ended graph/);
  expect(kernel.store.task('t1').paused).toBe(0);
  expect(kernel.nodeState('t1', 'a').paused).toBe(false);
  expect(kernel.db.prepare('SELECT state,generation FROM kernel_queue WHERE seq=?').get(queued.seq)).toEqual({ state: 'done', generation: 0 });
  expect(kernel.db.prepare("SELECT triggered FROM kernel_modules WHERE task_id='t1' AND module_id='gate'").get()).toEqual({ triggered: 1 });
  expect(runtime.state()?.phase).toBe(phase);
});


test.each(['retry', 'skip'])('failed input requires explicit %s before completion can proceed', async action => {
  const { kernel } = opened();
  const graph = new GraphRuntime(kernel, 't1');
  graph.create(definition());
  kernel.admitNode('t1', 1, 'a', { instanceId: 'ia' });
  graph.deliver({ nodeId: 'a', input: 'in', value: { n: 1 } });
  const queued = kernel.nextQueued('t1', 'a')!;
  // Model failure retains the original input even after the queue is resumed.
  kernel.db.prepare("UPDATE kernel_queue SET state='failed' WHERE seq=?").run(queued.seq);
  kernel.db.prepare("UPDATE kernel_nodes SET status='blocked' WHERE task_id='t1' AND node_id='a'").run();
  graph.complete();
  expect(graph.settleCompletion()).toBe('blocked');
  const main = graphManagement(kernel, 't1');
  await main.graphControl({ graphId: 't1', action, seq: queued.seq });
  expect(graph.state()?.phase).toBe('completing');
  expect(kernel.nodeState('t1', 'a').paused).toBe(false);
  expect(kernel.listNodes('t1').find(node => node.nodeId === 'a')?.status).toBe('idle');
  if (action === 'retry') {
    expect(kernel.nextQueued('t1', 'a')?.payload).toMatchObject({ value: { n: 1 } });
    expect(graph.settleCompletion()).toBe('completing');
  } else {
    expect(kernel.nextQueued('t1', 'a')).toBeNull();
    expect(graph.settleCompletion()).toBe('completed');
  }
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
    await main.graphPatch({ graphId, baseRevision: 2, changes: retirement });
    expect(kernel.latestRevision(graphId)?.version).toBe(3);
    expect(kernel.latestRevision(graphId)?.definition.nodes.b).toBeUndefined();
    expect(kernel.latestRevision(graphId)?.definition.edges.e).toBeUndefined();
    expect(kernel.revision(graphId, 1)?.definition.nodes.a?.task).toBe('a');
    expect(kernel.revision(graphId, 1)?.definition.edges.e?.enabled).toBe(true);
  } finally { store.close(); }
});
