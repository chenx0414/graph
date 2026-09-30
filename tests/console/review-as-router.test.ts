// Failure modes for "review is the router", written before the code (R24).
//
// The user's design, in their own words: remove the `graph.verify` gate and let the reviewer decide
// for itself whether the work goes back. A review node routes, and the route is read from what the
// reviewer said about itself (submit_result carries `route` plus a note) — not from a structured
// JSON tool call, and not from a program that re-derives a verdict.
//
//   impl-X ─→ review-X(agent, router) ─┬─ route:'pass' → downstream
//                                      └─ route:'fail' ─loop─→ impl-X
//
// Failure modes this file pins down:
// 1. A reviewer that says 'fail' sends its implementer back WITHOUT any gate node existing — the
//    loop is driven by the route, not by a verification verdict.
// 2. A reviewer that says 'pass' releases the downstream branch instead of looping.
// 3. An acceptance item may be bound to an agent router node: "this reviewer passed" IS the
//    acceptance, recorded as the review the reviewer itself wrote.
// 4. A routed loop does NOT count as acceptance: the reviewer judged the work not done.
// 5. A reviewer that declares branches but gives no route is refused (unchanged rule).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { independentReviewReady } from '../../src/core/model-selection.ts';
import { loadGraph } from '../../src/core/graph.ts';
import { git } from '../../src/git/git.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, LoopSpec, NodeSpec, Proposal } from '../../src/core/types.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };
const coder = { definitionVersion: 'coder@1', model: 'scripted' };
const REVIEW_PATH = 'reviews/review-a.md';

/** A lane shaped exactly like the user's design: implement -> review(router) -> [pass] downstream. */
function lane(steps: { route: string; note: string }[], options: { deliverable?: boolean; downstreamHandoff?: boolean } = {}) {
  const withDeliverable = options.deliverable !== false;
  const withDownstreamHandoff = options.downstreamHandoff === true;
  let round = 0;
  const review: NodeSpec = {
    id: 'review-a', kind: 'agent', action: 'review-a', definitionVersion: 'reviewer@1', model: 'scripted-review',
    dependsOn: ['impl-a'], routes: ['pass', 'fail'], input: { route: { declared: null } },
    context: { purpose: 'review', predecessors: [{ source: 'impl-a', mode: 'evidence_only' }] },
    ...(withDeliverable ? { deliverable: { path: REVIEW_PATH, namespace: 'reviews', name: 'review-a' } } : {}),
  };
  return {
    // `case` is how the reviewer asks for rework: the graph names which branch means "go back".
    loops: [{ from: 'review-a', to: 'impl-a', case: 'fail' }] as LoopSpec[],
    acceptance: [{ id: 'a-pass', description: 'Lane a passed its own review', checkNode: 'review-a' }],
    nodes: [
      { id: 'impl-a', kind: 'agent', action: 'impl-a', ...coder },
      review,
      {
        // A downstream edge that asks for the result handoff is what makes the harness require one
        // from the router itself; without this the router's own submission is never inspected.
        // Only an Agent node may carry a context mode, so the downstream is an Agent here.
        id: 'after-a', kind: 'agent', action: 'after-a', ...coder, dependsOn: ['review-a'],
        when: { node: 'review-a', case: 'pass' },
        context: { predecessors: [{ source: 'review-a', mode: withDownstreamHandoff ? 'result_handoff' as const : 'evidence_only' as const }] },
      },
    ],
    actions: {
      'impl-a': { kind: 'agent', reserveTokens: 100, prepare: async () => async () => {
        round += 1;
        return { outcome: 'completed' as const, output: { round }, usage };
      } },
      'review-a': { kind: 'agent', reserveTokens: 100, prepare: async operation => async () => {
        const step = steps[Math.min(round - 1, steps.length - 1)]!;
        if (withDeliverable && operation.workspace) {
          await mkdir(join(operation.workspace, 'reviews'), { recursive: true });
          await writeFile(join(operation.workspace, REVIEW_PATH), `# review-a\n${step.note}\n`);
        }
        return {
          outcome: 'completed' as const, output: { note: step.note }, route: step.route, usage,
          ...(withDownstreamHandoff ? { resultHandoff: {
            schemaVersion: 1 as const, objective: 'review the lane', outcome: 'completed' as const,
            workSummary: `REVIEW_SUMMARY:${step.note}`, changes: [], decisions: [], verification: [],
            knownLimits: [], openQuestions: [], nextActions: [],
          } } : {}),
        };
      } },
      'after-a': { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed' as const, output: { downstream: true }, usage }) },
      check: { kind: 'program' as const, prepare: async () => async () => ({ outcome: 'completed' as const, output: { checked: true } }) },
    },
  } as { actions: Record<string, ActionAdapter>; nodes: NodeSpec[]; acceptance: Proposal['acceptance']; loops: LoopSpec[] };
}

async function setup(create: () => ReturnType<typeof lane>) {
  const root = await mkdtemp(join(tmpdir(), 'graph-review-router-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const fixture = create();
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: fixture.actions });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Review is the router', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({ requirementVersion: 1, summary: 'Review is the router',
    acceptance: fixture.acceptance, nodes: fixture.nodes, loops: fixture.loops }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  return { root, runtime, task: runtime.user.task(taskId), taskId, stateDir: join(root, 'state') };
}

test("a reviewer's own 'fail' sends the implementer back, with no gate node anywhere", async () => {
  const { runtime, task, taskId } = await setup(() => lane([{ route: 'fail', note: 'the legend is not persistent' }, { route: 'pass', note: 'fine now' }]));
  for (let i = 0; i < 8; i++) await runtime.host.runReady();
  const view = await task.view();
  // No program gate exists at all; the loop fires from the reviewer's own route.
  expect(view.operations.some(operation => operation.nodeId === 'gate')).toBe(false);
  expect(view.operations.filter(operation => operation.nodeId === 'impl-a' && operation.state === 'succeeded').length).toBe(2);
  expect(view.operations.some(operation => operation.nodeId === 'review-a' && operation.state === 'succeeded')).toBe(true);
  // The review the reviewer wrote is a shared task artifact, not a private file.
  expect(runtime.artifacts.list(taskId).artifacts.some(artifact => artifact.name === 'review-a')).toBe(true);
});

test("a reviewer's 'pass' releases the downstream branch instead of looping", async () => {
  const { runtime, task } = await setup(() => lane([{ route: 'pass', note: 'looks right' }]));
  for (let i = 0; i < 8; i++) await runtime.host.runReady();
  const view = await task.view();
  expect(view.operations.filter(operation => operation.nodeId === 'impl-a' && operation.state === 'succeeded').length).toBe(1);
  expect(view.operations.find(operation => operation.nodeId === 'after-a')?.state).toBe('succeeded');
  expect(view.phase).toBe('completed');
});

test("a reviewer's own 'pass' reads as an independent review", async () => {
  // The completion guard asks whether an independent review happened before a delivery may finish. With
  // a routed reviewer there is no gate to read, so the answer is the reviewer's own route: the graph
  // names the branch that means "go back", and a route that is not that branch released the work.
  const { runtime, task, taskId, stateDir } = await setup(() => lane([{ route: 'pass', note: 'looks right' }]));
  for (let i = 0; i < 8; i++) await runtime.host.runReady();
  const view = await task.view();
  expect(view.nodes.every(node => ['succeeded', 'skipped'].includes(node.status))).toBe(true);

  const store = new TaskStore(join(stateDir, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  expect(loadGraph(store, taskId).route('review-a')).toBe('pass');
  expect(independentReviewReady(store, taskId)).toBe(true);
  expect(view.phase).toBe('completed');
});

test('an acceptance item bound to an agent router is proven by the review it wrote', async () => {
  const { runtime, task } = await setup(() => lane([{ route: 'pass', note: 'looks right' }]));
  for (let i = 0; i < 8; i++) await runtime.host.runReady();
  const view = await task.view();
  expect(view.evidence).toMatchObject([{ acceptanceId: 'a-pass', nodeId: 'review-a', summary: 'looks right' }]);
  // The evidence pins the review the reviewer actually wrote, wherever its work copy lived.
  expect(view.evidence[0]!.artifact.path.endsWith(REVIEW_PATH)).toBe(true);
  expect(view.evidence[0]!.artifact.digest).toMatch(/^[a-f0-9]{64}$/);
});

test('a routed rework hands the reviewer\'s own words to the implementer', async () => {
  const { runtime, task, stateDir } = await setup(() => lane([{ route: 'fail', note: 'THE-LEGEND-IS-NOT-PERSISTENT' }, { route: 'pass', note: 'fine now' }]));
  // Run until the reviewer has sent the work back, so the implementer is pending its second round.
  for (let i = 0; i < 8; i++) {
    await runtime.host.runReady();
    const rounds = (await task.view()).operations.filter(operation => operation.nodeId === 'impl-a' && operation.state === 'succeeded');
    if (rounds.length === 1) break;
  }
  const instanceId = (await task.view()).nodes.find(node => node.id === 'impl-a')?.instanceId;
  expect(instanceId).toBeTruthy();
  // A node that already ran holds a session, which is exactly when the harness sends only what is new.
  const store = new TaskStore(join(stateDir, 'tasks.sqlite'));
  store.db.prepare('INSERT OR REPLACE INTO node_sessions(instance_id,session_id,session_file,updated_at) VALUES(?,?,?,?)')
    .run(instanceId!, 'session-impl-a', join(stateDir, 'session-impl-a.jsonl'), 0);
  store.close();
  for (let i = 0; i < 8; i++) await runtime.host.runReady();
  const view = await task.view();
  const rounds = view.operations.filter(operation => operation.nodeId === 'impl-a');
  expect(rounds.length).toBeGreaterThanOrEqual(2);
  // The first round had nothing to answer; the second was handed what the reviewer said.
  expect(rounds[0]!.context?.briefing ?? '').not.toContain('THE-LEGEND-IS-NOT-PERSISTENT');
  expect(rounds[1]!.context?.briefing ?? '').toContain('THE-LEGEND-IS-NOT-PERSISTENT');
});

test('a routed loop does not count as acceptance evidence', async () => {
  const { runtime, task } = await setup(() => lane([{ route: 'fail', note: 'not done' }]));
  for (let i = 0; i < 8; i++) await runtime.host.runReady();
  const view = await task.view();
  // The reviewer keeps sending the work back and the task never completes, so nothing is accepted.
  expect(view.evidence.length).toBe(0);
  expect(view.phase).not.toBe('completed');
});

test('the handoff of an Agent router bound to acceptance is readable by its downstream', async () => {
  // Failure mode pinned here: the harness records the acceptance evidence for a router by REPLACING
  // the result AFTER the handoff was settled. The handoff stores a digest of the result it was
  // settled over, and the durable record then holds a different one, so every downstream read is
  // refused with `context_rejected` — a router that is itself an acceptance check can never feed
  // anything downstream. The two writes must happen in the order that keeps the digest true.
  const { runtime, task } = await setup(() => lane([{ route: 'pass', note: 'looks right' }], { downstreamHandoff: true }));
  for (let i = 0; i < 8; i++) await runtime.host.runReady();
  const view = await task.view();
  expect(view.operations.find(operation => operation.nodeId === 'review-a')?.state).toBe('succeeded');
  expect(view.evidence).toMatchObject([{ acceptanceId: 'a-pass', nodeId: 'review-a' }]);
  // The downstream edge runs: it could only do that if it read a handoff with a matching digest.
  expect(view.operations.find(operation => operation.nodeId === 'after-a')?.state).toBe('succeeded');
});
