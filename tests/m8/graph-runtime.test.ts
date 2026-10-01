import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
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
  nodes: { a: { recipe: 'a@1', task: 'a', inputs: {}, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } } },
  modules: {}, edges: {},
});

const twoNode = (name = 'g'): GraphDefinition => parseGraphDefinition({
  ...definition(name),
  nodes: {
    a: { recipe: 'a@1', task: 'a', inputs: {}, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
    b: { recipe: 'b@1', task: 'b', inputs: { in: { protocol: 'ping' } }, outputs: {}, submission: {} },
  },
  edges: { e: { from: 'a.out', to: 'b.in', enabled: true } },
});

describe('GraphRuntime — lifecycle and control (§5, §8)', () => {
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

  test('G5: stop cancels queued items and blocks new dispatch', () => {
    const { kernel } = opened();
    const runtime = new GraphRuntime(kernel, 't1');
    runtime.create(definition());
    kernel.admitNode('t1', 1, 'a', { instanceId: 'i-a' });
    runtime.deliver({ nodeId: 'a', input: 'in', value: { n: 1 } });

    runtime.stop();
    expect(runtime.state()!.phase).toBe('stopping');
    expect(() => runtime.deliver({ nodeId: 'a', input: 'in', value: { n: 2 } })).toThrow(/stopping/);
    // The queued item was cancelled, so stop settles immediately.
    expect(runtime.settleStop()).toBe('stopped');
    expect(runtime.state()!.phase).toBe('stopped');
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
