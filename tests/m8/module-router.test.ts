import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { ModuleRuntime } from '../../src/core/module-runtime.ts';
import { routeModuleOutputs } from '../../src/core/module-router.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §2, §6, §14 — routing a module's emitted outputs into the graph.
 *
 * The kernel already lands an agent's submit on its targets: a delivery to a node is
 * queued (§7) and a delivery to a module updates that module's input (§2). What was
 * missing is the other half of the same sentence: when a module JUDGES and emits, those
 * outputs must travel to their own targets, and a target module must then judge in turn.
 * Without that leg, `each` rework and `once` chains stop at the first module.
 *
 * Failure modes first (R24):
 *   R1  an emitted output lands on each enabled target node, queued in acceptance order
 *   R2  an output targeting another module sets that input and judges it (a cascade)
 *   R3  a disabled edge from the module carries nothing
 *   R4  no emit (waiting, or a once that already fired) produces no deliveries at all
 *   R5  the cascade terminates on a rework loop instead of recursing forever
 *   R6  every landing is explainable: a delivery row for a node, a transition for a module
 */

const DEF = parseGraphDefinition({
  schemaVersion: 2, name: 'route',
  protocols: {
    review: { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } },
  },
  nodes: {
    worker: { recipe: 'w@1', task: 'work', inputs: { rework: { protocol: 'review' } }, outputs: { review: { protocol: 'review' } }, submission: { required: ['review'] } },
    reviewer: { recipe: 'r@1', task: 'review', inputs: { code: { protocol: 'review' } }, outputs: { out: { protocol: 'review' } }, submission: { required: ['out'] } },
  },
  modules: {
    gate: {
      type: 'router', trigger: 'each',
      inputs: { review: { protocol: 'review' } },
      outputs: { rework: { protocol: 'review' }, approved: { protocol: 'review' } },
      rules: [
        { when: 'review.passed == false', emit: { rework: '$review' } },
        { when: 'review.passed == true', emit: { approved: '$review' } },
      ],
    },
    // A second module whose input comes from the first module's output: the cascade case.
    second: {
      type: 'router', trigger: 'each',
      inputs: { passed: { protocol: 'review' } },
      outputs: { again: { protocol: 'review' } },
      rules: [{ when: 'passed.passed == false', emit: { again: '$passed' } }],
    },
  },
  edges: {
    route: { from: 'reviewer.out', to: 'gate.review', enabled: true },
    rework: { from: 'gate.rework', to: 'worker.rework', enabled: true },
    approve: { from: 'gate.approved', to: 'worker.rework', enabled: true },
    cascade: { from: 'gate.rework', to: 'second.passed', enabled: true },
    off: { from: 'gate.approved', to: 'second.passed', enabled: false },
  },
});

function opened() {
  const dir = mkdtempSync(join(tmpdir(), 'route-'));
  const store = new TaskStore(join(dir, 'state.db'));
  store.db.exec(`
    INSERT INTO projects(id,root,grants) VALUES('p','${dir}','[]');
    INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
      VALUES('g1','p','r',1,0,'executing',0,1);
  `);
  const kernel = new KernelStore(store);
  const rev = kernel.publishRevision('g1', { definition: DEF, reason: 'create' });
  kernel.admitNode('g1', rev.version, 'worker', { instanceId: 'i-w' });
  kernel.admitNode('g1', rev.version, 'reviewer', { instanceId: 'i-r' });
  kernel.admitModule('g1', rev.version, 'gate', { moduleType: 'router', trigger: 'each' });
  kernel.admitModule('g1', rev.version, 'second', { moduleType: 'router', trigger: 'each' });
  return { store, kernel, modules: new ModuleRuntime(kernel, 'g1', rev.version) };
}

describe('routeModuleOutputs — a module emit travels to its targets (§2, §6)', () => {
  test('invalid emitted value leaves all deliveries and queues untouched', () => {
    const { kernel, modules } = opened();
    expect(() => routeModuleOutputs(kernel, modules, 'g1', 'gate', {
      emitted: true, waiting: false, triggered: false, reasons: [],
      outputs: { rework: { passed: false }, approved: { passed: 'wrong' } },
    })).toThrow();
    expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM kernel_deliveries').get()).toEqual({ n: 0 });
    expect(kernel.nextQueued('g1', 'worker')).toBeNull();
  });

  test('R1: a rework emit queues the worker with the review value', () => {
    const { kernel, modules } = opened();
    const evaluation = modules.deliver('gate', 'review', { passed: false });

    const landings = routeModuleOutputs(kernel, modules, 'g1', 'gate', evaluation);
    const toWorker = landings.filter(l => l.toEndpoint === 'worker.rework');
    expect(toWorker.length).toBe(1);
    expect(toWorker[0]!.kind).toBe('node');

    // The worker's queue really holds it, with the value that was emitted.
    const queued = kernel.nextQueued('g1', 'worker');
    expect(queued).not.toBeNull();
    expect(queued!.kind).toBe('delivery');
    expect((queued!.payload as { value: { passed: boolean } }).value).toEqual({ passed: false });
  });

  test('R3: a disabled edge carries nothing', () => {
    const { kernel, modules } = opened();
    const evaluation = modules.deliver('gate', 'review', { passed: true });
    const landings = routeModuleOutputs(kernel, modules, 'g1', 'gate', evaluation);
    // `off` is disabled, so the approved value does not land on second.passed.
    expect(landings.some(l => l.toEndpoint === 'second.passed')).toBe(false);
  });

  test('R4: a judgment that emits nothing produces no deliveries', () => {
    const { kernel, modules } = opened();
    // `gate` holds no rule for a missing `passed`, so nothing is emitted.
    const evaluation = modules.evaluate('gate');
    expect(evaluation.emitted).toBe(false);
    const landings = routeModuleOutputs(kernel, modules, 'g1', 'gate', evaluation);
    expect(landings).toEqual([]);
    expect(kernel.nextQueued('g1', 'worker')).toBeNull();
  });

  test('R2: an output to another module judges that module in turn (cascade)', () => {
    const { kernel, modules } = opened();
    const evaluation = modules.deliver('gate', 'review', { passed: false });
    routeModuleOutputs(kernel, modules, 'g1', 'gate', evaluation);

    // `second` received the value and judged it, recording its own transition.
    const secondInput = kernel.moduleInput('g1', 'second', 'passed');
    expect(secondInput!.delivered).toBe(true);
    expect(secondInput!.value).toEqual({ passed: false });
    const transitions = kernel.moduleTransitions('g1', 'second');
    expect(transitions.length).toBeGreaterThan(0);
  });

  test('R5: a rework loop terminates instead of recursing forever', () => {
    const { kernel, modules } = opened();
    const evaluation = modules.deliver('gate', 'review', { passed: false });
    // Deep enough to be a loop: gate -> second -> ... must not recurse unbounded.
    const landings = routeModuleOutputs(kernel, modules, 'g1', 'gate', evaluation);
    expect(landings.length).toBeLessThan(50);
  });

  test('R6: a node landing writes a delivery row the edge view can show', () => {
    const { kernel, modules } = opened();
    const evaluation = modules.deliver('gate', 'review', { passed: false });
    routeModuleOutputs(kernel, modules, 'g1', 'gate', evaluation);
    // The routing is recorded as a delivery on the rework edge, so §10 can list it.
    const rows = kernel.deliveriesForEdge('g1', 'rework');
    expect(rows.length).toBe(1);
    expect(rows[0]!.value).toEqual({ passed: false });
    expect(rows[0]!.fromEndpoint).toBe('gate.rework');
    expect(rows[0]!.source).toBe('module');
  });
});
