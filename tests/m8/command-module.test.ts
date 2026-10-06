import { execFileSync } from 'node:child_process';
import { revParse } from '../../src/git/git.ts';
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { graphManagement } from '../../src/core/graph-service.ts';
import { GraphRuntime } from '../../src/core/graph-runtime.ts';
import { GraphRunner, type ModuleOperationRequest } from '../../src/core/graph-runner.ts';
import { recoverKernelExecutions } from '../../src/core/kernel-recovery.ts';
import { executeModuleOperation } from '../../src/runtime/kernel-operation-broker.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { standardAccessPolicy, fullAccessPolicy, resolveAccessPolicy } from '../../src/core/access-policy.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
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

const runtimes: Awaited<ReturnType<typeof openTaskRuntime>>[] = [];
const stores: TaskStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
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
  kernel.admitModule('t1', revision.version, moduleId, { moduleType: definition.modules[moduleId]!.type, trigger: definition.modules[moduleId]!.trigger });
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


// This is the public runtime path: no agent, model, direct evaluator or fake tool node.
test('host command module runs through permissions and once/reopen without requiring a model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-host-operation-')); dirs.push(root);
  const workspace = join(root, 'project'); await mkdir(workspace);
  await writeFile(join(workspace, 'check.mjs'), "import {appendFileSync} from 'node:fs'; appendFileSync('runs.txt','run\\n'); console.log('check passed');");
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }], access: () => standardAccessPolicy() });
  runtimes.push(runtime);
  const parent = await runtime.user.begin({ projectId: 'p', request: 'operation module', requestId: 'parent' });
  const main = runtime.supervisor(parent.taskId);
  const graph = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'checks',
    protocols: { start: { type: 'object' }, result: { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } } },
    nodes: {}, modules: { check: { type: 'operation', trigger: 'once', requiredInputs: ['start'],
      inputs: { start: { protocol: 'start' } }, outputs: { result: { protocol: 'result' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.mjs'], output: 'result' } } },
    edges: {}, inputs: { start: { to: 'check.start', protocol: 'start' } }, outputs: { result: { from: 'check.result', protocol: 'result' } } }) }) as { graphId: string };
  await main.graphSend({ graphId: graph.graphId, input: 'start', value: {} });
  await main.graphSend({ graphId: graph.graphId, input: 'start', value: {} });
  await runtime.host.drive();
  expect(await readFile(join(workspace, 'runs.txt'), 'utf8')).toBe('run\n');
  const first = await main.graphInspect({ graphId: graph.graphId, query: 'results' }) as { value: { passed: boolean; record: string } }[];
  expect(first).toHaveLength(1); expect(first[0]?.value.passed).toBe(true);
  expect(JSON.parse(await readFile(first[0]!.value.record, 'utf8')).stdout).toContain('check passed');
  await main.graphControl({ graphId: graph.graphId, action: 'reopen', moduleId: 'check' });
  await runtime.host.drive();
  expect(await readFile(join(workspace, 'runs.txt'), 'utf8')).toBe('run\n');
  await main.graphSend({ graphId: graph.graphId, input: 'start', value: {} }); await runtime.host.drive();
  expect(await readFile(join(workspace, 'runs.txt'), 'utf8')).toBe('run\nrun\n');
  expect(await main.graphInspect({ graphId: graph.graphId, query: 'results' })).toHaveLength(2);
}, 30_000);


test('a persisted command result recovers after a landing failure without repeating its side effect', async () => {
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'recovery', protocols: { value: { type: 'object' } }, nodes: {},
    modules: { check: { type: 'operation', trigger: 'each', inputs: { start: { protocol: 'value' } }, outputs: { result: { protocol: 'value' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.mjs'], output: 'result' } } },
    edges: {}, outputs: { result: { from: 'check.result', protocol: 'value' } } });
  const { kernel, dir } = await kernelWith(definition, 'check');
  kernel.db.prepare("UPDATE tasks SET phase='running' WHERE id='t1'").run();
  const workspace = join(dir, 'project'); await mkdir(workspace);
  await writeFile(join(workspace, 'check.mjs'), "import {appendFileSync} from 'node:fs'; appendFileSync('runs.txt','once');");
  new GraphRuntime(kernel, 't1').deliverEndpoint('check.start', {});
  const run = (store: KernelStore, injectFailure: boolean) => new GraphRunner({ kernel: store, graphId: 't1',
    hostFor: () => { throw new Error('operation may not start an agent'); }, submit: () => {},
    operation: async (request: ModuleOperationRequest) => {
      const result = await executeModuleOperation({ ...request, kernel: store, graphId: 't1', workspace, scratchRoot: dir });
      if (injectFailure) throw new Error('interrupted before graph landing');
      return result;
    },
  }).drain();
  expect((await run(kernel, true)).blockedNodes).toContain('check');
  expect(await readFile(join(workspace, 'runs.txt'), 'utf8')).toBe('once');
  expect(kernel.db.prepare('SELECT state FROM kernel_module_operations').get()).toEqual({ state: 'settled' });
  kernel.store.close(); stores.splice(stores.indexOf(kernel.store), 1);
  const reopened = new TaskStore(join(dir, 'state.db')); stores.push(reopened);
  const restored = new KernelStore(reopened); recoverKernelExecutions(restored);
  restored.setNodeQueuePaused('t1', 'check', false);
  expect((await run(restored, false)).drained).toBe(true);
  expect(await readFile(join(workspace, 'runs.txt'), 'utf8')).toBe('once');
  expect(restored.db.prepare('SELECT COUNT(*) AS count FROM kernel_module_operations').get()).toEqual({ count: 1 });
  expect(restored.db.prepare('SELECT COUNT(*) AS count FROM kernel_graph_results').get()).toEqual({ count: 1 });
}, 30_000);


test('stopping a running command keeps uncertain side effects inspectable and cancellation never emits success', async () => {
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'stop command', protocols: { value: { type: 'object' } }, nodes: {},
    modules: { check: { type: 'operation', trigger: 'each', inputs: { start: { protocol: 'value' } }, outputs: { result: { protocol: 'value' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['long.mjs'], output: 'result' } } },
    edges: {}, outputs: { result: { from: 'check.result', protocol: 'value' } } });
  const { kernel, dir } = await kernelWith(definition, 'check');
  kernel.db.prepare("UPDATE tasks SET phase='running' WHERE id='t1'").run();
  const workspace = join(dir, 'project'); await mkdir(workspace);
  await writeFile(join(workspace, 'long.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync('started.txt','started'); setInterval(()=>{},1000);");
  new GraphRuntime(kernel, 't1').deliverEndpoint('check.start', {});
  const drive = new GraphRunner({ kernel, graphId: 't1', hostFor: () => { throw new Error('no agent'); }, submit: () => {},
    operation: request => executeModuleOperation({ ...request, kernel, graphId: 't1', workspace, scratchRoot: dir }),
  }).drain();
  const main = graphManagement(kernel, 't1');
  try {
    await expect.poll(async () => readFile(join(workspace, 'started.txt'), 'utf8').catch(() => ''), { timeout: 20000 }).toBe('started');
    const active = await main.graphInspect({ graphId: 't1', query: 'operations' }) as { id: string; state: string }[];
    expect(active[0]?.state).toBe('dispatched');
    await expect(main.graphControl({ graphId: 't1', action: 'cancel_operation', operationId: active[0]!.id })).rejects.toThrow(/stop active/);
    await main.graphControl({ graphId: 't1', action: 'stop' });
    await drive;
    const interrupted = await main.graphInspect({ graphId: 't1', query: 'operations' }) as { id: string; state: string }[];
    expect(interrupted[0]?.state).toBe('uncertain');
    await main.graphControl({ graphId: 't1', action: 'cancel_operation', operationId: interrupted[0]!.id });
    await main.graphControl({ graphId: 't1', action: 'cancel_operation', operationId: interrupted[0]!.id });
    expect(await main.graphInspect({ graphId: 't1', query: 'results' })).toEqual([]);
    expect(new GraphRuntime(kernel, 't1').settleStop()).toBe('stopped');
  } finally {
    await main.graphControl({ graphId: 't1', action: 'stop' });
    await drive;
  }
}, 30000);


test('main reopen during an asynchronous judgment is applied after that judgment and does not lose the reopen', async () => {
  const definition = commandDefinition('main-authored.mjs');
  definition.modules['custom-route']!.trigger = 'once';
  const { kernel, runtime } = await kernelWith(definition, 'custom-route');
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const judgment = runtime.deliverCustom('custom-route', 'review', { passed: true }, async () => {
    entered(); await held;
    return { ok: true, state: null, outputs: { decision: { passed: true } }, diagnostics: [] };
  });
  await started;
  const reopening = graphManagement(kernel, 't1').graphControl({ graphId: 't1', action: 'reopen', moduleId: 'custom-route' });
  release(); await judgment; await reopening;
  expect(kernel.db.prepare("SELECT triggered FROM kernel_modules WHERE module_id='custom-route'").get()).toEqual({ triggered: 0 });
  expect(kernel.moduleInput('t1', 'custom-route', 'review')?.value).toEqual({ passed: true });
  const next = await runtime.deliverCustom('custom-route', 'review', { passed: false }, async ({ inputs }) => ({
    ok: true, state: null, outputs: { decision: inputs.review! }, diagnostics: [],
  }));
  expect(next.emitted).toBe(true);
  expect(next.outputs.decision).toEqual({ passed: false });
});


test.each(['clean', 'dirty-before', 'dirty-after', 'changed-head', 'failed'])('host checks attest the exact commit only for an unchanged clean tree: %s', async mode => {
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'verified-check', protocols: { value: { type: 'object' } }, nodes: {},
    modules: { check: { type: 'operation', trigger: 'each', inputs: { start: { protocol: 'value' } }, outputs: { result: { protocol: 'value' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.mjs'], output: 'result', sandbox: false } } },
    edges: {}, outputs: { result: { from: 'check.result', protocol: 'value' } } });
  const { kernel, dir } = await kernelWith(definition, 'check');
  const workspace = join(dir, 'project'); await mkdir(workspace);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Check fixture'); git('config', 'user.email', 'check@example.test');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', join(dir, 'empty-hooks'));
  await writeFile(join(workspace, 'target.txt'), 'original');
  const script = mode === 'dirty-after' ? "import{writeFileSync}from'node:fs';writeFileSync('target.txt','changed');"
    : mode === 'changed-head' ? "import{execFileSync}from'node:child_process';execFileSync('git',['commit','--allow-empty','--no-verify','-m','another commit']);" : mode === 'failed' ? "process.exit(1);" : "console.log('passed');";
  await writeFile(join(workspace, 'check.mjs'), script);
  git('add', '.'); git('commit', '-qm', 'base');
  const commit = revParse(workspace, 'HEAD')!;
  if (mode === 'dirty-before') await writeFile(join(workspace, 'target.txt'), 'already dirty');
  new GraphRuntime(kernel, 't1').deliverEndpoint('check.start', {});
  const run = () => new GraphRunner({ kernel, graphId: 't1', hostFor: () => { throw new Error('No agent'); }, submit: () => {},
    operation: request => executeModuleOperation({ ...request, kernel, graphId: 't1', workspace, scratchRoot: dir, access: resolveAccessPolicy(fullAccessPolicy(), { stateDir: dir }) }),
  }).drain();
  expect((await run()).drained).toBe(true);
  const results = kernel.db.prepare('SELECT value FROM kernel_graph_results').all() as { value: string }[];
  const result = JSON.parse(results[0]!.value);
  expect(result.passed).toBe(mode !== 'failed');
  expect(result.commit).toBe(commit);
  expect(result.verifiedCommit).toBe(mode === 'clean' ? commit : null);
  const receipt = JSON.parse(await readFile(result.record, 'utf8'));
  expect(receipt.commitAfter).toBe(revParse(workspace, 'HEAD'));
  expect(receipt.cleanBefore).toBe(mode !== 'dirty-before');
  expect(receipt.cleanAfter).toBe(!['dirty-before', 'dirty-after'].includes(mode));
  expect(receipt.verifiedCommit).toBe(result.verifiedCommit);
  expect(kernel.db.prepare("SELECT state FROM kernel_module_operations").get()).toEqual({ state: 'settled' });
}, 30_000);


test('five native graphs share four program slots and hand capacity to the waiting command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-program-capacity-')); dirs.push(dir);
  const workspace = join(dir, 'project'); await mkdir(workspace);
  await writeFile(join(workspace, 'hold.cjs'), "const fs=require('fs');const id=process.argv[2];fs.writeFileSync(id+'.started','yes');setInterval(()=>{if(fs.existsSync(id+'.release'))process.exit(0)},10);");
  const runtime = await openTaskRuntime({ stateDir: join(dir, 'state'), projects: [{ id: 'p', root: workspace }], access: () => fullAccessPolicy() }); runtimes.push(runtime);
  const parent = await runtime.user.begin({ projectId: 'p', request: 'check concurrently', requestId: 'parent' });
  const main = runtime.supervisor(parent.taskId);
  const createGraph = async (index: number) => {
    const created = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: `check-${index}`,
      protocols: { data: { type: 'object' } }, nodes: {}, modules: { check: { type: 'operation', trigger: 'each',
        inputs: { start: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['hold.cjs', String(index)], output: 'result', sandbox: false } } }, edges: {} }) }) as { graphId: string };
    await main.graphSend({ graphId: created.graphId, nodeId: 'check', input: 'start', value: {} });
    return created.graphId;
  };
  for (let index = 0; index < 5; index++) await createGraph(index);
  const disk = new TaskStore(join(dir, 'state', 'tasks.sqlite')); stores.push(disk);
  const started = async () => (await readdir(workspace)).filter(name => name.endsWith('.started'));
  const drive = runtime.host.drive();
  try {
    await expect.poll(() => disk.db.prepare('SELECT COUNT(*) AS n FROM kernel_module_operations').get(), { timeout: 10000 }).toEqual({ n: 5 });
    await expect.poll(async () => (await started()).length >= 4, { timeout: 10000 }).toBe(true);
    expect(disk.db.prepare("SELECT COUNT(*) AS n FROM kernel_module_operations WHERE state='dispatched'").get()).toEqual({ n: 4 });
    expect(disk.db.prepare("SELECT COUNT(*) AS n FROM kernel_module_operations WHERE state='prepared'").get()).toEqual({ n: 1 });
    const first = (await started())[0]!.replace('.started', '');
    await writeFile(join(workspace, `${first}.release`), 'release');
    await expect.poll(async () => (await started()).length, { timeout: 10000 }).toBe(5);
    expect(disk.db.prepare("SELECT COUNT(*) AS n FROM kernel_module_operations WHERE state='dispatched'").get()).toEqual({ n: 4 });
    const cancelled = await createGraph(5);
    await runtime.host.pump();
    await expect.poll(() => disk.db.prepare("SELECT state FROM kernel_module_operations WHERE task_id=?").get(cancelled), { timeout: 10000 }).toEqual({ state: 'prepared' });
    await main.graphControl({ graphId: cancelled, action: 'stop' });
    await expect.poll(() => disk.db.prepare("SELECT state,worker_active FROM kernel_module_operations WHERE task_id=?").get(cancelled), { timeout: 10000 }).toEqual({ state: 'failed', worker_active: 0 });
    expect(await started()).not.toContain('5.started');
    for (let index = 0; index < 5; index++) await writeFile(join(workspace, `${index}.release`), 'release');
    await drive;
    expect(disk.db.prepare("SELECT COUNT(*) AS n FROM kernel_module_operations WHERE state='settled'").get()).toEqual({ n: 5 });
    expect(disk.db.prepare('SELECT COUNT(*) AS n FROM kernel_module_operations WHERE worker_active=1').get()).toEqual({ n: 0 });
  } finally {
    for (let index = 0; index < 5; index++) await writeFile(join(workspace, `${index}.release`), 'release');
    await drive;
  }
}, 30000);
