// The COMPLEX-tier v40 shape, run for real (R23): the proposal the user drew, fed verbatim to the
// runtime — real TaskStore, real OperationLifecycle, scripted Agent lanes in place of the model.
//
//   planner ─→ plan-reviewer (accept | replan ──loop──→ planner)
//                  │ accept
//                  ▼
//              worker-1 ─→ review-1 ┐
//              worker-2 ─→ review-2 ├─→ synth (pass | fail) ─→ deliver (graph.human_check)
//              worker-3 ─→ review-3 ┘        ▲
//                                            └──── fail loops back to ALL THREE workers
//
// The four things v40 adds over the published shape (tests/console/complex-tier-shape.test.ts, which
// has one worker, a `graph.verify` Pass? diamond, and a parallel plan lane) are pinned here.
//
// ── Failure modes, written before the code (R24) ───────────────────────────────────────────────────
//
// FM1  The plan gate is decorative: a `replan` verdict still dispatches the three workers.
//      Evidence for the mechanism: `GraphPlan` only ADDS plan-reviewer as a dependency of each worker
//      (src/core/graph.ts:33-46); what actually blocks them is `GraphState.readiness`, which returns
//      `skip` when the condition node's route is not the awaited case (src/core/graph.ts:125-131).
//      A `dependsOn`-only graph therefore dispatches every worker anyway — exactly the negative
//      control below.
//      Negative control: delete `when` from worker-1..3 and the same assertion must FAIL.
//
// FM2  synth's `fail` never reaches a loop: the route is refused, or the case is declared but the
//      edge never fires, and the delivery sails past a failed review.
//      Evidence: the branch is read from the router's own result and only among declared cases
//      (src/core/operation-lifecycle.ts:1090-1108); a routed branch reactivates its loop targets and
//      writes `graph.rework` (src/core/operation-lifecycle.ts:1281-1290).
//      Negative control: have synth answer an undeclared case (`nope`) — that must be refused with
//      `Router must return a declared case`, and must produce NO rework at all.
//
// FM3  Batch rework degrades into single-target rework: one failed verdict sends back only the worker
//      it names, so the other two keep their round-1 output and synth judges a mixed batch.
//      Evidence: `routed` is `plan.loops.filter(...)` on `from`+`case` — a filter, not a find —
//      (src/core/operation-lifecycle.ts:1114-1116), and `reactivate` takes the whole `to` list.
//      Negative control: declare ONE `synth--fail-->` loop instead of three and the same assertion
//      must FAIL, with the other two workers provably never re-dispatched.
//
// FM4  The human acceptance gate is bypassed: `deliver` is dispatched while synth said `fail`.
//      `deliver` carries NO `when` in v40 — its only gate is `dependsOn: ['synth']`, and that
//      dependency is satisfied by a *failed* verdict too. What keeps the gate shut is the same
//      `reactivate` as FM2/FM3: the rework resets synth and everything downstream of the targets,
//      `deliver` included (`reactivate` walks `GraphPlan.dependents`, src/core/graph.ts).
//      Negative control: drop the three `synth--fail-->` loops and the acceptance prompt opens
//      anyway — the proof that FM4's positive assertion measures the gate and not the clock.
//      (Reviewing the plan changed this control's original wording: removing `acceptance.checkNode`
//      is refused by `validateProposal` (src/core/proposal.ts:63-72), so that variant proves a static
//      rule, not a runtime gate, and would have been a tautology here.)
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, LoopSpec, NodeSpec, Operation, OperationResult, Proposal } from '../../src/core/types.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };
/** The v40 binding: implementers on `coder@10`, reviewers on `reviewer@8`, synth on `synthesizer@1`. */
const coder = { definitionVersion: 'coder@10', model: 'opencode-go:space-bunny-free' };
const reviewer = { definitionVersion: 'reviewer@8', model: 'opencode-go:space-bunny-free' };
const synthesizer = { definitionVersion: 'synthesizer@1', model: 'opencode-go:space-bunny-free' };

/** v40 exactly as proposed: same nodes, same loops, same single acceptance item. */
const v40Nodes: NodeSpec[] = [
  {
    id: 'planner', kind: 'agent', action: 'plan', ...coder,
    input: { focus: '把任务拆成三个可并行子任务的可执行计划，写入 plans/plan.md' },
    deliverable: { path: 'plans/plan.md', namespace: 'plans', name: 'plan', title: '执行计划' },
  },
  {
    id: 'plan-reviewer', kind: 'agent', action: 'review-plan', ...reviewer,
    dependsOn: ['planner'], routes: ['accept', 'replan'],
    input: { focus: '审查计划是否可行；通过则放行并把最终 plan 汇报给使用者，不通过则要求返工', route: { declared: null } },
    context: { purpose: 'review', predecessors: [{ source: 'planner', mode: 'evidence_only' }] },
    deliverable: { path: 'deliverables/plan-review.md', namespace: 'reviews', name: 'plan-review', title: '计划评审报告' },
  },
  ...([1, 2, 3] as const).map((index): NodeSpec => ({
    id: `worker-${index}`, kind: 'agent', action: 'implement', ...coder,
    dependsOn: ['planner'], when: { node: 'plan-reviewer', case: 'accept' },
    input: { focus: `按已过审的计划完成子任务 ${index}` },
    context: { purpose: 'implement', predecessors: [{ source: 'planner', mode: 'evidence_only' }] },
  })),
  ...([1, 2, 3] as const).map((index): NodeSpec => ({
    id: `review-${index}`, kind: 'agent', action: 'review', ...reviewer,
    dependsOn: [`worker-${index}`],
    input: { focus: `只评 worker-${index} 的成果` },
    context: { purpose: 'review', predecessors: [{ source: `worker-${index}`, mode: 'evidence_only' }] },
    deliverable: { path: `deliverables/review-${index}.md`, namespace: 'reviews', name: `review-${index}`, title: `评审 ${index} 报告` },
  })),
  {
    id: 'synth', kind: 'agent', action: 'synthesize', ...synthesizer,
    dependsOn: ['review-1', 'review-2', 'review-3'], routes: ['pass', 'fail'],
    input: { focus: '收齐三份评审报告，给出通过/不通过的判定', route: { declared: null } },
    context: {
      purpose: 'review',
      predecessors: [
        { source: 'review-1', mode: 'evidence_only' },
        { source: 'review-2', mode: 'evidence_only' },
        { source: 'review-3', mode: 'evidence_only' },
      ],
    },
    deliverable: { path: 'summaries/synthesis.md', namespace: 'summaries', name: 'synthesis', title: '评审汇总与判定' },
  },
  { id: 'deliver', kind: 'program', action: 'graph.human_check', dependsOn: ['synth'], input: {} },
];

const v40Loops: LoopSpec[] = [
  { from: 'plan-reviewer', to: 'planner', case: 'replan' },
  { from: 'synth', to: 'worker-1', case: 'fail' },
  { from: 'synth', to: 'worker-2', case: 'fail' },
  { from: 'synth', to: 'worker-3', case: 'fail' },
];

const v40Acceptance = [
  { id: 'human-accept', description: '使用者确认整份交付可接受（先经主 Agent 用 review_human_check 审证据）', checkNode: 'deliver' },
];

const workers = ['worker-1', 'worker-2', 'worker-3'] as const;
const reviews = ['review-1', 'review-2', 'review-3'] as const;

/** Every file a node declares as its deliverable, so each scripted lane really writes it. */
const deliverablePathOf = new Map(v40Nodes.flatMap(node => (node.deliverable ? [[node.id, node.deliverable.path]] : [])));

/** The Agent lane result the runtime accepts from every lane (result_handoff@1 shape). */
const laneResult = (note: string, route?: string): OperationResult => ({
  outcome: 'completed', usage,
  output: {
    schemaVersion: 1, objective: 'v40 lane', outcome: 'completed', workSummary: note,
    changes: [], decisions: [], verification: [], knownLimits: [], openQuestions: [], nextActions: [],
  },
  ...(route ? { route } : {}),
});

interface Dispatched {
  /** node id per dispatch, in dispatch order — the only record of "this lane was really sent". */
  readonly log: string[];
  count(nodeId: string): number;
  countOf(nodeIds: readonly string[]): number[];
}

/**
 * One scripted lane per action. Each records the dispatch and writes the file its node declared, so
 * a lane that is never dispatched is visible as an absent record rather than as a passing assertion.
 */
function scriptedActions(routes: { plan?: string[]; synth?: string[] }, dispatched: Dispatched): Record<string, ActionAdapter> {
  const nth = (script: string[] | undefined, attempt: number) =>
    script ? script[Math.min(attempt - 1, script.length - 1)]! : null;
  const lane = (note: (nodeId: string) => string, route?: (nodeId: string, attempt: number) => string | null): ActionAdapter => ({
    kind: 'agent', reserveTokens: 100,
    prepare: async (operation: Operation) => async () => {
      dispatched.log.push(operation.nodeId);
      const path = deliverablePathOf.get(operation.nodeId);
      if (path && operation.workspace) {
        const target = join(operation.workspace, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, `# ${operation.nodeId}\n\n${note(operation.nodeId)} round ${operation.attempt}\n`);
      }
      return laneResult(note(operation.nodeId), route?.(operation.nodeId, operation.attempt) ?? undefined);
    },
  });
  return {
    plan: lane(nodeId => `${nodeId} wrote the plan`),
    'review-plan': lane(nodeId => `${nodeId} reviewed the plan`, (_nodeId, attempt) => nth(routes.plan, attempt)),
    implement: lane(nodeId => `${nodeId} implemented its lane`),
    review: lane(nodeId => `${nodeId} reviewed its worker`),
    synthesize: lane(nodeId => `${nodeId} synthesised`, (_nodeId, attempt) => nth(routes.synth, attempt)),
  };
}

async function setup(options: {
  routes?: { plan?: string[]; synth?: string[] };
  nodes?: NodeSpec[];
  loops?: LoopSpec[];
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-v40-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const log: string[] = [];
  const dispatched: Dispatched = {
    log,
    count: nodeId => log.filter(id => id === nodeId).length,
    countOf: nodeIds => nodeIds.map(nodeId => log.filter(id => id === nodeId).length),
  };
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    actions: scriptedActions(options.routes ?? {}, dispatched),
  });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: '复杂档 v40', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: '复杂档 v40', acceptance: v40Acceptance,
    nodes: options.nodes ?? v40Nodes, loops: options.loops ?? v40Loops,
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  const task = runtime.user.task(taskId);
  /** Poll the public view until the observable the test is about has happened — never a fixed sleep. */
  const driveUntil = async (reached: () => boolean) => {
    for (let tick = 0; tick < 300 && !reached(); tick += 1) {
      await runtime.host.runReady();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(reached(), 'the graph never reached the state this test is about').toBe(true);
  };
  const reworkEvents = async () => (await runtime.events(taskId))
    .filter(event => event.type === 'graph.rework')
    .map(event => event.data as { from: string; to: string[]; via: string; route: string });
  /** Acceptance prompts that actually reached the user's inbox for `deliver`. */
  const acceptancePrompts = async () => (await task.view())
    .questions.filter(question => question.kind === 'human_check' && question.nodeId === 'deliver');
  const nodeStatus = async (nodeId: string) =>
    (await task.view()).nodes.find(node => node.id === nodeId)?.status;
  /** Drive until a node itself reaches one of `statuses` — a refused submission never dispatches. */
  const driveNode = async (nodeId: string, statuses: string[]) => {
    for (let tick = 0; tick < 300; tick += 1) {
      const status = await nodeStatus(nodeId);
      if (status && statuses.includes(status)) return status;
      await runtime.host.runReady();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return nodeStatus(nodeId);
  };
  /**
   * More of the harness's own dispatch sweeps. Node settlement is asynchronous, so a sweep is how a
   * node that has become ready actually gets SENT; comparing two graph shapes over the same number
   * of sweeps is what makes "the acceptance gate opened" a fact about the graph and not about timing.
   */
  const sweep = async (times = 1) => {
    for (let tick = 0; tick < times; tick += 1) {
      await runtime.host.runReady();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  return { root, runtime, task, taskId, dispatched, driveUntil, driveNode, reworkEvents, acceptancePrompts, sweep };
}

test('FM1: a replan verdict sends the plan back and dispatches no worker at all', async () => {
  const v40 = await setup({ routes: { plan: ['replan', 'accept'], synth: ['pass'] } });

  // Stop the graph at the moment the plan gate says `replan`.
  await v40.driveUntil(() => v40.dispatched.count('plan-reviewer') === 1);
  // Nothing downstream of the plan may have been sent: the gate is a gate, not a hint.
  expect(v40.dispatched.log.filter(id => [...workers, ...reviews, 'synth', 'deliver'].includes(id))).toEqual([]);
  // And the planner really was reactivated by the loop — a gate that merely blocked would pass the
  // first two assertions too.
  expect(v40.dispatched.count('planner')).toBe(1);
  const replans = (await v40.reworkEvents()).filter(event => event.from === 'plan-reviewer');
  expect(replans).toEqual([{ from: 'plan-reviewer', to: ['planner'], via: 'route', route: 'replan' }]);

  // After `accept` the three lanes do start, so the assertions above are not "nothing ever ran".
  await v40.driveUntil(() => v40.dispatched.count('worker-3') === 1);
  expect(v40.dispatched.countOf(workers)).toEqual([1, 1, 1]);
});

test('FM1 negative control: with `when` deleted, the same replan verdict dispatches all three workers', async () => {
  // This is the degeneration FM1 exists to catch. `dependsOn: ['planner']` alone only ORDERS the
  // workers; it does not block them. The assertion below is the same "no worker was dispatched"
  // statement FM1 makes, and here it is known to be FALSE — so FM1 is measuring the gate.
  const ungated: NodeSpec[] = v40Nodes.map(({ when: _gate, ...node }) => node);
  expect(ungated.some(node => 'when' in node)).toBe(false); // the control really removed the gate
  const v40 = await setup({ routes: { plan: ['replan', 'accept'], synth: ['pass'] }, nodes: ungated });

  await v40.driveUntil(() => v40.dispatched.count('plan-reviewer') === 1);
  expect(v40.dispatched.countOf(workers)).toEqual([1, 1, 1]);
});

test('FM2: synth answering `fail` really fires the declared edges and the batch runs again', async () => {
  const v40 = await setup({ routes: { plan: ['accept'], synth: ['fail', 'pass'] } });

  // Round 1 fails, round 2 passes: the rework is observable, and so is the batch redo.
  await v40.driveUntil(() => v40.dispatched.count('synth') === 2);
  expect(await v40.reworkEvents()).toEqual([{
    from: 'synth', to: ['worker-1', 'worker-2', 'worker-3'], via: 'route', route: 'fail',
  }]);
  expect(v40.dispatched.countOf(workers)).toEqual([2, 2, 2]);
  // The three lanes went back, not just one of them; `review` follows each worker, so it reruns too.
  expect(v40.dispatched.countOf(reviews)).toEqual([2, 2, 2]);
});

test('FM2 negative control: an undeclared case is refused, and no rework happens at all', async () => {
  // The degeneration FM2 guards is the dead `fail` edge. A router that answers a case it never
  // declared is the cheapest way to get one, and the harness must refuse it rather than let the
  // delivery through on a verdict nobody declared.
  const v40 = await setup({ routes: { plan: ['accept'], synth: ['nope'] } });

  await v40.driveUntil(() => v40.dispatched.count('synth') === 1);
  expect(await v40.driveNode('synth', ['failed', 'blocked'])).toBeTruthy();
  // Nothing was routed, so no loop could have fired and no lane could have been sent back.
  expect(await v40.reworkEvents()).toEqual([]);
  expect(v40.dispatched.countOf(workers)).toEqual([1, 1, 1]);
  const synthQuestions = (await v40.task.view()).questions.filter(question => question.nodeId === 'synth');
  expect(synthQuestions.map(question => ({ kind: question.kind, owner: question.owner, status: question.status })))
    .toEqual([{ kind: 'recovery', owner: 'user', status: 'open' }]);
  expect(JSON.stringify(synthQuestions[0]?.data)).toContain('Router must return a declared case');
});

test('FM3: one `fail` verdict sends all three workers back, in the declared order', async () => {
  // Batch rework is the point of v40: `fail` names no lane, so the whole batch is redone rather than
  // only the worker a reviewer happened to mention. Three `from+case` loops, three targets.
  const v40 = await setup({ routes: { plan: ['accept'], synth: ['fail', 'fail', 'pass'] } });

  await v40.driveUntil(() => v40.dispatched.count('synth') === 3);
  const reworks = await v40.reworkEvents();
  // Exactly the declared edges, exactly twice, never a subset and never a reordering.
  expect(reworks.map(event => event.to)).toEqual([
    ['worker-1', 'worker-2', 'worker-3'],
    ['worker-1', 'worker-2', 'worker-3'],
  ]);
  // Two redone batches plus the first one: no worker kept a round-1 output.
  expect(v40.dispatched.countOf(workers)).toEqual([3, 3, 3]);
});

test('FM3 negative control: one `fail` loop instead of three reworks exactly one worker', async () => {
  // The degeneration FM3 exists to catch. The same `fail` verdict, one declared edge: the rework
  // fires, so a test that only checks "a rework happened" still passes — and the batch silently
  // becomes a single-target redo.
  const single = v40Loops.filter(loop => !(loop.from === 'synth' && loop.to !== 'worker-1'));
  expect(single.filter(loop => loop.from === 'synth')).toHaveLength(1);
  const v40 = await setup({ routes: { plan: ['accept'], synth: ['fail', 'pass'] }, loops: single });

  await v40.driveUntil(() => v40.dispatched.count('synth') === 2);
  expect((await v40.reworkEvents()).map(event => event.to)).toEqual([['worker-1']]);
  // worker-1 ran twice; the other two kept their round-1 output and were never sent back.
  expect(v40.dispatched.countOf(workers)).toEqual([2, 1, 1]);
});

test('FM4: the human acceptance gate stays shut until synth passes, and opens exactly once', async () => {
  const v40 = await setup({ routes: { plan: ['accept'], synth: ['fail', 'pass'] } });

  // A failed synthesis verdict must not reach the acceptance gate. `deliver` has no `when` in v40 —
  // only `dependsOn: ['synth']`, which a failed verdict also satisfies — so what has to hold the
  // gate shut is the rework itself, not a condition on `deliver`.
  await v40.driveUntil(() => v40.dispatched.count('synth') === 1);
  await v40.sweep(3);
  expect(await v40.acceptancePrompts()).toEqual([]);

  // Only after `pass` does the check reach the person, and then exactly once.
  await v40.driveNode('deliver', ['blocked']);
  const prompts = await v40.acceptancePrompts();
  expect(prompts).toHaveLength(1);
  expect(prompts[0]?.owner).toBe('user');
  // The gate is open, not passed: the person still owns the verdict.
  expect((await v40.task.view()).phase).not.toBe('completed');
});

test('FM4 negative control: with the `fail` loops deleted, the same failed verdict opens the gate', async () => {
  // The degeneration FM4 exists to catch. Same graph, same `fail` verdict, same number of dispatch
  // sweeps as the test above — only the three `synth--fail-->` declarations are gone, and the
  // acceptance prompt opens anyway. That is what makes FM4's positive assertion a measurement of the
  // rework gate rather than of the passage of time.
  const noFailLoops = v40Loops.filter(loop => loop.from !== 'synth');
  expect(noFailLoops.filter(loop => loop.from === 'synth')).toEqual([]);
  const v40 = await setup({ routes: { plan: ['accept'], synth: ['fail', 'pass'] }, loops: noFailLoops });

  await v40.driveUntil(() => v40.dispatched.count('synth') === 1);
  await v40.sweep(3);
  // The prompt reached the inbox on the strength of a verdict nobody passed.
  expect(await v40.acceptancePrompts()).toHaveLength(1);
  // And no rework ever fired: the prompt did not wait for a pass that the edges would have forced.
  expect(await v40.reworkEvents()).toEqual([]);
});
