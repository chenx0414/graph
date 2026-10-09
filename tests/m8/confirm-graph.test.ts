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
import { createApp } from '../../src/server/app.ts';
import type { ActionAdapter, Operation, OperationResult, NativeProposal } from '../../src/core/types.ts';

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
 * Confirmation establishes structure, not work. The main agent explicitly delivers
 * the first input through the same validated queue used for subsequent executions.
 * Drafts without a native definition are rejected before feature creation.
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
    a: { recipe: 'a@1', task: 'a', inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
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

  test('W2: admitted nodes retain instance identities while awaiting input', () => {
    const s = store();
    const kernel = new KernelStore(s);
    materializeGraph(kernel, 't1', DEFINITION, 'w2');
    // A display-only row would have no instance id and the executor could not run it.
    const a = s.db.prepare("SELECT instance_id FROM kernel_nodes WHERE task_id='t1' AND node_id='a'").get() as { instance_id: string | null };
    expect(a.instance_id).toBeTruthy();
    expect(kernel.nextQueued('t1', 'a')).toBeNull();
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
    const briefings: string[] = [];
    const runtime = await openTaskRuntime({
      stateDir: join(root, 'state'),
      projects: [{ id: 'p', root: project }],
      actions: { master: scripted(operation => { briefings.push(operation.context.briefing ?? ''); return { outcome: 'completed', output: { text: 'draft ready' }, usage }; }) },
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
      definition: { ...DEFINITION, acceptance: [{ id: 'works', description: '链跑通', kind: 'human' }] },
    }, 'proposal-v2');

    const app = await createApp(runtime, { origin: 'http://127.0.0.1:1' });
    cleanup.push(() => app.close());
    const home = await app.inject({ method: 'GET', url: '/' });
    const headers = { cookie: String(home.headers['set-cookie'] ?? '') };
    const ownerGraphResponse = await app.inject({ method: 'GET', url: `/api/tasks/${anchorTaskId}/graph`, headers });
    expect(ownerGraphResponse.statusCode).toBe(200);
    expect(ownerGraphResponse.json()).toMatchObject({ nodes: [], containers: [], layout: { positions: {}, edges: [] } });

    const draftResponse = await app.inject({ method: 'GET', url: `/api/conversations/${created.conversationId}/draft-graph`, headers });
    expect(draftResponse.statusCode).toBe(200);
    const draft = draftResponse.json();
    expect(draft.nodes.map((node: { id: string }) => node.id)).toEqual(['a', 'b', 'gate']);
    expect(draft.nodes.find((node: { id: string }) => node.id === 'gate')).toMatchObject({ kind: 'module', status: 'draft', action: 'route' });
    expect(draft.layout.edges).toMatchObject([{ id: 'ab', source: 'a', target: 'b' }]);
    expect(draft.interfaces).toMatchObject([{ edgeId: 'ab', from: 'a.out', to: 'b.in', protocol: 'ping', latest: null, deliveries: [] }]);

    const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });

    const runningResponse = await app.inject({ method: 'GET', url: `/api/tasks/${confirmed.taskId}/graph`, headers });
    expect(runningResponse.statusCode).toBe(200);
    const running = runningResponse.json();
    expect(running.nodes.map((node: { id: string }) => node.id)).toEqual(['a', 'b', 'gate']);
    expect(running.nodes.every((node: { status: string }) => node.status === 'idle')).toBe(true);
    expect(running.layout).toEqual(draft.layout);
    expect(running.interfaces).toMatchObject([{ edgeId: 'ab', from: 'a.out', to: 'b.in', protocol: 'ping', latest: null, deliveries: [] }]);
    await expect(runtime.supervisor(confirmed.taskId).graphState()).resolves.toMatchObject({
      taskId: confirmed.taskId, graphVersion: 1, graph: { schemaVersion: 2 },
      nodes: expect.arrayContaining([expect.objectContaining({ id: 'a', status: 'idle', origin: 'v2' })]),
    });

    await runtime.host.drive();
    expect(briefings.join('\n')).toContain(`Graph ${confirmed.taskId} is ready`);
    expect(briefings.join('\n')).toContain('graph_send');
    // Replaying confirmation must not wake main twice.
    const count = briefings.length;
    await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });
    await runtime.host.drive();
    expect(briefings).toHaveLength(count);

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

  test('W6: a legacy draft cannot create a feature through conversation confirmation', async () => {
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
    await expect(runtime.supervisor(anchorTaskId).propose({
      requirementVersion: 1, summary: '旧方案',
      acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
      nodes: [
        { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm' },
        { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
      ],
    } as unknown as NativeProposal, 'proposal-old')).rejects.toMatchObject({ code: 'invalid_proposal' });
    await expect(runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' }))
      .rejects.toMatchObject({ code: 'stale_proposal' });
    expect((await runtime.conversations.view(created.conversationId)).tasks).toEqual([]);
    const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM graph_revisions').get()).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM kernel_graph_owners').get()).toEqual({ n: 0 });
    store.db.close();
  });
});

/** Confirmation creates structure; every first execution requires an explicit valid input. */
describe('confirmed graphs await explicit input', () => {
  test.each(['chain', 'disconnected', 'cycle'])('%s does not invent an entry task', shape => {
    const s = store();
    const kernel = new KernelStore(s);
    const graph = structuredClone(DEFINITION);
    if (shape === 'disconnected') graph.edges = {};
    if (shape === 'cycle') graph.edges.ba = { from: 'b.out', to: 'a.in', enabled: true };
    materializeGraph(kernel, 't1', graph, 'confirm');
    const runtime = new GraphRuntime(kernel, 't1');
    expect(kernel.nextQueued('t1', 'a')).toBeNull();
    expect(kernel.nextQueued('t1', 'b')).toBeNull();
    expect(() => runtime.deliver({ nodeId: 'a', input: 'in', value: {} })).toThrow(/n/);
    expect(kernel.nextQueued('t1', 'a')).toBeNull();
    runtime.deliver({ nodeId: 'a', input: 'in', value: { n: 1 } });
    expect(kernel.nextQueued('t1', 'a')).toMatchObject({ kind: 'delivery' });
    expect(kernel.nextQueued('t1', 'b')).toBeNull();
    s.close();
  });
});
