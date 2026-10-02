import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { NodeSubmitBridge } from '../../src/core/node-submit-bridge.ts';
import { NodeTurnDriver, type DriverHost } from '../../src/core/node-turn-driver.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §7 + backlog HB-257 — the turn driver that NodeExecutor plugs in.
 *
 * `NodeExecutor` accepts a `TurnRunner`. Until now every test passed a scripted stand-in,
 * so nothing showed how a real turn is driven: prompt the resident worker, let the node's
 * submit land in the kernel, then read THIS execution's state back to decide
 * retry / resubmit / done.
 *
 * Failure modes first (R24):
 *   D1  a turn where the submit lands reports done, and the submission is really in the kernel
 *   D2  a turn that submits nothing reports no submission, so the executor retries
 *   D3  a missing-required refusal recorded on this execution is reported as the gap
 *   D4  the first turn carries the initial context; later turns carry only the delta
 *   D5  a rebuilt process is started before the turn and the SAME execution continues
 *   D6  the driver never claims success without a real submission in the kernel
 */

const DEF = parseGraphDefinition({
  schemaVersion: 2, name: 'drive',
  protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  nodes: {
    a: { recipe: 'a@1', task: 'do the thing', inputs: {}, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
    b: { recipe: 'b@1', task: 'b', inputs: { in: { protocol: 'ping' } }, outputs: {}, submission: {} },
  },
  modules: {},
  edges: { e: { from: 'a.out', to: 'b.in', enabled: true } },
});

function opened() {
  const dir = mkdtempSync(join(tmpdir(), 'drive-'));
  const store = new TaskStore(join(dir, 'state.db'));
  store.db.exec(`
    INSERT INTO projects(id,root,grants) VALUES('p','${dir}','[]');
    INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
      VALUES('g1','p','r',1,0,'executing',0,1);
  `);
  const kernel = new KernelStore(store);
  const rev = kernel.publishRevision('g1', { definition: DEF, reason: 'create' });
  kernel.admitNode('g1', rev.version, 'a', { instanceId: 'i-a' });
  kernel.admitNode('g1', rev.version, 'b', { instanceId: 'i-b' });
  return { store, kernel };
}

/** A host that records every prompt it was asked to run. */
function fakeHost(alive = true) {
  const seen: string[] = [];
  const host = {
    seen,
    restarts: 0,
    async start() { host.restarts += 1; host.live = true; return { processId: 1 }; },
    alive() { return host.live; },
    async turn(text: string) { seen.push(text); return { turnId: `t${seen.length}`, inspect: {} }; },
    live: alive,
  };
  return host as unknown as DriverHost & { seen: string[]; restarts: number };
}

describe('NodeTurnDriver — prompt, submit, read back (HB-257)', () => {
  test('D1/D6: a turn whose submit lands reports done, and the submission is in the kernel', async () => {
    const { kernel } = opened();
    kernel.startExecution('g1', { executionId: 'x1', nodeId: 'a', revisionVersion: 1 });
    const host = fakeHost();
    const driver = new NodeTurnDriver({
      kernel, graphId: 'g1', nodeId: 'a', host,
      submit: (executionId) => {
        const bridge = new NodeSubmitBridge(kernel, executionId);
        bridge.submit({ outputs: { out: { enable: true, value: { n: 1 } } }, submissionId: 's1' });
      },
    });

    const report = await driver.run('x1', 1, undefined);
    expect(report.done).toBe(true);
    expect(report.missing).toBeUndefined();
    // Really in the kernel, and only once.
    expect(kernel.deliveriesFor('x1').length).toBe(1);
  });

  test('D2: a turn that submits nothing reports no submission, so the executor retries', async () => {
    const { kernel } = opened();
    kernel.startExecution('g1', { executionId: 'x1', nodeId: 'a', revisionVersion: 1 });
    const driver = new NodeTurnDriver({
      kernel, graphId: 'g1', nodeId: 'a', host: fakeHost(), submit: () => { /* the node never submitted */ },
    });

    const report = await driver.run('x1', 1, undefined);
    expect(report.done).toBe(false);
    expect(report.missing).toBeUndefined();
  });

  test('D3: a missing-required refusal on this execution is reported as the gap', async () => {
    const { kernel } = opened();
    kernel.startExecution('g1', { executionId: 'x1', nodeId: 'a', revisionVersion: 1 });
    const driver = new NodeTurnDriver({
      kernel, graphId: 'g1', nodeId: 'a', host: fakeHost(),
      submit: (executionId) => {
        const bridge = new NodeSubmitBridge(kernel, executionId);
        const refused = bridge.submit({ outputs: { out: { enable: false } }, submissionId: 's1' });
        // The node saw this refusal; the driver must surface the gap so the executor
        // can inject it and try once more on the SAME execution.
        expect(refused.missingRequired).toEqual(['out']);
        return { missing: refused.missingRequired };
      },
    });

    const report = await driver.run('x1', 1, undefined);
    expect(report.done).toBe(false);
    expect(report.missing).toEqual(['out']);
    expect(kernel.deliveriesFor('x1').length).toBe(0);
  });

  test('D3b: the refusal is durable — a restart still resumes as a resubmit', async () => {
    const { kernel } = opened();
    kernel.startExecution('g1', { executionId: 'x1', nodeId: 'a', revisionVersion: 1 });
    // The node was refused, then the process died before the gap could be handed back.
    new NodeSubmitBridge(kernel, 'x1').submit({ outputs: { out: { enable: false } }, submissionId: 's1' });
    const driver = new NodeTurnDriver({
      kernel, graphId: 'g1', nodeId: 'a', host: fakeHost(false),
      submit: () => { /* the node does not reach the bridge this time */ },
      missingRequiredNames: () => ['out'],
    });

    const report = await driver.run('x1', 2, undefined);
    expect(report.done).toBe(false);
    expect(report.missing).toEqual(['out']);
  });

  test('D4: the first turn carries the initial context; later turns carry only the delta', async () => {
    const { kernel } = opened();
    kernel.startExecution('g1', { executionId: 'x1', nodeId: 'a', revisionVersion: 1 });
    const host = fakeHost();
    const driver = new NodeTurnDriver({
      kernel, graphId: 'g1', nodeId: 'a', host,
      initialContext: () => 'GRAPH OVERVIEW\nnodes: a, b\nTASK: do the thing',
      submit: () => { /* no submit: keep it simple */ },
    });

    await driver.run('x1', 1, undefined);
    await driver.run('x1', 2, undefined);

    // The first prompt is the full briefing.
    expect(host.seen[0]).toContain('GRAPH OVERVIEW');
    expect(host.seen[0]).toContain('do the thing');
    // The second is a continuation and does NOT repeat the whole briefing.
    expect(host.seen[1]).not.toContain('GRAPH OVERVIEW');
    expect(host.seen[1]).toMatch(/continue|again|previous/i);
  });

  test('D4: a resubmit turn tells the node exactly which required output is missing', async () => {
    const { kernel } = opened();
    kernel.startExecution('g1', { executionId: 'x1', nodeId: 'a', revisionVersion: 1 });
    const host = fakeHost();
    const driver = new NodeTurnDriver({
      kernel, graphId: 'g1', nodeId: 'a', host,
      initialContext: () => 'BRIEF',
      submit: () => { /* nothing */ },
    });

    await driver.run('x1', 2, { missing: ['out'] });
    // The injected turn names the gap and says the existing work stands (§7).
    expect(host.seen[0]).toContain('out');
    expect(host.seen[0]).toMatch(/do not redo|stays in place|already/i);
  });

  test('D5: a rebuilt process is started before the turn and the same execution continues', async () => {
    const { kernel } = opened();
    kernel.startExecution('g1', { executionId: 'x1', nodeId: 'a', revisionVersion: 1 });
    const host = fakeHost(false); // dead before the turn
    const driver = new NodeTurnDriver({
      kernel, graphId: 'g1', nodeId: 'a', host,
      submit: (executionId) => {
        new NodeSubmitBridge(kernel, executionId).submit({ outputs: { out: { enable: true, value: { n: 2 } } }, submissionId: 's2' });
      },
    });

    const report = await driver.run('x1', 2, undefined);
    expect(host.restarts).toBeGreaterThan(0);
    expect(report.done).toBe(true);
    // Still the same execution: the submission belongs to x1.
    expect(kernel.deliveriesFor('x1').length).toBe(1);
  });
});

describe('NodeExecutor + NodeTurnDriver + real kernel — the composed path (HB-257)', () => {
  test('a node runs, submits, and the queue drains through the real driver', async () => {
    const { kernel } = opened();
    const { NodeExecutor } = await import('../../src/core/node-executor.ts');
    const { NodeQueue } = await import('../../src/core/node-queue.ts');

    new NodeQueue(kernel, 'g1').enqueue({ nodeId: 'a', kind: 'delivery', input: 'in', value: { go: true } as never });

    const host = fakeHost();
    const driver = new NodeTurnDriver({
      kernel, graphId: 'g1', nodeId: 'a', host,
      initialContext: () => 'BRIEF: do the thing',
      submit: (executionId) => {
        const bridge = new NodeSubmitBridge(kernel, executionId);
        return { missing: bridge.submit({ outputs: { out: { enable: true, value: { n: 5 } } }, submissionId: `s-${executionId}` }).missingRequired };
      },
    });
    const executor = new NodeExecutor({ kernel, graphId: 'g1', host });

    const outcome = await executor.runNode('a', (executionId, attempt, injection) => driver.run(executionId, attempt, injection));

    expect(outcome).toBe('done');
    // The composed path really wrote a delivery and drained the queue.
    const execution = kernel.db.prepare("SELECT id FROM kernel_executions WHERE task_id='g1' ORDER BY rowid DESC LIMIT 1").get() as { id: string };
    expect(kernel.deliveriesFor(execution.id).length).toBe(1);
    expect(kernel.nextQueued('g1', 'a')).toBeNull();
    expect(kernel.nodeState('g1', 'a').paused).toBe(false);
  });
});
