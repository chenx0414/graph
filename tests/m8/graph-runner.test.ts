import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { NodeQueue } from '../../src/core/node-queue.ts';
import { NodeSubmitBridge } from '../../src/core/node-submit-bridge.ts';
import { ModuleRuntime } from '../../src/core/module-runtime.ts';
import { GraphRunner, type RunnerHost } from '../../src/core/graph-runner.ts';
import { GraphRuntime } from '../../src/core/graph-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §13.8 — the runner that actually drives a v2 graph to completion.
 *
 * Every piece exists: the queue, the executor, the turn driver, the submit bridge, the
 * module runtime and the router. What no component does yet is DRIVE them together — a
 * graph in the v2 kernel is inert until something drains its queues, lands the
 * deliveries, judges the modules, and routes what they emit. This is that driver, and
 * §13.8's switchover cannot be honest without it.
 *
 * Failure modes first (R24):
 *   S1  a two-node chain runs to completion: worker submits, the delivery queues the
 *       reviewer, the reviewer submits
 *   S2  a module's routed output drives the next node, so a rework loop really loops
 *   S3  the runner stops when the graph is drained and says so
 *   S4  a node that fails pauses only itself, and the runner still reports honestly
 *   S5  a completing graph refuses external delivery while internal work drains
 *   S6  running an already drained graph does nothing
 */

const CHAIN = parseGraphDefinition({
  schemaVersion: 2, name: 'chain',
  protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  nodes: {
    a: { recipe: 'a@1', task: 'a', inputs: {}, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
    b: { recipe: 'b@1', task: 'b', inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
  },
  modules: {},
  edges: { ab: { from: 'a.out', to: 'b.in', enabled: true } },
});

const LOOP = parseGraphDefinition({
  schemaVersion: 2, name: 'loop',
  protocols: { review: { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } } },
  nodes: {
    worker: { recipe: 'w@1', task: 'work', inputs: { rework: { protocol: 'review' } }, outputs: { review: { protocol: 'review' } }, submission: { required: ['review'] } },
  },
  modules: {
    gate: {
      type: 'router', trigger: 'each',
      inputs: { review: { protocol: 'review' } },
      outputs: { rework: { protocol: 'review' } },
      rules: [{ when: 'review.passed == false', emit: { rework: '$review' } }],
    },
  },
  edges: {
    toGate: { from: 'worker.review', to: 'gate.review', enabled: true },
    rework: { from: 'gate.rework', to: 'worker.rework', enabled: true },
  },
});

function opened(definition = CHAIN) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-'));
  const store = new TaskStore(join(dir, 'state.db'));
  store.db.exec(`INSERT INTO projects(id,root,grants) VALUES('p','${dir}','[]');`);
  const kernel = new KernelStore(store);
  // create() writes the graph and its first revision atomically, so the fixture does
  // not pre-insert the task row.
  const created = new GraphRuntime(kernel, 'g1').create(definition, { projectId: 'p' });
  for (const nodeId of Object.keys(created.definition.nodes)) kernel.admitNode('g1', created.revision.version, nodeId, { instanceId: `i-${nodeId}` });
  for (const moduleId of Object.keys(created.definition.modules)) kernel.admitModule('g1', created.revision.version, moduleId, { moduleType: 'router', trigger: 'each' });
  return { store, kernel, revision: created.revision.version };
}

/** A host that never runs a real process: the turn's work is scripted per node. */
function fakeHost(): RunnerHost & { turns: string[] } {
  const host = {
    turns: [] as string[],
    async start() { return { processId: 1 }; },
    alive() { return true; },
    async turn(text: string) { host.turns.push(text); return { turnId: `t${host.turns.length}`, inspect: {} }; },
  };
  return host as unknown as RunnerHost & { turns: string[] };
}

describe('GraphRunner — driving a v2 graph to completion (§13.8)', () => {
  test('S1: a two-node chain runs to completion through real deliveries', async () => {
    const { kernel } = opened();
    // a is triggered first, exactly as an external input would.
    new NodeQueue(kernel, 'g1').enqueue({ nodeId: 'a', kind: 'delivery', input: 'in', value: { go: true } as never });
    const host = fakeHost();
    const values = new Map([['a', { n: 1 }], ['b', { n: 2 }]]);

    const runner = new GraphRunner({
      kernel, graphId: 'g1', host, workerEntry: 'x', config: {} as never, cwd: '/tmp', configPath: '/tmp/cfg.json',
      // The node's submit: each node submits its own scripted output.
      submit: (executionId) => {
        const nodeId = kernel.execution(executionId)!.nodeId;
        return { missing: new NodeSubmitBridge(kernel, executionId).submit({ outputs: { out: { enable: true, value: values.get(nodeId) } }, submissionId: `s-${executionId}` }).missingRequired };
      },
    });

    const result = await runner.drain();

    expect(result.drained).toBe(true);
    // b really ran, because a's delivery queued it — not because a test said so.
    expect(kernel.nextQueued('g1', 'b')).toBeNull();
    const bExecutions = kernel.db.prepare("SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id='g1' AND node_id='b'").get() as { n: number };
    expect(bExecutions.n).toBe(1);
  });

  test('S2: a module-routed output drives the next node, so a rework loop loops', async () => {
    const { kernel, revision } = opened(LOOP);
    new NodeQueue(kernel, 'g1').enqueue({ nodeId: 'worker', kind: 'delivery', input: 'task', value: { go: true } as never });
    const host = fakeHost();
    // The worker fails review twice, then passes: the loop must actually iterate.
    let attempts = 0;
    const modules = new ModuleRuntime(kernel, 'g1', revision);

    const runner = new GraphRunner({
      kernel, graphId: 'g1', host, workerEntry: 'x', config: {} as never, cwd: '/tmp', configPath: '/tmp/cfg.json',
      submit: (executionId) => {
        attempts += 1;
        const passed = attempts >= 3;
        return { missing: new NodeSubmitBridge(kernel, executionId).submit({ outputs: { review: { enable: true, value: { passed } } }, submissionId: `s-${executionId}-${attempts}` }).missingRequired };
      },
      modules,
    });

    const result = await runner.drain();

    expect(result.drained).toBe(true);
    // Three worker executions: two reworked rounds and one that passed.
    const executions = kernel.db.prepare("SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id='g1' AND node_id='worker'").get() as { n: number };
    expect(executions.n).toBe(3);
    // The gate judged each time rather than firing once.
    expect(kernel.moduleTransitions('g1', 'gate').length).toBeGreaterThanOrEqual(2);
  });

  test('S3: the runner reports a drained graph and stops', async () => {
    const { kernel } = opened();
    const host = fakeHost();
    const runner = new GraphRunner({
      kernel, graphId: 'g1', host, workerEntry: 'x', config: {} as never, cwd: '/tmp', configPath: '/tmp/cfg.json',
      submit: () => undefined,
    });
    const result = await runner.drain();
    expect(result.drained).toBe(true);
    expect(result.executions).toBe(0);
  });

  test('S6: draining an already drained graph does nothing', async () => {
    const { kernel } = opened();
    const host = fakeHost();
    let submits = 0;
    const runner = new GraphRunner({
      kernel, graphId: 'g1', host, workerEntry: 'x', config: {} as never, cwd: '/tmp', configPath: '/tmp/cfg.json',
      submit: () => { submits += 1; },
    });
    await runner.drain();
    await runner.drain();
    expect(submits).toBe(0);
  });

  test('S4: a node that fails pauses only itself, and the runner reports it', async () => {
    const { kernel } = opened();
    new NodeQueue(kernel, 'g1').enqueue({ nodeId: 'a', kind: 'delivery', input: 'in', value: { go: true } as never });
    const host = fakeHost();
    const runner = new GraphRunner({
      kernel, graphId: 'g1', host, workerEntry: 'x', config: {} as never, cwd: '/tmp', configPath: '/tmp/cfg.json',
      // a never submits: its retry budget is spent and it fails.
      submit: () => undefined,
    });

    const result = await runner.drain();
    expect(result.drained).toBe(false);
    expect(result.blockedNodes).toContain('a');
    expect(kernel.nodeState('g1', 'a').paused).toBe(true);
  });

  test('S5: a completing graph refuses external delivery while internal work drains', async () => {
    const { kernel } = opened();
    const runtime = new GraphRuntime(kernel, 'g1');
    runtime.complete();
    new NodeQueue(kernel, 'g1').enqueue({ nodeId: 'a', kind: 'delivery', input: 'in', value: { go: true } as never });
    const host = fakeHost();
    const runner = new GraphRunner({
      kernel, graphId: 'g1', host, workerEntry: 'x', config: {} as never, cwd: '/tmp', configPath: '/tmp/cfg.json',
      submit: (executionId) => ({ missing: new NodeSubmitBridge(kernel, executionId).submit({ outputs: { out: { enable: true, value: { n: 1 } } }, submissionId: `s-${executionId}` }).missingRequired }),
    });

    // Internal follow-on still drains...
    const result = await runner.drain();
    expect(result.drained).toBe(true);
    // ...but the graph refuses a NEW external delivery while completing.
    expect(() => runtime.deliver({ nodeId: 'a', input: 'in', value: { go: true } })).toThrow(/completing/);
  });
});
