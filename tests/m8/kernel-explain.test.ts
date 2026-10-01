import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { explainModule, explainEdge } from '../../src/core/kernel-explain.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §10, §14 — the explanation projections.
 *
 * The specification is explicit that a module detail must not merely say "succeeded":
 * it shows each input, each rule's verdict, the trigger policy, the latch, the reopen
 * records and the actual outputs, and an edge shows its history and never draws an
 * undelivered value as empty.
 *
 * Failure modes first (R24):
 *   V1  each declared input appears with its current value, source and time; an input
 *       that was never delivered is reported missing
 *   V2  "never delivered" is distinguishable from "delivered false/null"
 *   V3  the rule verdicts are shown, not only a success flag
 *   V4  the trigger policy (each/once) and the latch state are shown
 *   V5  a reopen shows as its own record that emitted nothing
 *   V6  an edge shows named endpoints, enabled state, protocol, newest delivery and
 *       history; a never-delivered edge says none and never an empty value
 *   V7  a disabled edge and a business passed:false are different in the view
 */

const DEF = parseGraphDefinition({
  schemaVersion: 2, name: 'explain',
  protocols: {
    ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
    verdict: { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } },
  },
  nodes: {
    a: { recipe: 'a@1', task: 'a', inputs: {}, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
    b: { recipe: 'b@1', task: 'b', inputs: { in: { protocol: 'ping' } }, outputs: {}, submission: {} },
  },
  modules: {
    gate: { type: 'router', trigger: 'once', inputs: { left: { protocol: 'ping' }, right: { protocol: 'verdict' } }, outputs: { pass: { protocol: 'verdict' } } },
  },
  edges: { e1: { from: 'a.out', to: 'b.in', enabled: true }, e2: { from: 'a.out', to: 'b.in', enabled: false } },
});

function opened() {
  const dir = mkdtempSync(join(tmpdir(), 'explain-'));
  const store = new TaskStore(join(dir, 'state.db'));
  store.db.exec(`
    INSERT INTO projects(id,root,grants) VALUES('p','${dir}','[]');
    INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
      VALUES('g1','p','r',1,0,'executing',0,1);
  `);
  const kernel = new KernelStore(store);
  const rev = kernel.publishRevision('g1', { definition: DEF, reason: 'create' });
  kernel.admitModule('g1', rev.version, 'gate', { moduleType: 'router', trigger: 'once' });
  return { store, kernel };
}

describe('explainModule — inputs, verdicts, latch and reopens (§10)', () => {
  test('V1/V2: an undelivered input is missing, and that is not the same as false', () => {
    const { kernel } = opened();
    // left was never delivered; right was delivered the literal false.
    kernel.setModuleInput('g1', 'gate', 'right', false as never, 'a.out');

    const view = explainModule(kernel, 'g1', 'gate');
    const left = view.inputs.find(i => i.name === 'left')!;
    const right = view.inputs.find(i => i.name === 'right')!;

    expect(left.delivered).toBe(false);
    expect(left.value).toBeNull();
    expect(left.missing).toBe(true);
    // Delivered false is delivered, not missing, and its value is literally false.
    expect(right.delivered).toBe(true);
    expect(right.missing).toBe(false);
    expect(right.value).toBe(false);
    expect(right.source).toBe('a.out');
  });

  test('V1: a delayed input is older than null: each input carries its own time', () => {
    const { kernel } = opened();
    kernel.setModuleInput('g1', 'gate', 'left', { n: 1 } as never, 'a.out');
    const view = explainModule(kernel, 'g1', 'gate');
    expect(view.inputs.find(i => i.name === 'left')!.updatedAt).toBeGreaterThan(0);
    expect(view.inputs.find(i => i.name === 'right')!.updatedAt).toBeNull();
  });

  test('V4: the trigger policy and the latch are both shown', () => {
    const { kernel } = opened();
    const before = explainModule(kernel, 'g1', 'gate');
    expect(before.trigger).toBe('once');
    expect(before.triggered).toBe(false);

    kernel.recordModuleTransition('g1', {
      moduleId: 'gate', inputName: 'left', inputValue: { n: 1 }, stateBefore: null, stateAfter: { fired: true },
      verdict: 'pass', outputs: { pass: { passed: true } }, ruleVersion: 1, reason: 'left matched',
    });
    const after = explainModule(kernel, 'g1', 'gate');
    expect(after.triggered).toBe(true);
    expect(after.state).toEqual({ fired: true });
  });

  test('V3: the transition history shows the verdict and the outputs, not just success', () => {
    const { kernel } = opened();
    kernel.recordModuleTransition('g1', {
      moduleId: 'gate', inputName: 'left', inputValue: { n: 2 }, stateBefore: null, stateAfter: null,
      verdict: 'hold', outputs: {}, ruleVersion: 3, reason: 'no rule matched',
    });
    const view = explainModule(kernel, 'g1', 'gate');
    expect(view.transitions.length).toBe(1);
    const t = view.transitions[0]!;
    expect(t.verdict).toBe('hold');
    expect(t.reason).toBe('no rule matched');
    expect(t.ruleVersion).toBe(3);
    expect(t.outputs).toEqual({});
    // The view never collapses to a bare boolean: the verdict is present as text.
    expect(t).not.toHaveProperty('succeeded');
  });

  test('V5: a reopen is its own record and emitted nothing', () => {
    const { kernel } = opened();
    // A reopen is recorded with no verdict and no outputs (ModuleRuntime.reopen).
    kernel.recordModuleTransition('g1', {
      moduleId: 'gate', inputName: 'left', inputValue: { n: 1 }, stateBefore: { fired: true }, stateAfter: { fired: true },
      verdict: null, outputs: {}, ruleVersion: 1, reason: 'reopened',
    });
    const view = explainModule(kernel, 'g1', 'gate');
    const reopen = view.transitions[0]!;
    expect(reopen.reason).toBe('reopened');
    expect(reopen.verdict).toBeNull();
    expect(reopen.outputs).toEqual({});
    // A reopen does not latch the module.
    expect(view.triggered).toBe(false);
  });

  test('V3: a module with no transitions yet reports no judgments, not a failure', () => {
    const { kernel } = opened();
    const view = explainModule(kernel, 'g1', 'gate');
    expect(view.transitions).toEqual([]);
    expect(view.triggered).toBe(false);
  });
});

describe('explainEdge — history and the difference between disabled and failed (§10)', () => {
  test('V6: an edge that never delivered says none, never an empty value', () => {
    const { kernel } = opened();
    const view = explainEdge(kernel, 'g1', 'e1', 1);
    expect(view.from).toBe('a.out');
    expect(view.to).toBe('b.in');
    expect(view.enabled).toBe(true);
    expect(view.protocol).toBe('ping');
    expect(view.latest).toBeNull();
    expect(view.deliveries).toEqual([]);
  });

  test('V6: deliveries are shown newest-first with their value and receiving revision', () => {
    const { kernel } = opened();
    kernel.admitNode('g1', 1, 'a', { instanceId: 'i-a' });
    kernel.startExecution('g1', { executionId: 'x1', nodeId: 'a', revisionVersion: 1 });
    kernel.submit('x1', { outputs: { out: { enable: true, value: { n: 1 } } }, submissionId: 's1' });

    const view = explainEdge(kernel, 'g1', 'e1', 1);
    expect(view.deliveries.length).toBe(1);
    expect(view.latest).toEqual({ n: 1 });
    expect(view.deliveries[0]!.revisionVersion).toBe(1);
  });

  test('V7: a disabled edge is disabled, which is not the same as a failed result', () => {
    const { kernel } = opened();
    const enabled = explainEdge(kernel, 'g1', 'e1', 1);
    const disabled = explainEdge(kernel, 'g1', 'e2', 1);
    expect(enabled.enabled).toBe(true);
    expect(disabled.enabled).toBe(false);
    // Neither is described as a business outcome: enabled is its own axis.
    expect(disabled).not.toHaveProperty('passed');
    // A disabled edge has no deliveries to show, and says so rather than showing empty.
    expect(disabled.latest).toBeNull();
  });
});
