import { kernelNodeRun } from '../../src/core/kernel-views.ts';
import { RuntimeError } from '../../src/core/types.ts';
import { recoverKernelExecutions } from '../../src/core/kernel-recovery.ts';
import { kernelProviderGate, reconcileKernelUsage } from '../../src/runtime/kernel-provider-gate.ts';
import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { NodeQueue } from '../../src/core/node-queue.ts';
import { NodeExecutor, type ExecutorHost } from '../../src/core/node-executor.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §7, §8 + HB-252 — the node execution loop.
 *
 * Failure modes first (R24):
 *   X1  a turn that submits validly settles the item and the execution
 *   X2  a turn that ends without a valid submission spends one RETRY and re-turns
 *       the SAME execution
 *   X3  once the retry budget is spent the node fails and its queue pauses
 *   X4  a submission missing a required output is answered with a structured
 *       missing-required injection into the SAME execution (a RESUBMIT, counted
 *       separately from retries)
 *   X5  once the resubmit budget is spent the node fails
 *   X6  a node never runs two executions at once
 *   X7  a crashed process is rebuilt and the turn resumes on the same execution
 */

const DEF = parseGraphDefinition({
  schemaVersion: 2, name: 'loop',
  protocols: { out: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } },
  nodes: { n1: { recipe: 'r@1', task: 'do', inputs: {}, outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } } },
  modules: {}, edges: {},
});

function opened(): { store: TaskStore; kernel: KernelStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'exec-'));
  const store = new TaskStore(join(dir, 'state.db'));
  store.db.prepare('INSERT OR IGNORE INTO projects(id,root,grants) VALUES(?,?,?)').run('p1', dir, '[]');
  return { store, kernel: new KernelStore(store), dir };
}

/** A fake resident host: liveness only; the turn itself is scripted by the test. */
function fakeHost(alive = true): ExecutorHost & { restarts: number } {
  const host = {
    restarts: 0,
    async start() { host.restarts += 1; host.live = true; return { processId: 1 }; },
    alive() { return host.live; },
    async turn() { throw new Error('the executor drives turns through its runner, not the host'); },
    live: alive,
  };
  return host as unknown as ExecutorHost & { restarts: number };
}

describe('NodeExecutor — turn → submit → retry/resubmit (HB-252)', () => {
  test('X1: a valid submit settles the item and completes the execution', async () => {
    const { kernel } = opened();
    const graphId = 'g1';
    kernel.store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES(?,?,?,?,?,?,?)').run(graphId, 'p1', 'r', 1, 0, 1, 'running');
    const rev = kernel.publishRevision(graphId, { definition: DEF, reason: 'create' });
    kernel.admitNode(graphId, rev.version, 'n1', { instanceId: 'i1' });
    const queue = new NodeQueue(kernel, graphId);
    queue.enqueue({ nodeId: 'n1', kind: 'delivery', input: 'in', value: { go: true } as never });

    const host = fakeHost();
    const exec = new NodeExecutor({ kernel, graphId, host });
    const outcome = await exec.runNode('n1', async (executionId, attempt) => {
      if (attempt === 1) kernel.submit(executionId, { outputs: { out: { enable: true, value: { ok: true } } }, submissionId: 's1' });
    });

    expect(outcome).toBe('done');
    expect(executionIdOf(kernel, graphId)).toMatch(/^exec-/);
    expect(kernel.nodeState(graphId, 'n1').paused).toBe(false);
    expect(kernel.nextQueued(graphId, 'n1')).toBeNull();
  });

  test('X2/X3: retries re-turn the same execution, then the node fails and pauses', async () => {
    const { kernel } = opened();
    const graphId = 'g2';
    kernel.store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES(?,?,?,?,?,?,?)').run(graphId, 'p1', 'r', 1, 0, 1, 'running');
    const rev = kernel.publishRevision(graphId, { definition: DEF, reason: 'create' });
    kernel.admitNode(graphId, rev.version, 'n1', { instanceId: 'i1' });
    new NodeQueue(kernel, graphId).enqueue({ nodeId: 'n1', kind: 'delivery', input: 'in', value: { go: true } as never });

    const host = fakeHost();
    let turns = 0;
    const exec = new NodeExecutor({ kernel, graphId, host });
    // Three attempts, none submit.
    const outcome = await exec.runNode('n1', async () => { turns += 1; });

    expect(turns).toBe(3); // 1 attempt + 2 retries
    expect(outcome).toBe('failed');
    expect(kernel.nodeState(graphId, 'n1').paused).toBe(true);
  });

  test('X4/X5: a missing-required submit injects the gap into the same execution', async () => {
    const { kernel } = opened();
    const graphId = 'g4';
    kernel.store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES(?,?,?,?,?,?,?)').run(graphId, 'p1', 'r', 1, 0, 1, 'running');
    const rev = kernel.publishRevision(graphId, { definition: DEF, reason: 'create' });
    kernel.admitNode(graphId, rev.version, 'n1', { instanceId: 'i1' });
    new NodeQueue(kernel, graphId).enqueue({ nodeId: 'n1', kind: 'delivery', input: 'in', value: { go: true } as never });

    const host = fakeHost();
    const injections: string[][] = [];
    const exec = new NodeExecutor({ kernel, graphId, host });
    const outcome = await exec.runNode('n1', async (executionId, attempt, injection) => {
      if (injection) injections.push(injection.missing);
      // First two turns report the same missing-required gap; the resubmit budget is 1.
      if (attempt === 1 || attempt === 2) return { missing: ['out'] };
    });

    expect(injections.flat()).toContain('out');
    expect(outcome).toBe('failed'); // returned the gap but never filled it, budget spent
  });

  test.each([true, false])('restart preserves the automatic retry allowance with budget snapshot %s', async withBudget => {
    const { kernel, store, dir } = opened();
    store.db.prepare('INSERT INTO tasks(id,project_id,request,phase,created_seq) VALUES(?,?,?,?,?)').run('restart', 'p1', 'r', 'running', 1);
    const revision = kernel.publishRevision('restart', { definition: DEF, reason: 'create' });
    kernel.admitNode('restart', revision.version, 'n1', { instanceId: 'instance' });
    const item = new NodeQueue(kernel, 'restart').enqueue({ nodeId: 'n1', kind: 'delivery', input: 'in', value: null });
    const id = `exec-restart-n1-${item.seq}`;
    kernel.startExecution('restart', { executionId: id, nodeId: 'n1', revisionVersion: revision.version, ...(withBudget ? { tokenBudget: { budget: 1000, unlimited: false } } : {}) });
    kernel.noteExecutionAttempt(id);
    kernel.noteExecutionContinuation(id, 'retry');
    kernel.noteExecutionAttempt(id);
    kernel.noteExecutionContinuation(id, 'retry');
    kernel.finishExecution(id, 'blocked');
    store.close();
    const reopened = new TaskStore(join(dir, 'state.db'));
    try {
      const recovered = new KernelStore(reopened);
      const changed = structuredClone(DEF); changed.nodes.n1!.task = 'new task for later executions';
      changed.nodes.n1!.retry = { automatic: 0, resubmit: 0 };
      recovered.publishRevision('restart', { definition: changed, reason: 'changed while interrupted' });
      let turns = 0;
      const prepared: number[] = [];
      const outcome = await new NodeExecutor({ kernel: recovered, graphId: 'restart', tokenBudget: { budget: 10000, unlimited: false }, reserveTokens: 100,
        host: async (_executionId, revisionVersion) => { prepared.push(revisionVersion); return fakeHost(); },
      }).runNode('n1', async () => { turns += 1; return { usage: { total: 1 } }; });
      if (!withBudget) {
        expect(outcome).toBe('blocked');
        expect(prepared).toEqual([]);
        expect(turns).toBe(0);
        expect(recovered.execution(id)).toMatchObject({ tokenBudget: null, attempt: 2, retriesUsed: 2 });
        expect(recovered.nextQueued('restart', 'n1')?.seq).toBe(item.seq);
        expect(recovered.nodeState('restart', 'n1').paused).toBe(true);
        return;
      }
      expect(recovered.execution(id)?.tokenBudget).toEqual({ budget: 1000, unlimited: false });
      expect(prepared).toEqual([1]);
      expect(outcome).toBe('failed');
      expect(turns).toBe(1);
      expect(recovered.execution(id)?.attempt).toBe(3);
      expect(recovered.execution(id)?.retriesUsed).toBe(2);
    } finally { reopened.close(); }
  });

  test('X6: runNode drains the node queue one execution at a time', async () => {
    const { kernel } = opened();
    const graphId = 'g6';
    kernel.store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES(?,?,?,?,?,?,?)').run(graphId, 'p1', 'r', 1, 0, 1, 'running');
    const rev = kernel.publishRevision(graphId, { definition: DEF, reason: 'create' });
    kernel.admitNode(graphId, rev.version, 'n1', { instanceId: 'i1' });
    const queue = new NodeQueue(kernel, graphId);
    queue.enqueue({ nodeId: 'n1', kind: 'delivery', input: 'in', value: { a: 1 } as never });
    queue.enqueue({ nodeId: 'n1', kind: 'delivery', input: 'in', value: { a: 2 } as never });

    const host = fakeHost();
    let running = 0;
    let maxRunning = 0;
    const exec = new NodeExecutor({ kernel, graphId, host });
    const outcome = await exec.runNode('n1', async (executionId) => {
      running += 1; maxRunning = Math.max(maxRunning, running);
      kernel.submit(executionId, { outputs: { out: { enable: true, value: { ok: true } } }, submissionId: `s-${executionId}` });
      running -= 1;
    });

    expect(outcome).toBe('done');
    expect(maxRunning).toBe(1); // never two executions at once
    expect(kernel.nextQueued(graphId, 'n1')).toBeNull(); // both drained
  });

  test('X7: a dead process is rebuilt and the same execution resumes', async () => {
    const { kernel } = opened();
    const graphId = 'g7';
    kernel.store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES(?,?,?,?,?,?,?)').run(graphId, 'p1', 'r', 1, 0, 1, 'running');
    const rev = kernel.publishRevision(graphId, { definition: DEF, reason: 'create' });
    kernel.admitNode(graphId, rev.version, 'n1', { instanceId: 'i1' });
    new NodeQueue(kernel, graphId).enqueue({ nodeId: 'n1', kind: 'delivery', input: 'in', value: { go: true } as never });

    const host = fakeHost(false); // the process is dead before the first turn
    const seen: string[] = [];
    const exec = new NodeExecutor({ kernel, graphId, host });
    const outcome = await exec.runNode('n1', async (executionId, attempt) => {
      seen.push(executionId);
      if (attempt === 1) return; // crash before submitting
      kernel.submit(executionId, { outputs: { out: { enable: true, value: { ok: true } } }, submissionId: 's1' });
    });

    expect(host.restarts).toBeGreaterThan(0); // the host was rebuilt
    expect(new Set(seen).size).toBe(1); // both turns ran the SAME execution
    expect(outcome).toBe('done');
  });
});

function executionIdOf(kernel: KernelStore, taskId: string): string {
  const row = kernel.db.prepare('SELECT id FROM kernel_executions WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as { id: string } | undefined;
  return row?.id ?? '';
}


test('provider gate charges each send before a follow-up, refuses exhausted budget and retains unknown usage', () => {
  const { kernel, store } = opened();
  store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq) VALUES(?,?,?,?,?,?)').run('t1', 'p1', 'do', 1, 0, 1);
  kernel.publishRevision('t1', { definition: DEF, reason: 'test' });
  kernel.admitNode('t1', 1, 'n1', { instanceId: 'i' });
  kernel.startExecution('t1', { executionId: 'x', nodeId: 'n1', revisionVersion: 1 });
  kernel.reserveNodeTokens('t1', 'n1', { budget: 100, unlimited: false }, 100);
  const gate = kernelProviderGate(kernel, 't1', 'n1', { budget: 100, unlimited: false });
  let sends = 0;
  gate.dispatch('first', 60, () => sends++);
  gate.settle('first', { input: 30, output: 35, cacheRead: 0, cacheWrite: 0 });
  expect(() => gate.dispatch('second', 40, () => sends++)).toThrow(/budget/);
  expect(sends).toBe(1);
  expect(kernel.budgetState('t1', 'n1', { budget: 100, unlimited: false }).used).toBe(65);
  gate.dispatch('unknown', 10, () => sends++);
  gate.settle('unknown', null);
  expect(() => gate.dispatch('third', 1, () => sends++)).toThrow(/unknown/);
  expect(sends).toBe(2);
  expect(kernel.db.prepare('SELECT state FROM kernel_provider_calls WHERE id=?').get('unknown')).toEqual({ state: 'unknown' });
  store.db.close();
});


test('runtime recovery retains input, attempt counters and unknown provider holds; reconciliation is explicit and idempotent', () => {
  const { kernel, store } = opened();
  store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq) VALUES(?,?,?,?,?,?)').run('t1', 'p1', 'do', 1, 0, 1);
  kernel.publishRevision('t1', { definition: DEF, reason: 'test' });
  kernel.admitNode('t1', 1, 'n1', { instanceId: 'i' });
  const queued = kernel.enqueue('t1', { nodeId: 'n1', kind: 'chat', payload: { text: 'retained input' } });
  kernel.claimQueued('t1', queued.seq);
  kernel.startExecution('t1', { executionId: 'x', nodeId: 'n1', revisionVersion: 1 });
  kernel.noteExecutionAttempt('x');
  kernel.noteExecutionContinuation('x', 'retry');
  kernel.reserveNodeTokens('t1', 'n1', { budget: 100, unlimited: false }, 100);
  kernelProviderGate(kernel, 't1', 'n1', { budget: 100, unlimited: false }).dispatch('lost', 40, () => undefined);
  expect(recoverKernelExecutions(kernel)).toBe(1);
  expect(recoverKernelExecutions(kernel)).toBe(0);
  expect(kernel.execution('x')).toMatchObject({ state: 'blocked', attempt: 1, retriesUsed: 1 });
  expect(kernel.nextQueued('t1', 'n1')).toMatchObject({ payload: { text: 'retained input' } });
  expect(kernel.nodeState('t1', 'n1').paused).toBe(true);
  const usage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 };
  expect(reconcileKernelUsage(kernel, 't1', 'lost', usage).replayed).toBe(false);
  expect(reconcileKernelUsage(kernel, 't1', 'lost', usage).replayed).toBe(true);
  expect(kernel.budgetState('t1', 'n1', { budget: 100, unlimited: false })).toMatchObject({ used: 30, reserved: 0 });
  expect(kernel.nodeState('t1', 'n1').paused).toBe(true);
  store.db.close();
});


test('a missing review model parks the input without consuming automatic retries or token holds', async () => {
  const { kernel, store } = opened();
  try {
    store.db.prepare("INSERT INTO tasks(id,project_id,request,phase,created_seq) VALUES('model-block','p1','review','running',1)").run();
    kernel.publishRevision('model-block', { definition: DEF, reason: 'review' });
    kernel.admitNode('model-block', 1, 'n1', { instanceId: 'reviewer' });
    const item = kernel.enqueue('model-block', { nodeId: 'n1', kind: 'delivery', payload: { input: 'in', value: null } });
    let turns = 0;
    const outcome = await new NodeExecutor({ kernel, graphId: 'model-block',
      tokenBudget: { budget: 1000, unlimited: false }, reserveTokens: 100,
      host: async () => { throw new RuntimeError('model_selection', 'No independent review model'); },
    }).runNode('n1', async () => { turns += 1; });
    expect(outcome).toBe('blocked');
    expect(turns).toBe(0);
    expect(kernel.nextQueued('model-block', 'n1')?.seq).toBe(item.seq);
    expect(kernel.execution(executionIdOf(kernel, 'model-block'))?.retriesUsed).toBe(0);
    expect(kernel.budgetState('model-block', 'n1', { budget: 1000, unlimited: false }).reserved).toBe(0);
    expect(kernel.nodeState('model-block', 'n1').paused).toBe(true);
  } finally { store.close(); }
});

test.each(['throw', 'unknown-result'])('a submitted execution with %s and unknown usage cannot replay its original input', async mode => {
  const { kernel, store } = opened();
  try {
    store.db.prepare("INSERT INTO tasks(id,project_id,request,phase,created_seq) VALUES('submitted','p1','work','running',1)").run();
    kernel.publishRevision('submitted', { definition: DEF, reason: 'work' });
    kernel.admitNode('submitted', 1, 'n1', { instanceId: 'worker' });
    const queue = new NodeQueue(kernel, 'submitted');
    const item = queue.enqueue({ nodeId: 'n1', kind: 'delivery', input: 'in', value: null });
    const executor = new NodeExecutor({ kernel, graphId: 'submitted', host: fakeHost(),
      tokenBudget: { budget: 1000, unlimited: false }, reserveTokens: 100 });
    let turns = 0;
    let forbiddenSends = 0;
    let budgetError: string | undefined;
    const outcome = await executor.runNode('n1', async executionId => {
      turns += 1;
      kernel.submit(executionId, { outputs: { out: { enable: true, value: { ok: true } } }, submissionId: 'landed' });
      const gate = kernelProviderGate(kernel, 'submitted', 'n1', { budget: 10000, unlimited: false });
      try { gate.dispatch('over-frozen-budget', 1100, () => forbiddenSends++); }
      catch (error) { budgetError = String(error); }
      gate.dispatch('unknown-after-submit', 50, () => undefined);
      gate.settle('unknown-after-submit', null);
      if (mode === 'throw') throw new Error('process exited after sending output');
    });
    expect(outcome).toBe('failed');
    expect(kernel.execution(executionIdOf(kernel, 'submitted'))).toMatchObject({ state: 'failed', submissionId: 'landed', retriesUsed: 0 });
    expect(kernel.db.prepare('SELECT state FROM kernel_queue WHERE seq=?').get(item.seq)).toEqual({ state: 'failed' });
    queue.resume('n1');
    expect(await executor.runNode('n1', async () => { turns += 1; })).toBe('idle');
    expect(turns).toBe(1);
    expect(budgetError).toMatch(/budget/);
    expect(forbiddenSends).toBe(0);
    expect(kernel.providerCalls('submitted')[0]?.state).toBe('unknown');
    expect(kernel.budgetState('submitted', 'n1', { budget: 1000, unlimited: false }).reserved).toBe(100);
    const overview = kernelNodeRun(kernel, 'submitted', 'n1', {});
    expect(overview.instance).toMatchObject({ budget: 1000, unlimited: false, reserved: 100 });
    expect(overview.operations[0]).toMatchObject({ reserved: 100, waitingMs: null, runMs: null });
    expect(overview.invocations[0]).toMatchObject({ reserved: 50, state: 'unknown' });
    expect(kernel.execution(executionIdOf(kernel, 'submitted'))).toMatchObject({ tokenBudget: { budget: 1000, unlimited: false } });
  } finally { store.close(); }
});


test.each(['error', 'missing'].flatMap(mode => ['node', 'graph'].map(scope => ({ mode, scope }))))('declared $scope $mode retry limits stay frozen for current work and change on the next execution', async ({ mode, scope }) => {
  const { kernel, store } = opened();
  try {
    store.db.prepare("INSERT INTO tasks(id,project_id,request,phase,created_seq) VALUES('retry-config','p1','work','running',1)").run();
    const first = structuredClone(DEF);
    if (scope === 'node') first.nodes.n1!.retry = { automatic: 1, resubmit: 1 };
    else first.defaults = { retry: { automatic: 1, resubmit: 1 } };
    kernel.publishRevision('retry-config', { definition: first, reason: 'configured' });
    kernel.admitNode('retry-config', 1, 'n1', { instanceId: 'worker' });
    const queue = new NodeQueue(kernel, 'retry-config');
    queue.enqueue({ nodeId: 'n1', kind: 'delivery', input: 'in', value: null });
    const executor = new NodeExecutor({ kernel, graphId: 'retry-config', host: fakeHost() });
    let turns = 0;
    const fail = async () => {
      turns += 1;
      if (turns === 1) {
        const next = structuredClone(first);
        if (scope === 'node') next.nodes.n1!.retry = { automatic: 0, resubmit: 0 };
        else next.defaults = { retry: { automatic: 0, resubmit: 0 } };
        kernel.publishRevision('retry-config', { definition: next, reason: 'next execution' });
      }
      if (mode === 'error') throw new Error('execution failed');
      return { missing: ['out'] };
    };
    expect(await executor.runNode('n1', fail)).toBe('failed');
    expect(turns).toBe(2);
    const original = kernel.execution(executionIdOf(kernel, 'retry-config'))!;
    expect(original.revisionVersion).toBe(1);
    expect(mode === 'error' ? original.retriesUsed : original.resubmitsUsed).toBe(1);
    queue.resume('n1');
    queue.enqueue({ nodeId: 'n1', kind: 'delivery', input: 'in', value: null });
    expect(await executor.runNode('n1', fail)).toBe('failed');
    expect(turns).toBe(3);
    const next = kernel.execution(executionIdOf(kernel, 'retry-config'))!;
    expect(next.revisionVersion).toBe(2);
    expect(next.retriesUsed).toBe(0);
    expect(next.resubmitsUsed).toBe(0);
  } finally { store.close(); }
});


test.each([
  { name: 'graph default', defaults: { budget: { tokens: 500 } }, node: {}, expected: 500 },
  { name: 'node override', defaults: { budget: { tokens: 500 } }, node: { budget: { tokens: 300 } }, expected: 300 },
  { name: 'no quota', defaults: {}, node: { budget: { tokens: 0 } }, expected: 0, blocked: true },
  { name: 'unauthorized increase', defaults: {}, node: { budget: { tokens: 3000 } }, blocked: true },
  { name: 'unauthorized unlimited', defaults: {}, node: { budget: { tokens: null } }, blocked: true },
  { name: 'authorized unlimited', defaults: {}, node: { budget: { tokens: null } }, unlimited: true, expected: null },
  { name: 'finite quota under authorized unlimited', defaults: {}, node: { budget: { tokens: 3000 } }, unlimited: true, expected: 3000 },
])('declarative budget admission: $name', async ({ defaults, node, expected, blocked, unlimited }) => {
  const { kernel, store } = opened();
  try {
    store.db.prepare("INSERT INTO tasks(id,project_id,request,phase,created_seq) VALUES('budget-config','p1','work','running',1)").run();
    const definition = parseGraphDefinition({ ...DEF, defaults, nodes: { n1: { ...DEF.nodes.n1, ...node } } });
    kernel.publishRevision('budget-config', { definition, reason: 'configured' });
    kernel.admitNode('budget-config', 1, 'n1', { instanceId: 'worker' });
    const item = new NodeQueue(kernel, 'budget-config').enqueue({ nodeId: 'n1', kind: 'chat', text: 'one message' });
    let turns = 0;
    const outcome = await new NodeExecutor({ kernel, graphId: 'budget-config', host: fakeHost(),
      tokenBudget: { budget: 2000, unlimited: unlimited ?? false }, reserveTokens: 100,
    }).runNode('n1', async () => { turns++; return { done: true, usage: { total: 1 } }; });
    expect(outcome).toBe(blocked ? 'blocked' : 'done');
    expect(turns).toBe(blocked ? 0 : 1);
    const execution = kernel.execution(executionIdOf(kernel, 'budget-config'))!;
    if (expected !== undefined) expect(execution.tokenBudget).toEqual({ budget: expected ?? 0, unlimited: expected === null });
    expect(execution.retriesUsed).toBe(0);
    expect(kernel.nodeState('budget-config', 'n1').paused).toBe(Boolean(blocked));
    if (blocked) expect(kernel.nextQueued('budget-config', 'n1')?.seq).toBe(item.seq);
  } finally { store.close(); }
});

test('live user default budgets are read for new work without changing the active execution', async () => {
  const { kernel, store } = opened();
  try {
    store.db.prepare("INSERT INTO tasks(id,project_id,request,phase,created_seq) VALUES('live-budget','p1','work','running',1)").run();
    kernel.publishRevision('live-budget', { definition: DEF, reason: 'created' });
    kernel.admitNode('live-budget', 1, 'n1', { instanceId: 'worker' });
    const queue = new NodeQueue(kernel, 'live-budget');
    queue.enqueue({ nodeId: 'n1', kind: 'chat', text: 'first' });
    queue.enqueue({ nodeId: 'n1', kind: 'chat', text: 'second' });
    let ceiling = 1000;
    const snapshots: number[] = [];
    const outcome = await new NodeExecutor({ kernel, graphId: 'live-budget', host: fakeHost(),
      tokenBudget: () => ({ budget: ceiling, unlimited: false }), reserveTokens: 100,
    }).runNode('n1', async executionId => {
      snapshots.push(kernel.execution(executionId)!.tokenBudget!.budget);
      ceiling = 500;
      expect(kernel.execution(executionId)!.tokenBudget!.budget).toBe(snapshots.at(-1));
      return { done: true, usage: { total: 1 } };
    });
    expect(outcome).toBe('done');
    expect(snapshots).toEqual([1000, 500]);
    expect(kernel.budgetState('live-budget', 'n1', { budget: 500, unlimited: false }).used).toBe(2);
  } finally { store.close(); }
});
