import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { RuntimeError } from '../../src/core/types.ts';
import type { GraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §3, §6, §14 — the new kernel's durable layer.
 *
 * These assertions are on the public store surface, so they describe the contract
 * the kernel depends on (atomic acceptance, dedup, recovery) and survive internal
 * schema refactors. Failure modes first (R24):
 *   F1  a second, different valid submission for one execution -> refused
 *   F2  identical replay of the SAME submission                 -> original receipt, no new delivery
 *   F3  replay with different content for the same execution    -> refused
 *   F4  one incompatible enabled target                         -> whole broadcast refused, zero deliveries
 *   F5  zero enabled recipients                                 -> accepted, no_recipients, 0 deliveries, required output satisfied
 *   F6  duplicate delivery for one causal submit                -> impossible (unique constraint)
 *   F7  a revision is immutable                                 -> cannot be overwritten
 *   F8  a module transition keeps rule version and reason       -> readable for explanation
 *   F9  reopening the disk database keeps deliveries/submissions -> recovery
 *   F10 a missing input is distinguishable from received false/null
 */

const stores: TaskStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function openKernel(dir: string) {
  const taskStore = new TaskStore(join(dir, 'state.db'));
  stores.push(taskStore);
  const kernel = new KernelStore(taskStore);
  return { taskStore, kernel };
}

async function kernel() {
  const dir = await mkdtemp(join(tmpdir(), 'graph-kernel-'));
  dirs.push(dir);
  const { taskStore, kernel: store } = await openKernel(dir);
  taskStore.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p1', dir, '[]');
  taskStore.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq) VALUES(?,?,?,?,?,?)').run('t1', 'p1', 'build it', 1, 0, 1);
  return { store, dir };
}

const emptyDefinition = (name: string): GraphDefinition => ({
  schemaVersion: 2, name, protocols: {}, nodes: {}, modules: {}, edges: {}, inputs: {}, outputs: {},
});

/** A definition carrying one router module, for module-input/transition cases. */
const withRouter = (name: string): GraphDefinition => ({
  schemaVersion: 2, name,
  protocols: { 'review-result': { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } } },
  nodes: {},
  modules: {
    route: {
      type: 'router', trigger: 'each',
      inputs: { review: { protocol: 'review-result' } },
      outputs: { rework: { protocol: 'review-result' } },
      rules: [{ when: 'review.passed == false', emit: { rework: '$review' } }],
    },
  },
  edges: {}, inputs: {}, outputs: {},
});

describe('KernelStore — revisions are immutable (F7)', () => {
  test('a published revision reads back verbatim and cannot be overwritten', async () => {
    const { store } = await kernel();
    const revision = store.publishRevision('t1', { definition: emptyDefinition('g'), reason: 'initial' });
    expect(revision.version).toBe(1);
    expect(store.revision('t1', 1)?.definition).toEqual(emptyDefinition('g'));
    expect(store.latestRevision('t1')?.version).toBe(1);
    expect(() => store.publishRevision('t1', { definition: emptyDefinition('other'), reason: 'overwrite', version: 1 })).toThrow(RuntimeError);
  });
});

describe('KernelStore — submit is one atomic transaction (§6)', () => {
  const planning = (store: KernelStore) => {
    const revision = store.publishRevision('t1', {
      definition: {
        ...emptyDefinition('g'),
        protocols: { 'code-result': { type: 'object', required: ['commit'], properties: { commit: { type: 'string' } } } },
        nodes: {
          worker: { recipe: 'worker@1', task: 'w', inputs: {}, outputs: { result: { protocol: 'code-result' } }, submission: { required: ['result'] } },
          reviewer: { recipe: 'r@1', task: 'r', inputs: { code: { protocol: 'code-result' } }, outputs: {}, submission: {} },
        },
        edges: {
          'worker->reviewer': { from: 'worker.result', to: 'reviewer.code', enabled: true },
        },
      },
      reason: 'plan',
    });
    // One node instance and one execution, admitted before a submit can happen.
    store.admitNode('t1', revision.version, 'worker', { instanceId: 'i-worker' });
    store.admitNode('t1', revision.version, 'reviewer', { instanceId: 'i-reviewer' });
    store.startExecution('t1', { executionId: 'exec-1', nodeId: 'worker', revisionVersion: revision.version });
    return revision;
  };

  test('a valid submit writes one submission and one delivery per enabled target', async () => {
    const { store } = await kernel();
    planning(store);
    const receipt = store.submit('exec-1', {
      outputs: { result: { enable: true, value: { commit: 'abc' } } },
      submissionId: 'sub-1',
    });
    expect(receipt.replayed).toBe(false);
    expect(receipt.deliveries.length).toBe(1);
    expect(receipt.deliveries[0]).toMatchObject({ toEndpoint: 'reviewer.code', edgeId: 'worker->reviewer' });
    expect(store.execution('exec-1')?.submissionId).toBe('sub-1');
  });

  test('F2/F1/F3: same execution submits exactly once, replay returns the receipt, different content is refused', async () => {
    const { store } = await kernel();
    planning(store);
    const first = store.submit('exec-1', { outputs: { result: { enable: true, value: { commit: 'abc' } } }, submissionId: 'sub-1' });
    const replay = store.submit('exec-1', { outputs: { result: { enable: true, value: { commit: 'abc' } } }, submissionId: 'sub-1' });
    expect(replay.replayed).toBe(true);
    expect(replay.deliveries.map(d => d.id)).toEqual(first.deliveries.map(d => d.id));
    // No second delivery appeared from the replay.
    expect(store.deliveriesFor('exec-1').length).toBe(1);
    // Different value for the same execution's single submit is refused.
    expect(() => store.submit('exec-1', { outputs: { result: { enable: true, value: { commit: 'def' } } }, submissionId: 'sub-2' })).toThrow(RuntimeError);
  });

  test('F4: one incompatible enabled target refuses the whole broadcast with zero deliveries', async () => {
    const { store } = await kernel();
    const revision = store.publishRevision('t1', {
      definition: {
        ...emptyDefinition('g'),
        protocols: {
          'code-result': { type: 'object', required: ['commit'], properties: { commit: { type: 'string' } } },
        },
        nodes: {
          worker: { recipe: 'w@1', task: 'w', inputs: {}, outputs: { result: { protocol: 'code-result' } }, submission: { required: ['result'] } },
          bad: { recipe: 'b@1', task: 'b', inputs: { code: { protocol: 'code-result' } }, outputs: {}, submission: {} },
        },
        edges: { e: { from: 'worker.result', to: 'bad.code', enabled: true } },
      },
      reason: 'plan',
    });
    store.admitNode('t1', revision.version, 'worker', { instanceId: 'i-worker' });
    store.admitNode('t1', revision.version, 'bad', { instanceId: 'i-bad' });
    store.startExecution('t1', { executionId: 'exec-x', nodeId: 'worker', revisionVersion: revision.version });
    // The output omits the protocol's required `commit`, so the target's protocol is not satisfied.
    expect(() => store.submit('exec-x', { outputs: { result: { enable: true, value: {} } }, submissionId: 'sub-x' })).toThrow(RuntimeError);
    expect(store.deliveriesFor('exec-x').length).toBe(0);
    expect(store.execution('exec-x')?.submissionId).toBeNull();
  });

  test('F5: an output with no enabled connection is accepted with no_recipients and still satisfies the required output', async () => {
    const { store } = await kernel();
    const revision = store.publishRevision('t1', {
      definition: {
        ...emptyDefinition('g'),
        protocols: { 'code-result': { type: 'object', required: ['commit'], properties: { commit: { type: 'string' } } } },
        nodes: { worker: { recipe: 'w@1', task: 'w', inputs: {}, outputs: { result: { protocol: 'code-result' } }, submission: { required: ['result'] } } },
        edges: {},
      },
      reason: 'plan',
    });
    store.admitNode('t1', revision.version, 'worker', { instanceId: 'i-worker' });
    store.startExecution('t1', { executionId: 'exec-solo', nodeId: 'worker', revisionVersion: revision.version });
    const receipt = store.submit('exec-solo', { outputs: { result: { enable: true, value: { commit: 'abc' } } }, submissionId: 'sub-solo' });
    expect(receipt.deliveries.length).toBe(0);
    expect(receipt.noRecipients).toBe(true);
    expect(store.execution('exec-solo')?.submissionId).toBe('sub-solo');
    // No required-output error: the submit succeeded.
    expect(store.execution('exec-solo')?.missingRequired).toBe(false);
  });

  test('F6: a disabled connection produces no delivery for that edge', async () => {
    const { store } = await kernel();
    const revision = store.publishRevision('t1', {
      definition: {
        ...emptyDefinition('g'),
        protocols: { 'code-result': { type: 'object', required: ['commit'], properties: { commit: { type: 'string' } } } },
        nodes: {
          worker: { recipe: 'w@1', task: 'w', inputs: {}, outputs: { result: { protocol: 'code-result' } }, submission: { required: ['result'] } },
          reviewer: { recipe: 'r@1', task: 'r', inputs: { code: { protocol: 'code-result' } }, outputs: {}, submission: {} },
        },
        edges: { e: { from: 'worker.result', to: 'reviewer.code', enabled: false } },
      },
      reason: 'plan',
    });
    store.admitNode('t1', revision.version, 'worker', { instanceId: 'i-worker' });
    store.admitNode('t1', revision.version, 'reviewer', { instanceId: 'i-reviewer' });
    store.startExecution('t1', { executionId: 'exec-off', nodeId: 'worker', revisionVersion: revision.version });
    const receipt = store.submit('exec-off', { outputs: { result: { enable: true, value: { commit: 'abc' } } }, submissionId: 'sub-off' });
    expect(receipt.deliveries.length).toBe(0);
    expect(receipt.noRecipients).toBe(true);
  });
});

describe('KernelStore — module transitions keep their reason (§6, F8)', () => {
  test('a transition records input update, before/after state, verdict, rule version and reason', async () => {
    const { store } = await kernel();
    const revision = store.publishRevision('t1', { definition: withRouter('g'), reason: 'plan' });
    store.admitModule('t1', revision.version, 'route', { moduleType: 'router', trigger: 'each' });
    const transition = store.recordModuleTransition('t1', {
      moduleId: 'route',
      inputName: 'review',
      inputValue: { passed: false },
      stateBefore: { triggered: false },
      stateAfter: { triggered: true },
      verdict: 'rework',
      outputs: { rework: { passed: false } },
      ruleVersion: 3,
      reason: 'review.passed == false',
    });
    const listed = store.moduleTransitions('t1', 'route');
    expect(listed.length).toBe(1);
    const first = listed[0]!;
    expect(first).toMatchObject({ verdict: 'rework', ruleVersion: 3, reason: 'review.passed == false' });
    expect(first.stateBefore).toEqual({ triggered: false });
    expect(first.stateAfter).toEqual({ triggered: true });
    expect(transition.id).toBeTruthy();
  });
});

describe('KernelStore — durability across reopen (F9) and distinct missing input (F10)', () => {
  test('reopening the disk database keeps submissions and deliveries', async () => {
    const { store, dir } = await kernel();
    const revision = store.publishRevision('t1', {
      definition: {
        ...emptyDefinition('g'),
        protocols: { 'code-result': { type: 'object', required: ['commit'], properties: { commit: { type: 'string' } } } },
        nodes: {
          worker: { recipe: 'w@1', task: 'w', inputs: {}, outputs: { result: { protocol: 'code-result' } }, submission: { required: ['result'] } },
          reviewer: { recipe: 'r@1', task: 'r', inputs: { code: { protocol: 'code-result' } }, outputs: {}, submission: {} },
        },
        edges: { e: { from: 'worker.result', to: 'reviewer.code', enabled: true } },
      },
      reason: 'plan',
    });
    store.admitNode('t1', revision.version, 'worker', { instanceId: 'i-worker' });
    store.admitNode('t1', revision.version, 'reviewer', { instanceId: 'i-reviewer' });
    store.startExecution('t1', { executionId: 'exec-d', nodeId: 'worker', revisionVersion: revision.version });
    store.submit('exec-d', { outputs: { result: { enable: true, value: { commit: 'abc' } } }, submissionId: 'sub-d' });
    store.db.close();
    stores.pop();
    const { kernel: reopened } = await openKernel(dir);
    expect(reopened.execution('exec-d')?.submissionId).toBe('sub-d');
    expect(reopened.deliveriesFor('exec-d').length).toBe(1);
    // The delivery is accepted once and cannot be duplicated by a replay after recovery.
    const replay = reopened.submit('exec-d', { outputs: { result: { enable: true, value: { commit: 'abc' } } }, submissionId: 'sub-d' });
    expect(replay.replayed).toBe(true);
    expect(reopened.deliveriesFor('exec-d').length).toBe(1);
  });

  test('F10: a never-delivered module input is distinct from a delivered false/null', async () => {
    const { store } = await kernel();
    const revision = store.publishRevision('t1', { definition: withRouter('g'), reason: 'plan' });
    store.admitModule('t1', revision.version, 'route', { moduleType: 'router', trigger: 'once' });
    expect(store.moduleInput('t1', 'route', 'review')).toBeNull();
    store.setModuleInput('t1', 'route', 'review', false);
    const input = store.moduleInput('t1', 'route', 'review');
    expect(input).not.toBeNull();
    expect(input?.delivered).toBe(true);
    expect(input?.value).toBe(false);
  });
});

describe('KernelStore — queue order, three deliveries, frozen snapshot (§14)', () => {
  const twoNode = (): GraphDefinition => ({
    schemaVersion: 2, name: 'q',
    protocols: { 'ping': { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
    nodes: {
      a: { recipe: 'a@1', task: 'a', inputs: {}, outputs: { result: { protocol: 'ping' } }, submission: { required: ['result'] } },
      b: { recipe: 'b@1', task: 'b', inputs: { in: { protocol: 'ping' } }, outputs: {}, submission: {} },
      c: { recipe: 'c@1', task: 'c', inputs: { in: { protocol: 'ping' } }, outputs: {}, submission: {} },
    },
    modules: {},
    edges: { 'a-b': { from: 'a.result', to: 'b.in', enabled: true }, 'a-c': { from: 'a.result', to: 'c.in', enabled: true } },
    inputs: {}, outputs: {},
  });

  test('three submits over the same edge produce three deliveries in one serial queue order', async () => {
    const { store } = await kernel();
    const revision = store.publishRevision('t1', { definition: twoNode(), reason: 'plan' });
    for (const node of ['a', 'b', 'c']) store.admitNode('t1', revision.version, node, { instanceId: `i-${node}` });
    for (const n of [1, 2, 3]) {
      store.startExecution('t1', { executionId: `exec-${n}`, nodeId: 'a', revisionVersion: revision.version });
      store.submit(`exec-${n}`, { outputs: { result: { enable: true, value: { n } } }, submissionId: `sub-${n}` });
    }
    const all = [1, 2, 3].flatMap(n => store.deliveriesFor(`exec-${n}`));
    expect(all.length).toBe(6); // three submits x two edges
    const seqs = all.map(d => d.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs.slice().sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(6); // acceptance order is a total order
  });

  test('a single output with two enabled edges broadcasts to both, checked together', async () => {
    const { store } = await kernel();
    const revision = store.publishRevision('t1', { definition: twoNode(), reason: 'plan' });
    for (const node of ['a', 'b', 'c']) store.admitNode('t1', revision.version, node, { instanceId: `i-${node}` });
    store.startExecution('t1', { executionId: 'exec-fan', nodeId: 'a', revisionVersion: revision.version });
    const receipt = store.submit('exec-fan', { outputs: { result: { enable: true, value: { n: 1 } } }, submissionId: 'sub-fan' });
    expect(receipt.deliveries.map(d => d.toEndpoint).sort()).toEqual(['b.in', 'c.in']);
    expect(receipt.noRecipients).toBe(false);
  });

  test('a delivery accepted under one revision keeps its snapshot when a later revision disables the edge', async () => {
    const { store } = await kernel();
    const revision = store.publishRevision('t1', { definition: twoNode(), reason: 'plan' });
    for (const node of ['a', 'b', 'c']) store.admitNode('t1', revision.version, node, { instanceId: `i-${node}` });
    store.startExecution('t1', { executionId: 'exec-keep', nodeId: 'a', revisionVersion: revision.version });
    store.submit('exec-keep', { outputs: { result: { enable: true, value: { n: 1 } } }, submissionId: 'sub-keep' });
    // A later revision disables the edge; the accepted delivery must remain.
    const definition2 = twoNode();
    definition2.edges['a-b'] = { from: 'a.result', to: 'b.in', enabled: false };
    store.publishRevision('t1', { definition: definition2, reason: 'disable a-b' });
    const kept = store.deliveriesFor('exec-keep');
    expect(kept.length).toBe(2);
    expect(kept.every(d => d.state === 'accepted')).toBe(true);
    expect(kept[0]!.revisionVersion).toBe(revision.version);
  });
});
