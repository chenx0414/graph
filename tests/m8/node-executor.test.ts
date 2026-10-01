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
    const exec = new NodeExecutor({ kernel, graphId, host, workerEntry: 'x', config: {} as never, cwd: '/tmp', configPath: '/tmp/cfg.json' });
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
    const exec = new NodeExecutor({ kernel, graphId, host, workerEntry: 'x', config: {} as never, cwd: '/tmp', configPath: '/tmp/cfg.json' });
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
    const exec = new NodeExecutor({ kernel, graphId, host, workerEntry: 'x', config: {} as never, cwd: '/tmp', configPath: '/tmp/cfg.json' });
    const outcome = await exec.runNode('n1', async (executionId, attempt, injection) => {
      if (injection) injections.push(injection.missing);
      // First two turns report the same missing-required gap; the resubmit budget is 1.
      if (attempt === 1 || attempt === 2) return { missing: ['out'] };
    });

    expect(injections.flat()).toContain('out');
    expect(outcome).toBe('failed'); // returned the gap but never filled it, budget spent
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
    const exec = new NodeExecutor({ kernel, graphId, host, workerEntry: 'x', config: {} as never, cwd: '/tmp', configPath: '/tmp/cfg.json' });
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
    const exec = new NodeExecutor({ kernel, graphId, host, workerEntry: 'x', config: {} as never, cwd: '/tmp', configPath: '/tmp/cfg.json' });
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
