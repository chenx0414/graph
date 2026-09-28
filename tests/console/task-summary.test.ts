// Failure modes this summary must survive, written before the implementation:
// 1. No invocations recorded  -> usage unknown, never a confident 0.
// 2. Task still running       -> no end, no duration, outcome in_progress.
// 3. Task abandoned           -> an ending, but never reported as a delivery.
// 4. Unknown task id          -> throws; it must not answer with an empty card.
// 5. Missing timestamps       -> start without end, or neither; durations omitted.
// 6. Costs in two currencies  -> no single total; unknown is not silently dropped.
// 7. No evidence rows         -> delivery still reported from the task row.
// 8. Two nodes, one failed    -> the breakdown keeps every node and its own status.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { taskSummary } from '../../src/core/task-summary.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

/**
 * One conversation holding three tasks: one delivered, one still running, one stopped by
 * hand. Every number the card shows comes out of these rows, so this fixture is the spec.
 */
function fixture() {
  return mkdtemp(join(tmpdir(), 'graph-task-summary-')).then(async root => {
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = new TaskStore(join(root, 'tasks.sqlite'));
    cleanup.push(async () => store.close());
    store.transaction(() => {
      store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
      store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('anchor','p','chat',1,'chatting','c')").run();
      store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('c','p','anchor','chat',1,1)").run();
      store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('anchor','master','{\"role\":\"master\"}','a','succeeded')").run();
      // A delivered graph task: two nodes, one of which failed and was retried.
      store.db.prepare("INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,accepted_proposal,target_branch,phase,created_seq,graph_version,integration_sha,conversation_id) VALUES('done','p','ship the thing',11,1,1,'main','completed',2,1,'sha-delivered','c')").run();
      store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('done','build','{\"kind\":\"agent\"}','a1','succeeded')").run();
      store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('done','check','{\"kind\":\"program\"}','a2','succeeded')").run();
      // A task that is still running, so the summary has to say so rather than invent an end.
      store.db.prepare("INSERT INTO tasks(id,project_id,request,latest_proposal,phase,created_seq,graph_version,conversation_id) VALUES('live','p','still going',1,'running',3,1,'c')").run();
      store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('live','work','{\"kind\":\"agent\"}','a3','running')").run();
      // A task the user stopped: an ending too, and it must not be reported as a success.
      store.db.prepare("INSERT INTO tasks(id,project_id,request,latest_proposal,phase,created_seq,graph_version,conversation_id) VALUES('stopped','p','stopped by hand',1,'abandoned',4,1,'c')").run();
    });
    return store;
  });
}

/** The events that give the summary its clock: a start and an end, at known times. */
function timeline(store: TaskStore, taskId: string, startedAt: number, endedAt?: number) {
  store.transaction(() => {
    store.event(taskId, 'task.started', {});
    store.db.prepare('UPDATE events SET timestamp=? WHERE task_id=? AND type=?').run(startedAt, taskId, 'task.started');
    if (endedAt !== undefined) {
      store.event(taskId, 'task.completed', { proposalVersion: 1 });
      store.db.prepare('UPDATE events SET timestamp=? WHERE task_id=? AND type=?').run(endedAt, taskId, 'task.completed');
    }
  });
}

/** An invocation is only visible through its operation, which is how the real account reads them. */
function invocation(store: TaskStore, taskId: string, nodeId: string, id: string, usage: object | null, cost: object | null) {
  store.transaction(() => {
    store.db.prepare("INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active,waiting_slot) VALUES(?,?,?,1,'{}','settled',0,0,0)").run(`op-${id}`, taskId, nodeId).toString();
    store.db.prepare('INSERT INTO invocations(id,operation_id,instance_id,model,usage,cost,purpose) VALUES(?,?,?,?,?,?,?)')
      .run(id, `op-${id}`, 'i1', 'test-model', usage ? JSON.stringify(usage) : null, cost ? JSON.stringify(cost) : null, 'completion');
  });
}

test('a finished task reports wall-clock run time from facts that already exist, with no new column', async () => {
  const store = await fixture();
  timeline(store, 'done', 1_000, 91_000);
  const summary = taskSummary(store, 'done');
  expect(summary.status).toBe('completed');
  expect(summary.startedAt).toBe(1_000);
  expect(summary.endedAt).toBe(91_000);
  // 90 seconds written as a number the card renders without doing arithmetic itself.
  expect(summary.durationMs).toBe(90_000);
  expect(summary.outcome).toBe('delivered');
  expect(summary.delivery).toMatchObject({ integrationSha: 'sha-delivered', targetBranch: 'main' });
});

test('an ending that is not a delivery is never dressed up as one', async () => {
  const store = await fixture();
  timeline(store, 'stopped', 5_000, 8_000);
  const stopped = taskSummary(store, 'stopped');
  expect(stopped.status).toBe('abandoned');
  expect(stopped.outcome).toBe('abandoned');
  expect(stopped.durationMs).toBe(3_000);
  expect(stopped.delivery).toBeNull();
});

test('a task still running has no end, and says so instead of guessing one', async () => {
  const store = await fixture();
  timeline(store, 'live', 2_000);
  const live = taskSummary(store, 'live');
  expect(live.status).toBe('running');
  expect(live.endedAt).toBeUndefined();
  expect(live.durationMs).toBeUndefined();
  expect(live.outcome).toBe('in_progress');
});

test('tokens and cost come from recorded invocations and stay unknown when there are none', async () => {
  const store = await fixture();
  timeline(store, 'done', 1_000, 91_000);
  // No invocations recorded yet: the honest answer is "unknown", not zero. A card printing
  // 0 tokens for a task that clearly ran is worse than one printing nothing.
  expect(taskSummary(store, 'done').usage).toBeNull();

  invocation(store, 'done', 'build', 'inv1',
    { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 },
    { amount: 0.15, currency: 'USD' });
  const used = taskSummary(store, 'done');
  expect(used.usage).toMatchObject({ tokens: 125 });
  expect(used.usage!.cost).toMatchObject({ amount: 0.15, currency: 'USD' });
});

test('an invocation with no recorded usage makes the total unknown rather than short', async () => {
  const store = await fixture();
  timeline(store, 'done', 1_000, 91_000);
  invocation(store, 'done', 'build', 'inv1', { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }, { amount: 1, currency: 'USD' });
  invocation(store, 'done', 'check', 'inv2', null, null);
  const used = taskSummary(store, 'done');
  // The card must be able to say "at least this much, and one call is unaccounted for".
  expect(used.usage!.unknownUsage).toBe(true);
  expect(used.usage!.tokens).toBe(120);
});

test('two currencies are never added into one meaningless number', async () => {
  const store = await fixture();
  timeline(store, 'done', 1_000, 91_000);
  invocation(store, 'done', 'build', 'inv1', { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, { amount: 1, currency: 'USD' });
  invocation(store, 'done', 'check', 'inv2', { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, { amount: 2, currency: 'EUR' });
  const used = taskSummary(store, 'done');
  expect(used.usage!.cost.amount).toBeNull();
  expect(used.usage!.cost.amounts).toMatchObject({ USD: 1, EUR: 2 });
});

test('the node breakdown keeps every node and its own status, in a stable order', async () => {
  const store = await fixture();
  timeline(store, 'done', 1_000, 91_000);
  store.db.prepare("UPDATE nodes SET status='failed' WHERE task_id='done' AND id='check'").run();
  const summary = taskSummary(store, 'done');
  expect(summary.nodes.map(node => node.id)).toEqual(['build', 'check']);
  expect(summary.nodes.map(node => node.status)).toEqual(['succeeded', 'failed']);
});

test('the delivery carries the acceptance evidence that actually passed', async () => {
  const store = await fixture();
  timeline(store, 'done', 1_000, 91_000);
  store.db.prepare("INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active,waiting_slot) VALUES('op-1','done','check',1,'{}','settled',0,0,0)").run();
  store.db.prepare("INSERT INTO evidence(id,task_id,node_id,operation_id,acceptance_id,proposal_version,requirement_version,data,activation_id,valid,commit_sha) VALUES('e1','done','check','op-1','acc-1',1,11,'{}','a2',1,'sha-delivered')").run();
  store.db.prepare("INSERT INTO evidence(id,task_id,node_id,operation_id,acceptance_id,proposal_version,requirement_version,data,activation_id,valid,commit_sha) VALUES('e2','done','check','op-1','acc-2',1,11,'{}','a2',0,NULL)").run();
  const summary = taskSummary(store, 'done');
  expect(summary.delivery!.acceptance).toEqual([{ id: 'acc-1', valid: true }]);
});

test('a task that does not exist is refused, not summarised as empty', async () => {
  const store = await fixture();
  expect(() => taskSummary(store, 'nope')).toThrow();
});
