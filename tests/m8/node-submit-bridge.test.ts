import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { NodeSubmitBridge } from '../../src/core/node-submit-bridge.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §5, §6 + backlog HB-257 — the node's submit surface, bound to one execution.
 *
 * This is the leg that was missing: a node's `submit_result` call has to land as a real
 * Submission plus Deliveries in the kernel, and a refusal has to come back to the model
 * as the field-level correction the spec asks for, WITHOUT burning the one valid
 * submission the execution is allowed.
 *
 * Failure modes first (R24):
 *   B1  a valid submit lands as a real Submission and its Deliveries
 *   B2  a bad submit reports field-level defects and does not consume the one chance
 *   B3  after a valid submit a second, different submit is refused
 *   B4  an identical replay returns the original receipt and writes no new delivery
 *   B5  a missing required output is reported as missing-required, the resubmit signal
 *   B6  submitting for an execution that is not running is refused
 */

const DEF = parseGraphDefinition({
  schemaVersion: 2, name: 'bridge',
  protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  nodes: {
    a: { recipe: 'a@1', task: 'a', inputs: {}, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
    b: { recipe: 'b@1', task: 'b', inputs: { in: { protocol: 'ping' } }, outputs: {}, submission: {} },
  },
  modules: {},
  edges: { e: { from: 'a.out', to: 'b.in', enabled: true } },
});

function opened() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
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
  kernel.startExecution('g1', { executionId: 'x1', nodeId: 'a', revisionVersion: rev.version });
  return { store, kernel, bridge: new NodeSubmitBridge(kernel, 'x1') };
}

describe('NodeSubmitBridge — a node submit lands in the kernel (HB-257)', () => {
  test('B1: a valid submit writes a real submission and its deliveries', () => {
    const { kernel, bridge } = opened();
    const receipt = bridge.submit({ outputs: { out: { enable: true, value: { n: 7 } } }, submissionId: 's1' });

    expect(receipt.accepted).toBe(true);
    expect(receipt.deliveries.length).toBe(1);
    expect(receipt.deliveries[0]!.toEndpoint).toBe('b.in');
    // It really is in the kernel, not just in the bridge's return value.
    expect(kernel.deliveriesFor('x1').length).toBe(1);
    expect(kernel.revision('g1', 1)).not.toBeNull();
  });

  test('B2: a bad submit reports field-level defects and does not consume the chance', () => {
    const { kernel, bridge } = opened();
    // `n` is required by the ping protocol and is the wrong type here.
    const refused = bridge.submit({ outputs: { out: { enable: true, value: { n: 'seven' } } }, submissionId: 'bad' });

    expect(refused.accepted).toBe(false);
    expect(refused.defects.length).toBeGreaterThan(0);
    const defect = refused.defects[0]!;
    expect(defect.path).toContain('out');
    expect(defect.expected).toBeTruthy();
    expect(defect.got).toBeTruthy();
    // Nothing was written, so the one valid submission is still available.
    expect(kernel.deliveriesFor('x1').length).toBe(0);
    const good = bridge.submit({ outputs: { out: { enable: true, value: { n: 1 } } }, submissionId: 'good' });
    expect(good.accepted).toBe(true);
  });

  test('B5: a missing required output is reported as missing-required', () => {
    const { bridge, kernel } = opened();
    const refused = bridge.submit({ outputs: { out: { enable: false } }, submissionId: 's1' });
    expect(refused.accepted).toBe(false);
    expect(refused.missingRequired).toEqual(['out']);
    // Still no submission: the node must fix it and try again.
    expect(kernel.deliveriesFor('x1').length).toBe(0);
  });

  test('B3: after a valid submit a different second submit is refused', () => {
    const { bridge } = opened();
    expect(bridge.submit({ outputs: { out: { enable: true, value: { n: 1 } } }, submissionId: 's1' }).accepted).toBe(true);
    const second = bridge.submit({ outputs: { out: { enable: true, value: { n: 2 } } }, submissionId: 's2' });
    expect(second.accepted).toBe(false);
    expect(second.defects.length).toBeGreaterThan(0);
  });

  test('B4: an identical replay returns the original receipt and writes no new delivery', () => {
    const { bridge, kernel } = opened();
    const first = bridge.submit({ outputs: { out: { enable: true, value: { n: 1 } } }, submissionId: 's1' });
    const replay = bridge.submit({ outputs: { out: { enable: true, value: { n: 1 } } }, submissionId: 's1' });

    expect(replay.accepted).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(replay.submissionId).toBe(first.submissionId);
    // No duplicate: still exactly one delivery.
    expect(kernel.deliveriesFor('x1').length).toBe(1);
  });

  test('B6: submitting for an execution that is not running is refused', () => {
    const { kernel } = opened();
    kernel.finishExecution('x1', 'failed');
    const bridge = new NodeSubmitBridge(kernel, 'x1');
    const refused = bridge.submit({ outputs: { out: { enable: true, value: { n: 1 } } }, submissionId: 's1' });
    expect(refused.accepted).toBe(false);
    expect(refused.defects.length).toBeGreaterThan(0);
  });

  test('B1: the bridge reports the node and execution it is bound to', () => {
    const { bridge } = opened();
    expect(bridge.executionId).toBe('x1');
    expect(bridge.nodeId).toBe('a');
  });
});
