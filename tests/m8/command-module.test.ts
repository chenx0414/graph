import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { ModuleRuntime } from '../../src/core/module-runtime.ts';
import { writeModuleEntry, evaluateModule } from '../../src/runtime/module-evaluator.ts';
import type { GraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §9, §13.4 — a versioned custom command module.
 *
 * Failure modes first (R24):
 *   C1  a custom module's evaluate() runs isolated and its outputs become a transition
 *   C2  the transition records the module's code version (why this result, from which code)
 *   C3  a module that throws keeps its inputs and pauses the module
 *   C4  a module that returns a non-conforming value is refused, inputs kept
 *   C5  each trigger re-runs the module code on every accepted input
 */

const stores: TaskStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const commandDefinition = (entry: string): GraphDefinition => ({
  schemaVersion: 2, name: 'cmd',
  protocols: { 'review-result': { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } } },
  nodes: {},
  modules: {
    'custom-route': {
      type: 'command', trigger: 'each',
      inputs: { review: { protocol: 'review-result' } },
      outputs: { decision: { protocol: 'review-result' } },
      // A command module points at main-authored code by a versioned entry path.
      code: { entry, version: 3 },
    } as never,
  },
  edges: {}, inputs: {}, outputs: {},
});

async function kernelWith(definition: GraphDefinition, moduleId: string) {
  const dir = await mkdtemp(join(tmpdir(), 'graph-cmd-'));
  dirs.push(dir);
  const store = new TaskStore(join(dir, 'state.db'));
  stores.push(store);
  const kernel = new KernelStore(store);
  store.db.prepare('INSERT OR IGNORE INTO projects(id,root,grants) VALUES(?,?,?)').run('p1', dir, '[]');
  store.db.prepare('INSERT OR IGNORE INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq) VALUES(?,?,?,?,?,?)').run('t1', 'p1', 'go', 1, 0, 1);
  const revision = kernel.publishRevision('t1', { definition, reason: 'plan' });
  kernel.admitModule('t1', revision.version, moduleId, { moduleType: 'command', trigger: 'each' });
  return { kernel, dir, runtime: new ModuleRuntime(kernel, 't1', revision.version) };
}

describe('ModuleRuntime — a versioned custom command module (§9)', () => {
  test('C1/C2: evaluate() runs isolated and its outputs become a transition with the code version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'graph-cmd-src-'));
    dirs.push(dir);
    const entry = await writeModuleEntry(dir, 'route', `
export function evaluate({ inputs }) {
  const review = inputs.review ?? { __missing__: true };
  if (review.__missing__) return { state: null, outputs: {}, diagnostics: ['waiting'] };
  return { state: null, outputs: { decision: { passed: review.passed, reason: 'custom' } }, diagnostics: [] };
}
`);
    const { kernel, runtime } = await kernelWith(commandDefinition(entry), 'custom-route');
    const result = await runtime.deliverCustom('custom-route', 'review', { passed: true }, evaluateModule);
    expect(result.emitted).toBe(true);
    expect(result.outputs.decision).toEqual({ passed: true, reason: 'custom' });
    const transitions = kernel.moduleTransitions('t1', 'custom-route');
    expect(transitions.length).toBe(1);
    expect(transitions[0]!.ruleVersion).toBe(3);
  });

  test('C5: each trigger re-runs the custom code on every accepted input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'graph-cmd-src-'));
    dirs.push(dir);
    const entry = await writeModuleEntry(dir, 'echo', `
export function evaluate({ inputs }) {
  return { state: null, outputs: { decision: inputs.review ?? null }, diagnostics: [] };
}
`);
    const { runtime } = await kernelWith(commandDefinition(entry), 'custom-route');
    const first = await runtime.deliverCustom('custom-route', 'review', { passed: false }, evaluateModule);
    const second = await runtime.deliverCustom('custom-route', 'review', { passed: true }, evaluateModule);
    expect(first.outputs.decision).toEqual({ passed: false });
    expect(second.outputs.decision).toEqual({ passed: true });
  });

  test('C3: a module that throws keeps its input and pauses the module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'graph-cmd-src-'));
    dirs.push(dir);
    const entry = await writeModuleEntry(dir, 'boom', 'export function evaluate(){ throw new Error("custom blew up"); }');
    const { kernel, runtime } = await kernelWith(commandDefinition(entry), 'custom-route');
    await expect(runtime.deliverCustom('custom-route', 'review', { passed: true }, evaluateModule)).rejects.toThrow(/custom blew up/);
    expect(kernel.nodeState('t1', 'custom-route').paused).toBe(true);
    expect(kernel.moduleInput('t1', 'custom-route', 'review')?.value).toEqual({ passed: true });
  });

  test('C4: a module returning a non-conforming value keeps inputs and pauses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'graph-cmd-src-'));
    dirs.push(dir);
    const entry = await writeModuleEntry(dir, 'bad', 'export function evaluate(){ return 42; }');
    const { kernel, runtime } = await kernelWith(commandDefinition(entry), 'custom-route');
    await expect(runtime.deliverCustom('custom-route', 'review', { passed: true }, evaluateModule)).rejects.toThrow();
    expect(kernel.nodeState('t1', 'custom-route').paused).toBe(true);
    expect(kernel.moduleInput('t1', 'custom-route', 'review')?.value).toEqual({ passed: true });
  });
});
