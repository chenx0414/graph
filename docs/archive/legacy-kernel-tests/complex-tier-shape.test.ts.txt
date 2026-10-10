// E2E for the COMPLEX-tier design example's draft shape (R23): a synthesised verdict routes the
// whole delivery, and the declared loop really sends the work back to the worker.
//
// The drawing the user made asks for one thing that is easy to get wrong, and the first draft of the
// graph DID get it wrong: the `Pass?` diamond cannot be a `byStatus` router. A check that has a
// verdict at all has COMPLETED, so `byStatus` would map its own status to "yes" every single time
// and the rework branch would be dead code. The verdict therefore has to travel in the router's own
// OUTPUT, read through `byField` — this file proves that path works, and pins the dead alternative.
//
//   planner ─→ worker ─→ reviewer-1..n ─→ synth ─→ PASS?(program, byField verdict)
//                  ↑                                      ├─ yes → haiku → human
//                  └──────────── loop case:'no' ───────────┤
//              └──────── loop case:'replan' ── plan-reviewer ──┘ (independent plan lane)
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { resolveRouteCase } from '../../src/core/router-action.ts';
import { loadGraph } from '../../src/core/graph.ts';
import { TaskStore } from '../../src/core/store.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, Json, LoopSpec, NodeSpec, Proposal } from '../../src/core/types.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };
const coder = { definitionVersion: 'coder@1', model: 'scripted' };

/** The draft complex-tier shape, with the synthesis verdict given per round. */
function shape(verdicts: string[]) {
  let workerRound = 0;
  const attempts: string[] = [];
  // The verdict sequence is consumed by the GATE, one entry per judged round. The reviewers simply
  // observe what the reviewer of this round would say: they read the same index the gate will read,
  // so both agree without a shared mutable cursor.
  const nodes: NodeSpec[] = [
    { id: 'planner', kind: 'agent', action: 'plan', ...coder },
    // A downstream agent that consumes an agent predecessor must declare how: `result_handoff`
    // asks the predecessor for a structured handoff, `evidence_only` reads only its evidence.
    { id: 'worker', kind: 'agent', action: 'implement', ...coder, dependsOn: ['planner'],
      context: { predecessors: [{ source: 'planner', mode: 'evidence_only' }] } },
    { id: 'reviewer-1', kind: 'agent', action: 'review-1', ...coder, dependsOn: ['worker'],
      context: { purpose: 'review', predecessors: [{ source: 'worker', mode: 'evidence_only' }] },
      deliverable: { path: 'reviews/reviewer-1.md', namespace: 'reviews', name: 'reviewer-1' } },
    { id: 'reviewer-2', kind: 'agent', action: 'review-2', ...coder, dependsOn: ['worker'],
      context: { purpose: 'review', predecessors: [{ source: 'worker', mode: 'evidence_only' }] },
      deliverable: { path: 'reviews/reviewer-2.md', namespace: 'reviews', name: 'reviewer-2' } },
    {
      // THE `Pass?` diamond, using the mechanism that actually computes a verdict. Only three program
      // actions exist (graph.verify / graph.command / graph.human_check), and a byField router reads
      // ITS OWN output — so the node that judges must be the node that routes. `multiview` is the
      // built-in for exactly the diagram's intent: one subject, N independent views, all required
      // dimensions must pass. A passing verdict completes with outcome 'pass', a failing one
      // completes with 'rework'; the branch is read from that outcome.
      id: 'pass', kind: 'program', action: 'graph.verify', dependsOn: ['worker', 'reviewer-1', 'reviewer-2'],
      routes: ['yes', 'no'],
      verifier: {
        kind: 'multiview', subjectNode: 'worker', reportNodes: ['reviewer-1', 'reviewer-2'],
        dimensions: [
          { id: 'correctness', required: true, reportNode: 'reviewer-1' },
          { id: 'fidelity', required: true, reportNode: 'reviewer-2' },
        ],
      },
      input: { route: { byField: { path: 'outcome', values: { pass: 'yes', rework: 'no' } } } },
    },
    // `pass` is a program, so no handoff policy is owed here; the synthesis verdict reached the
    // router through the router's own delivery, which is the point of putting the verdict there.
    { id: 'haiku', kind: 'agent', action: 'haiku', ...coder, dependsOn: ['pass'], when: { node: 'pass', case: 'yes' } },
    { id: 'plan-reviewer', kind: 'agent', action: 'plan-review', ...coder, dependsOn: ['planner'], routes: ['accept', 'replan'] },
  ];
  const loops: LoopSpec[] = [
    { from: 'pass', to: 'worker', case: 'no' },
    { from: 'plan-reviewer', to: 'planner', case: 'replan' },
  ];
  const plain = (output: Json) => ({ outcome: 'completed' as const, output, usage });
  const actions: Record<string, ActionAdapter> = {
    plan: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => plain({ plan: true }) },
    implement: { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => { workerRound += 1; return plain({ workerRound, attempt: operation.attempt }); } },
    'review-1': {
      kind: 'agent', reserveTokens: 100,
      prepare: async operation => async () => {
        const verdict = verdicts[Math.min(operation.attempt - 1, verdicts.length - 1)] === 'pass' ? 'pass' : 'fail';
        attempts.push(`review-1:${operation.attempt}:${verdict}`);
        await mkdir(join(operation.workspace!, 'reviews'), { recursive: true });
        await writeFile(join(operation.workspace!, 'reviews/reviewer-1.md'), `# reviewer-1\n${verdict}\n`);
        return plain({ note: 'r1', dimensions: { correctness: { verdict, evidence: 'reviewer 1' } } });
      },
    },
    'review-2': {
      kind: 'agent', reserveTokens: 100,
      prepare: async operation => async () => {
        // `operation.attempt` is the round of the work under review, maintained by the harness.
        const verdict = verdicts[Math.min(operation.attempt - 1, verdicts.length - 1)] === 'pass' ? 'pass' : 'fail';
        await mkdir(join(operation.workspace!, 'reviews'), { recursive: true });
        await writeFile(join(operation.workspace!, 'reviews/reviewer-2.md'), `# reviewer-2\n${verdict}\n`);
        return plain({ note: 'r2', dimensions: { fidelity: { verdict, evidence: 'reviewer 2' } } });
      },
    },
    // The check states its verdict in its own output, exactly as `graph.verify` does.
    'graph.verify': {
      kind: 'program' as const,
      prepare: async operation => async () => {
        const outcome = verdicts[Math.min(operation.attempt - 1, verdicts.length - 1)] === 'pass' ? 'pass' : 'rework';
        attempts.push(`gate:${operation.attempt}:${outcome}`);
        return plain({ kind: 'verification', outcome, subjects: [], reports: [], blockers: [] });
      },
    },
    haiku: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => plain({ haiku: true }) },
    'plan-review': { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ ...plain({ note: 'plan ok' }), route: 'accept' }) },
  };
  return { nodes, loops, actions, acceptance: [
    { id: 'pass-yes', description: 'all reviewers agreed, so the synthesis verdict is pass', checkNode: 'pass' },
    { id: 'plan-accepted', description: 'the plan review accepted the plan', checkNode: 'plan-reviewer' },
  ] as Proposal['acceptance'] };
}

async function setup(verdicts: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'graph-complex-tier-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const fixture = shape(verdicts);
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: fixture.actions });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'complex tier', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'complex tier', acceptance: fixture.acceptance, nodes: fixture.nodes, loops: fixture.loops,
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  return { root, runtime, task: runtime.user.task(taskId), taskId, stateDir: join(root, 'state') };
}

async function drive(runtime: Awaited<ReturnType<typeof setup>>['runtime'], rounds = 14) {
  for (let i = 0; i < rounds; i++) await runtime.host.runReady();
}

test('a rework verdict really fires the declared edge back to the worker, and only there', async () => {
  // `rework` for the first judged round: the loop must fire. Asserted on the durable event the
  // harness writes when a router sends work back (`graph.rework`, `via: 'route'`), which is the
  // behaviour the drawing depends on - not on operation counts, which timing can move.
  const { runtime, task, taskId, stateDir } = await setup(['rework', 'pass']);
  await drive(runtime);
  const store = new TaskStore(join(stateDir, 'tasks.sqlite'));
  cleanup.push(async () => store.close());

  const rework = store.db.prepare("SELECT data FROM events WHERE task_id=? AND type='graph.rework'").all(taskId)
    .map((row: any) => JSON.parse(String(row.data)) as { from: string; to: string[]; via: string });
  expect(rework.length).toBeGreaterThanOrEqual(1);
  expect(rework.every(item => item.from === 'pass')).toBe(true);
  expect(rework.every(item => JSON.stringify(item.to) === JSON.stringify(['worker']))).toBe(true);

  // The independent plan lane ran once: its own rework edge was never taken.
  const view = await task.view();
  expect(view.operations.filter(operation => operation.nodeId === 'planner').length).toBe(1);
});
test('an unmet synthesis verdict loops forever rather than letting the delivery through', async () => {
  const { runtime, task } = await setup(['rework']);
  await drive(runtime, 8);
  const view = await task.view();
  expect(view.operations.filter(operation => operation.nodeId === 'haiku').length).toBe(0);
  expect(view.phase).not.toBe('completed');
});

test('byStatus on the Pass? diamond could never produce the rework branch', () => {
  // This is the defect the first draft had, and this is why: a check that HAS a verdict has
  // completed, so mapping its own status always yields the pass branch.
  const decision = resolveRouteCase({
    nodeId: 'pass', routes: ['yes', 'no'], status: 'completed', output: { verdict: 'rework' },
    source: { byStatus: { completed: 'yes', failed: 'no' } },
  });
  expect(decision).toEqual({ case: 'yes' });
  // The same result through byField, which is what the graph must declare instead.
  expect(resolveRouteCase({
    nodeId: 'pass', routes: ['yes', 'no'], status: 'completed', output: { verdict: 'rework' },
    source: { byField: { path: 'verdict', values: { pass: 'yes', rework: 'no' } } },
  })).toEqual({ case: 'no' });
});
