import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { ModuleRuntime } from '../../src/core/module-runtime.ts';
import type { GraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §2, §4, §6 — trigger policy, reopen and module state.
 *
 * Failure modes first (R24):
 *   M1  `each` must re-judge on every accepted input update, including held inputs
 *   M2  after `once` fires, later input updates only change state — no repeat emit
 *   M3  reopen clears the latch only, keeps inputs, does NOT emit
 *   M4  a never-delivered input is not false/null
 *   M5  an evaluation defect keeps the inputs and pauses the module
 *   M6  each transition is recorded with rule version and reason (explainable)
 */

const stores: TaskStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const routerDefinition = (): GraphDefinition => ({
  schemaVersion: 2, name: 'mod',
  protocols: {
    'review-result': { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' }, reason: { type: 'string' } } },
  },
  nodes: {},
  modules: {
    'review-route': {
      type: 'router', trigger: 'each',
      inputs: { review: { protocol: 'review-result' } },
      outputs: { rework: { protocol: 'review-result' }, approved: { protocol: 'review-result' } },
      rules: [
        { when: 'review.passed == false', emit: { rework: '$review' } },
        { when: 'review.passed == true', emit: { approved: '$review' } },
      ],
    },
  },
  edges: {}, inputs: {}, outputs: {},
});

const onceDefinition = (): GraphDefinition => ({
  schemaVersion: 2, name: 'mod-once',
  protocols: { 'review-result': { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } } },
  nodes: {},
  modules: {
    'fan-in': {
      type: 'router', trigger: 'once', requiredInputs: ['a', 'b'],
      inputs: { a: { protocol: 'review-result' }, b: { protocol: 'review-result' } },
      outputs: { pair: { protocol: 'review-result' } },
      rules: [
        { when: '$exists(a) && $exists(b)', emit: { pair: { first: '$a', second: '$b' } } },
      ],
    },
  },
  edges: {}, inputs: {}, outputs: {},
});

async function kernelWith(definition: GraphDefinition, moduleId: string, trigger: 'each' | 'once') {
  const dir = await mkdtemp(join(tmpdir(), 'graph-module-'));
  dirs.push(dir);
  const store = new TaskStore(join(dir, 'state.db'));
  stores.push(store);
  const kernel = new KernelStore(store);
  store.db.prepare('INSERT OR IGNORE INTO projects(id,root,grants) VALUES(?,?,?)').run('p1', dir, '[]');
  store.db.prepare('INSERT OR IGNORE INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq) VALUES(?,?,?,?,?,?)').run('t1', 'p1', 'go', 1, 0, 1);
  const revision = kernel.publishRevision('t1', { definition, reason: 'plan' });
  kernel.admitModule('t1', revision.version, moduleId, { moduleType: 'router', trigger });
  return { kernel, runtime: new ModuleRuntime(kernel, 't1', revision.version) };
}

describe('ModuleRuntime — each re-judges on every update (§2)', () => {
  test('M1: each delivery over the same input is judged again, including the held input', async () => {
    const { kernel, runtime } = await kernelWith(routerDefinition(), 'review-route', 'each');
    const first = runtime.deliver('review-route', 'review', { passed: false, reason: 'nope' });
    expect(first.emitted).toBe(true);
    expect(first.outputs.rework).toEqual({ passed: false, reason: 'nope' });
    expect(first.outputs.approved).toBeUndefined();

    // A second, passing delivery is judged again and now approves.
    const second = runtime.deliver('review-route', 'review', { passed: true, reason: 'ok' });
    expect(second.emitted).toBe(true);
    expect(second.outputs.approved).toEqual({ passed: true, reason: 'ok' });
    expect(second.outputs.rework).toBeUndefined();

    // M6: both transitions are recorded with a reason.
    const transitions = kernel.moduleTransitions('t1', 'review-route');
    expect(transitions.length).toBe(2);
    expect(transitions[0]!.reason).toBe('review.passed == false');
    expect(transitions[1]!.reason).toBe('review.passed == true');
  });

  test('M4: with no delivery yet, the module waits instead of judging a missing input as false', async () => {
    const { runtime } = await kernelWith(routerDefinition(), 'review-route', 'each');
    const result = runtime.evaluate('review-route');
    expect(result.emitted).toBe(false);
    expect(result.waiting).toBe(true);
  });
});

describe('ModuleRuntime — once fires at most once until reopened (§2, §6)', () => {
  test('M2: after once fires, later input updates change state but emit nothing', async () => {
    const { runtime, kernel } = await kernelWith(onceDefinition(), 'fan-in', 'once');
    const waiting = runtime.deliver('fan-in', 'a', { passed: true });
    expect(waiting.emitted).toBe(false);
    expect(waiting.waiting).toBe(true);
    const fired = runtime.deliver('fan-in', 'b', { passed: false });
    expect(fired.emitted).toBe(true);
    expect(fired.outputs.pair).toEqual({ first: { passed: true }, second: { passed: false } });

    // A later update to `a` must NOT fire again; it only updates state.
    const later = runtime.deliver('fan-in', 'a', { passed: false });
    expect(later.emitted).toBe(false);
    expect(later.triggered).toBe(true);
    expect(kernel.moduleInput('t1', 'fan-in', 'a')?.value).toEqual({ passed: false });
  });

  test('M3: reopen clears the latch only, keeps both inputs, and does not emit', async () => {
    const { runtime, kernel } = await kernelWith(onceDefinition(), 'fan-in', 'once');
    runtime.deliver('fan-in', 'a', { passed: true });
    runtime.deliver('fan-in', 'b', { passed: true });

    const reopened = runtime.reopen('fan-in');
    expect(reopened.emitted).toBe(false);
    // Inputs survive the reopen.
    expect(kernel.moduleInput('t1', 'fan-in', 'a')?.value).toEqual({ passed: true });
    expect(kernel.moduleInput('t1', 'fan-in', 'b')?.value).toEqual({ passed: true });
    // Reopen alone does not fire; the next delivery judges with the held inputs.
    const next = runtime.deliver('fan-in', 'a', { passed: false });
    expect(next.emitted).toBe(true);
    expect(next.outputs.pair).toEqual({ first: { passed: false }, second: { passed: true } });
  });
});

describe('ModuleRuntime — a defect keeps inputs and pauses the module (§9)', () => {
  test('M5: a rule that cannot be parsed keeps the input and pauses the module', async () => {
    const bad = routerDefinition();
    bad.modules['review-route']!.rules = [{ when: 'review.passed == ==', emit: { rework: '$review' } }];
    const { runtime, kernel } = await kernelWith(bad, 'review-route', 'each');
    expect(() => runtime.deliver('review-route', 'review', { passed: false })).toThrow();
    expect(kernel.nodeState('t1', 'review-route').paused).toBe(true);
    expect(kernel.moduleInput('t1', 'review-route', 'review')?.value).toEqual({ passed: false });
  });
});
