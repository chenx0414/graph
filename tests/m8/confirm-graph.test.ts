import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { GraphRuntime } from '../../src/core/graph-runtime.ts';
import { materializeGraph } from '../../src/core/confirm-graph.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import type { ActionAdapter, Operation, OperationResult , Proposal } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  cleanup.length = 0;
});

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
const scripted = (handler: (operation: Operation) => Promise<OperationResult> | OperationResult): ActionAdapter =>
  ({ kind: 'agent', reserveTokens: 100, prepare: async (operation: Operation) => async () => handler(operation) });

/**
 * Issue #1 §13.8 — the first half of the switchover: a confirmed draft that carries a
 * v2 graph definition must create a v2 graph, not the old-shaped proposal rows.
 *
 * The switchover is the moment the product starts running the new kernel. It cannot be
 * done by deleting the old path first (the product would break mid-flight), so it is
 * done additively: a draft that carries a v2 definition takes the v2 path, and a draft
 * that does not keeps the old path unchanged. This module is the v2 half of that fork.
 *
 * Failure modes first (R24):
 *   W1  a v2 definition materialises as revision 1, with every node and module admitted
 *   W2  the created graph is runnable — its nodes are real kernel nodes, not display rows
 *   W3  materialising twice for the same task is refused whole rather than doubling rows
 *   W4  an invalid definition is refused with no partial rows left behind
 */

const DEFINITION = parseGraphDefinition({
  schemaVersion: 2, name: 'chain',
  protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  nodes: {
    a: { recipe: 'a@1', task: 'a', inputs: {}, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
    b: { recipe: 'b@1', task: 'b', inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
  },
  modules: {
    gate: { type: 'router', trigger: 'each', inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, rules: [{ when: 'in.n > 0', emit: { out: '$in' } }] },
  },
  edges: { ab: { from: 'a.out', to: 'b.in', enabled: true } },
});

function store(): TaskStore {
  const dir = mkdtempSync(join(tmpdir(), 'confirm-graph-'));
  const s = new TaskStore(join(dir, 'state.db'));
  s.db.exec(`INSERT INTO projects(id,root,grants) VALUES('p','${dir}','[]');`);
  s.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES(?,?,?,1,1,1,?)').run('t1', 'p', 'req', 'running');
  return s;
}

describe('materializeGraph — the v2 half of the §13.8 switchover', () => {
  test('W1: a v2 definition becomes revision 1 with every node and module admitted', () => {
    const s = store();
    const kernel = new KernelStore(s);
    const result = materializeGraph(kernel, 't1', DEFINITION, 'w1');

    expect(result.revision.version).toBe(1);
    const nodes = s.db.prepare('SELECT node_id FROM kernel_nodes WHERE task_id=? ORDER BY node_id').all('t1') as { node_id: string }[];
    expect(nodes.map(n => n.node_id)).toEqual(['a', 'b']);
    const modules = s.db.prepare('SELECT module_id FROM kernel_modules WHERE task_id=? ORDER BY module_id').all('t1') as { module_id: string }[];
    expect(modules.map(m => m.module_id)).toEqual(['gate']);
  });

  test('W2: the created graph is runnable — nodes carry instance ids the executor needs', () => {
    const s = store();
    const kernel = new KernelStore(s);
    materializeGraph(kernel, 't1', DEFINITION, 'w2');
    // A display-only row would have no instance id and the executor could not run it.
    const a = s.db.prepare("SELECT instance_id FROM kernel_nodes WHERE task_id='t1' AND node_id='a'").get() as { instance_id: string | null };
    expect(a.instance_id).toBeTruthy();
    // The entry node is queued at materialisation. This used to assert the opposite -
    // "the queue is empty but the node is live" - on the belief that GraphRunner would
    // enqueue it. Nothing did: GraphLane.runnable() only names graphs holding a queued
    // item, so a confirmed graph with no incoming edge sat forever with every node idle.
    const queued = kernel.nextQueued('t1', 'a');
    expect(queued).not.toBeNull();
    expect(queued!.kind).toBe('start');
    expect(kernel.nodeState('t1', 'a').paused).toBe(false);
  });

  test('W3: materialising twice for the same task is refused, leaving one revision', () => {
    const s = store();
    const kernel = new KernelStore(s);
    materializeGraph(kernel, 't1', DEFINITION, 'w3');
    expect(() => materializeGraph(kernel, 't1', DEFINITION, 'w3-again')).toThrow();
    const revisions = s.db.prepare('SELECT COUNT(*) AS n FROM kernel_revisions WHERE task_id=?').get('t1') as { n: number };
    expect(revisions.n).toBe(1);
    const nodes = s.db.prepare('SELECT COUNT(*) AS n FROM kernel_nodes WHERE task_id=?').get('t1') as { n: number };
    expect(nodes.n).toBe(2);
  });

  test('W4: an invalid definition is refused with no partial rows left behind', () => {
    const s = store();
    const kernel = new KernelStore(s);
    const broken = { schemaVersion: 2, name: 'broken', protocols: {}, nodes: { a: { recipe: 'a@1', task: 'a', inputs: {}, outputs: { out: { protocol: 'missing' } }, submission: { required: ['out'] } } }, modules: {}, edges: {} };
    expect(() => materializeGraph(kernel, 't1', broken as never, 'w4')).toThrow();
    // The refusal must be whole: nothing from the failed attempt survives.
    for (const table of ['kernel_revisions', 'kernel_nodes', 'kernel_modules']) {
      const row = s.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id=?`).get('t1') as { n: number };
      expect(row.n).toBe(0);
    }
  });

  // §13.8's switchover seen from the real product surface: a confirmed draft that
  // carries a v2 definition must come into existence as a runnable v2 graph, on the
  // task the confirmation created. This is what makes the switchover a switch rather
  // than a parallel copy of the kernel that never runs.
  test('W5: confirming a draft that carries a v2 definition creates a runnable v2 graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'confirm-graph-e2e-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    const runtime = await openTaskRuntime({
      stateDir: join(root, 'state'),
      projects: [{ id: 'p', root: project }],
      actions: { master: scripted(() => ({ outcome: 'completed', output: { text: 'draft ready' }, usage })) },
      master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
    });
    cleanup.push(() => runtime.close());

    const created = await runtime.conversations.create({ text: '做一个两节点链', requestId: 'create' });
    await runtime.host.runReady();
    const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });

    // The draft carries a v2 definition and empty old-shaped nodes: the definition is
    // the graph, so nothing old-shaped is required.
    await runtime.supervisor(anchorTaskId).propose({
      requirementVersion: 1, summary: '两节点链',
      acceptance: [{ id: 'works', description: '链跑通', checkNode: 'b' }],
      nodes: [],
      definition: DEFINITION,
    }, 'proposal-v2');

    const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });

    // The feature task is a real v2 graph: revision 1, both nodes and the module admitted.
    const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
    const kernel = new KernelStore(store);
    expect(kernel.latestRevision(confirmed.taskId)).toMatchObject({ version: 1 });
    const nodes = store.db.prepare('SELECT node_id FROM kernel_nodes WHERE task_id=? ORDER BY node_id').all(confirmed.taskId) as { node_id: string }[];
    expect(nodes.map(n => n.node_id)).toEqual(['a', 'b']);
    const modules = store.db.prepare('SELECT module_id FROM kernel_modules WHERE task_id=?').all(confirmed.taskId) as { module_id: string }[];
    expect(modules.map(m => m.module_id)).toEqual(['gate']);
    // Nothing old-shaped was written for this task: it is on the new kernel, not both.
    const oldRevisions = store.db.prepare('SELECT COUNT(*) AS n FROM graph_revisions WHERE task_id=?').get(confirmed.taskId) as { n: number };
    expect(oldRevisions.n).toBe(0);
    const oldNodes = store.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE task_id=?').get(confirmed.taskId) as { n: number };
    expect(oldNodes.n).toBe(0);
    store.db.close();
  });

  // NOTE: this case still describes the OLD behaviour on purpose. It is rewritten in the
  // same commit that makes `definition` required; until that switch lands, asserting the
  // refusal here would leave the branch red for a promise the product has not made yet.
  test('W6: a draft without a definition still confirms the old way (no regression)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'confirm-graph-old-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    const runtime = await openTaskRuntime({
      stateDir: join(root, 'state'),
      projects: [{ id: 'p', root: project }],
      actions: { master: scripted(() => ({ outcome: 'completed', output: { text: 'draft ready' }, usage })) },
      master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
    });
    cleanup.push(() => runtime.close());
    const created = await runtime.conversations.create({ text: '旧方案', requestId: 'create' });
    await runtime.host.runReady();
    const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
    // Deliberately NOT lifted: this case is about the old shape reaching the old tables,
    // so the draft must stay old-shaped. Once `definition` becomes required this case is
    // rewritten to assert the refusal instead.
    const proposed2 = await runtime.supervisor(anchorTaskId).propose({
      requirementVersion: 1, summary: '旧方案',
      acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
      nodes: [
        { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm' },
        { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
      ],
    } as Proposal, 'proposal-old');
    const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });
    const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
    const oldNodes = store.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE task_id=?').get(confirmed.taskId) as { n: number };
    expect(oldNodes.n).toBe(2);
    const kernel = new KernelStore(store);
    expect(kernel.latestRevision(confirmed.taskId)).toBeNull();
    store.db.close();
  });
});

/**
 * Issue #1 HB-290: a graph's entry nodes are the ones nothing points at.
 *
 * The original rule counted BOTH endpoints of every edge as "targeted", so in any
 * connected graph every node looked targeted, the root set was always empty, and the
 * cycle fallback picked an arbitrary node. For a chain that is the far end: the queue
 * held the check node and the chain had nothing to start it, so every node stayed idle.
 *
 * E1 a chain starts at its head, not its tail
 * E2 a graph with no edges queues every node
 * E3 a genuine cycle still starts somewhere, rather than silently never running
 */
describe('HB-290: entry nodes are the ones nothing points at', () => {
  const chain = (ids: string[]) => ({
    schemaVersion: 2, name: 'chain',
    protocols: { out: { type: 'object', required: ['v'], properties: { v: { type: 'string' } } } },
    nodes: Object.fromEntries(ids.map((id, index) => [id, {
      recipe: 'worker@1', task: id,
      inputs: { in: { protocol: 'out' } }, outputs: { out: { protocol: 'out' } },
      submission: { required: ['out'] },
    }])),
    modules: {},
    edges: Object.fromEntries(ids.slice(1).map((id, index) => [`${ids[index]}->${id}`, { from: `${ids[index]}.out`, to: `${id}.in`, enabled: true }])),
    inputs: {}, outputs: {},
  });

  const materialize = (definition: unknown) => {
    const store = new TaskStore(join(tmpdir(), `h290-${Math.random().toString(36).slice(2)}.sqlite`));
    store.db.prepare("INSERT INTO projects(id,root,grants) VALUES('p','/tmp/p','{}')").run();
    store.db.prepare("INSERT INTO tasks(id,project_id,request,phase,created_seq) VALUES('t','p','w','running',1)").run();
    const kernel = new KernelStore(store);
    materializeGraph(kernel, 't', definition as never, 'e');
    const queued = (store.db.prepare("SELECT node_id FROM kernel_queue WHERE task_id='t' AND kind='start' ORDER BY node_id").all() as { node_id: string }[]).map(r => r.node_id);
    store.db.close();
    return queued;
  };

  test('E1: a chain starts at its head, not its tail', () => {
    // Node ids sort so that the LAST node comes first alphabetically - the case that hid
    // the bug, because the arbitrary fallback then chose the tail.
    expect(materialize(chain(['n0', 'n1', 'check']))).toEqual(['n0']);
  });

  test('E2: a graph with no edges queues every node', () => {
    expect(materialize(chain(['only']))).toEqual(['only']);
  });

  test('E3: a genuine cycle still starts somewhere rather than silently never running', () => {
    const cyclic = chain(['a', 'b']);
    const definition = cyclic as unknown as { edges: Record<string, { from: string; to: string; enabled: boolean }> };
    definition.edges['b->a'] = { from: 'b.out', to: 'a.in', enabled: true };
    expect(materialize(cyclic).length).toBe(1);
  });
});
