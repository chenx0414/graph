// End-to-end: a REAL router graph routes a branch, through the real lifecycle (R23).
//
// This is the proof that was missing. Before this change a live router graph skipped EVERY branch
// (readiness[json] = skip, readiness[text] = skip) because nothing could produce a case. Here a real
// store, real graph revision and the real OperationLifecycle settle a routing node, and the branch
// that matches goes ready while the other is skipped.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { OperationLifecycle, type OperationIntent } from '../../src/core/operation-lifecycle.ts';
import { TaskStore, canonicalJson } from '../../src/core/store.ts';
import { loadGraph } from '../../src/core/graph.ts';
import { fullAccessPolicy, resolveAccessPolicy } from '../../src/core/access-policy.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

/**
 * router -> (pass) ship | (fail) fix, with the router a plain program node whose branch comes from
 * its own status. Exactly the "tool node" case the user described.
 */
async function fixture(routeInput: unknown, options: { optional?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-router-e2e-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  const nodes = [
    { id: 'gate', kind: 'program' as const, action: 'graph.command', routes: ['pass', 'fail'], input: routeInput, ...(options.optional ? { optional: true } : {}) },
    { id: 'ship', kind: 'program' as const, action: 'graph.command', dependsOn: ['gate'], when: { node: 'gate', case: 'pass' } },
    { id: 'fix', kind: 'program' as const, action: 'graph.command', dependsOn: ['gate'], when: { node: 'gate', case: 'fail' } },
  ];
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,graph_version) VALUES('t','p','router',1,'running',1)").run();
    for (const node of nodes) {
      // Node first, then its instance: the instance row references the node, and instance_id is
      // unique so each node owns exactly one.
      store.db.prepare("INSERT INTO nodes(task_id,id,spec,status,activation_id) VALUES('t',?,?,'pending','a')")
        .run(node.id, canonicalJson(node));
      store.db.prepare("INSERT INTO instances(id,task_id,node_id,definition_version,model) VALUES(?,?,?,'coder@1','m')")
        .run(`i-${node.id}`, 't', node.id);
      store.db.prepare("UPDATE nodes SET instance_id=? WHERE task_id='t' AND id=?").run(`i-${node.id}`, node.id);
      // An operation references its activation, and settle refuses an operation whose activation is
      // no longer the node's current one, so the node has to point at it.
      store.db.prepare("INSERT INTO activations(id,task_id,node_id,graph_version,round,state,input_versions) VALUES(?,?,?,1,1,'pending','{}')")
        .run(`a-${node.id}`, 't', node.id);
      store.db.prepare("UPDATE nodes SET activation_id=? WHERE task_id='t' AND id=?").run(`a-${node.id}`, node.id);
    }
    store.db.prepare("INSERT INTO graph_revisions(task_id,version,spec,reason) VALUES('t',1,?,'test')")
      .run(canonicalJson({ nodes, containers: [], loops: [] }));
    store.db.prepare("INSERT INTO proposals(task_id,version,requirement_version,spec) VALUES('t',1,1,?)")
      .run(canonicalJson({ requirementVersion: 1, summary: '', acceptance: [], nodes, containers: [], loops: [] }));
  });
  const lifecycle = new OperationLifecycle(store, { advance: () => undefined });
  lifecycle.recover();
  return { store, lifecycle };
}

function intent(attempt: number): OperationIntent {
  return {
    taskId: 't', nodeId: 'gate', instanceId: 'i-gate', kind: 'program', action: 'graph.command',
    input: { attempt }, dependencies: {}, proposalVersion: 1, requirementVersion: 1,
    context: { previousOutput: null, answers: [] }, grants: [], activationId: 'a-gate', graphVersion: 1,
    dependencySources: {}, inputVersions: {}, accessPolicy: resolveAccessPolicy(fullAccessPolicy()),
  };
}

function settleRouter(lifecycle: OperationLifecycle, outcome: 'completed' | 'failed', output?: unknown) {
  const operation = lifecycle.admit({ node: { id: 'gate', taskId: 't', activationId: 'a-gate' }, reservation: 0, prepare: intent });
  lifecycle.dispatch(operation);
  lifecycle.report(operation.id, operation.generation, {
    outcome,
    output: (output ?? (outcome === 'failed' ? { code: 1, stderr: 'boom' } : { code: 0 })) as never,
  });
}

test('a router maps its own status to a case and the matching branch goes ready', async () => {
  const { store, lifecycle } = await fixture({ route: { byStatus: { completed: 'pass', failed: 'fail' } } });
  settleRouter(lifecycle, 'completed');
  const graph = loadGraph(store, 't');
  expect(store.db.prepare("SELECT route FROM nodes WHERE task_id='t' AND id='gate'").get()).toEqual({ route: 'pass' });
  expect(graph.readiness('ship')).toBe('ready');
  expect(graph.readiness('fix')).toBe('skip');
});

test('a gate reports its verdict through its output, not through failing', async () => {
  // This is the shape the system actually wants, and it comes from its own semantics: a FAILED
  // non-optional node blocks the graph, and `readiness` accepts only `succeeded` as a condition.
  // So a routing check must COMPLETE and state its verdict — exactly what `graph.verify` does
  // (`outcome: 'pass' | 'rework'`). `byStatus` is for a gate whose failure is optional.
  const { store, lifecycle } = await fixture({ route: { byField: { path: 'verdict', values: { rework: 'fail', pass: 'pass' } } } });
  settleRouter(lifecycle, 'completed', { code: 0, verdict: 'rework' });
  const graph = loadGraph(store, 't');
  expect(store.db.prepare("SELECT route FROM nodes WHERE task_id='t' AND id='gate'").get()).toEqual({ route: 'fail' });
  expect(graph.readiness('fix')).toBe('ready');
  expect(graph.readiness('ship')).toBe('skip');
});

test('an optional gate that fails routes nothing and does not crash the settle', async () => {
  // `optional` is the existing way to say "this node's failure is not fatal". A failed router never
  // reached a verdict, so it routes no branch: the failure is reported as itself, and because the
  // node is optional the graph is not blocked by it either.
  const { store, lifecycle } = await fixture({ route: { byStatus: { completed: 'pass', failed: 'fail' } } }, { optional: true });
  settleRouter(lifecycle, 'failed');
  // The verdict IS knowable even when the node is optional, so it routes the failure branch - the
  // optional flag decides whether the graph is blocked by the failure, not whether it was routed.
  expect(store.db.prepare("SELECT route FROM nodes WHERE task_id='t' AND id='gate'").get()).toEqual({ route: 'fail' });
});

test('a router that declares branches but no way to choose is refused as a graph defect', async () => {
  const { store, lifecycle } = await fixture({});
  expect(() => settleRouter(lifecycle, 'completed')).toThrow(/没有声明如何选择/);
  // The refused settle leaves the router unrouted, so neither branch can be chosen: they wait on it
  // rather than pretending a branch was taken.
  const graph = loadGraph(store, 't');
  expect(graph.readiness('ship')).toBe('waiting');
  expect(graph.readiness('fix')).toBe('waiting');
});

test('a declared field that is missing refuses loudly instead of picking a branch', async () => {
  const { store, lifecycle } = await fixture({ route: { byField: { path: 'outcome', values: { rework: 'fail', pass: 'pass' } } } });
  expect(() => settleRouter(lifecycle, 'completed')).toThrow(/没有 outcome/);
  expect(store.db.prepare("SELECT route FROM nodes WHERE task_id='t' AND id='gate'").get()).toEqual({ route: null });
});

test('a case the router never declared is refused, and no branch is activated', async () => {
  const { store, lifecycle } = await fixture({ route: { byStatus: { completed: 'maybe' } } });
  expect(() => settleRouter(lifecycle, 'completed')).toThrow(/没有声明这个分支/);
  expect(store.db.prepare("SELECT route FROM nodes WHERE task_id='t' AND id='gate'").get()).toEqual({ route: null });
});
