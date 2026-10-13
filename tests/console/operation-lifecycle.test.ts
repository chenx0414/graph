import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  OperationLifecycle,
  operationSnapshots,
  type OperationIntent,
} from '../../src/core/operation-lifecycle.ts';
import { TaskStore, canonicalJson } from '../../src/core/store.ts';
import { problemActions } from '../../src/core/question-routing.ts';
import { fullAccessPolicy, resolveAccessPolicy } from '../../src/core/access-policy.ts';
import { appendMessage, deliverMessages, pendingMessages } from '../../src/core/conversation.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-operation-lifecycle-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t','p','lifecycle',1,'running')").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,instance_id,status,activation_id) VALUES('t','work',?,'i','pending','a')")
      .run(canonicalJson({ id: 'work', kind: 'agent', action: 'work' }));
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,definition_version,model) VALUES('i','t','work','coder@1','m')").run();
    store.db.prepare("INSERT INTO activations(id,task_id,node_id,graph_version,round,state,input_versions) VALUES('a','t','work',1,1,'pending','{}')").run();
  });
  const lifecycle = new OperationLifecycle(store);
  lifecycle.recover();
  return { store, lifecycle };
}

function intent(attempt: number): OperationIntent {
  return {
    taskId: 't',
    nodeId: 'work',
    instanceId: 'i',
    kind: 'agent',
    action: 'work',
    input: { attempt },
    dependencies: {},
    proposalVersion: 0,
    requirementVersion: 1,
    context: { previousOutput: null, answers: [] },
    grants: [],
    activationId: 'a',
    graphVersion: 1,
    dependencySources: {},
    inputVersions: {},
  };
}

test('intent recovery is conservative and attempt identity stays behind the lifecycle seam', async () => {
  const { store, lifecycle } = await fixture();
  const operation = lifecycle.admit({
    node: { id: 'work', taskId: 't', activationId: 'a' },
    reservation: 100,
    prepare: intent,
  });
  expect(operation.attempt).toBe(1);
  expect(operationSnapshots(store, 't')).toMatchObject([{ state: 'intent', reserved: 100 }]);

  const recovered = new OperationLifecycle(store);
  recovered.recover();
  expect(operationSnapshots(store, 't')).toMatchObject([{ state: 'not_sent', reserved: 0 }]);
  expect(store.db.prepare("SELECT status FROM nodes WHERE task_id='t' AND id='work'").get()).toEqual({ status: 'pending' });
});

test.each([false, true])('full access restart preserves an uncertain chatting master for reconciliation (queued=%s)', async queued => {
  const { store, lifecycle } = await fixture();
  store.db.prepare("UPDATE tasks SET phase='chatting',conversation_id='c' WHERE id='t'").run();
  store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('c','p','t','chat',1,1)").run();
  store.db.prepare("UPDATE nodes SET spec=? WHERE task_id='t' AND id='work'")
    .run(canonicalJson({ id: 'work', kind: 'agent', action: 'work', role: 'master' }));
  appendMessage(store, { conversationId: 'c', role: 'user', kind: 'chat', text: 'first', state: 'pending' });
  const operation = lifecycle.admit({
    node: { id: 'work', taskId: 't', activationId: 'a' },
    reservation: 100,
    prepare: attempt => ({ ...intent(attempt), accessPolicy: resolveAccessPolicy(fullAccessPolicy()) }),
  });
  deliverMessages(store, operation.id, operation.attempt, pendingMessages(store, 'c'));
  lifecycle.dispatch(operation);
  if (queued) appendMessage(store, { conversationId: 'c', role: 'user', kind: 'chat', text: 'next', state: 'queued' });

  new OperationLifecycle(store).recover();
  expect(operationSnapshots(store, 't')).toMatchObject([{ state: 'unknown', reserved: 100, workerActive: false }]);
  expect(store.db.prepare("SELECT status FROM nodes WHERE task_id='t' AND id='work'").get())
    .toEqual({ status: 'pending' });
  expect(pendingMessages(store, 'c').map(message => message.text)).toEqual(queued ? ['next'] : []);
  expect(store.db.prepare("SELECT kind,owner FROM questions WHERE status='open'").all()).toEqual([{ kind: 'recovery', owner: 'main' }]);
});

test('system-change questions accept only an explicit user decision', async () => {
  const { store, lifecycle } = await fixture();
  store.db.prepare("INSERT INTO questions(id,task_id,node_id,kind,data,owner,status) VALUES('s','t','work','system_change',?, 'user','open')")
    .run(canonicalJson({ proposalId: 'p1', title: '安装 MCP', problem: '缺少能力' }));
  store.transaction(() => lifecycle.answer('t', 's', {
    type: 'respond',
    value: { decision: 'approved' },
  }));
  expect(store.db.prepare("SELECT status,answer FROM questions WHERE id='s'").get()).toMatchObject({
    status: 'resolved',
    answer: expect.stringContaining('approved'),
  });

  store.db.prepare("INSERT INTO questions(id,task_id,node_id,kind,data,owner,status) VALUES('bad','t','work','system_change','{}','user','open')").run();
  expect(() => lifecycle.answer('t', 'bad', { type: 'respond', value: { decision: 'maybe' } }))
    .toThrow(/approved or rejected/);
});

test.each([
  'adapter_error', 'execution_failed', 'model_unavailable', 'git_conflict',
  'context_rejected', 'recovery', 'result_noncompliant',
])('the offered retry for %s is accepted and reactivates its blocked node', async kind => {
  const { store, lifecycle } = await fixture();
  store.db.prepare("UPDATE nodes SET status='blocked' WHERE task_id='t' AND id='work'").run();
  store.db.prepare("INSERT INTO questions(id,task_id,node_id,kind,data,owner,status) VALUES('r','t','work',?,?,'main','open')")
    .run(kind, canonicalJson({ reason: 'Worker requires recovery' }));
  expect(problemActions(kind)).toContain('retry');

  store.transaction(() => lifecycle.answer('t', 'r', { type: 'retry' }));

  expect(store.db.prepare("SELECT status,answer FROM questions WHERE id='r'").get()).toMatchObject({
    status: 'resolved',
    answer: '{"type":"retry"}',
  });
  expect(store.db.prepare("SELECT status FROM nodes WHERE task_id='t' AND id='work'").get()).toEqual({ status: 'pending' });
});

test('a stuck problem can be escalated to the user instead of looping', () => {
  // Three blocked rounds or a returned lane may need a decision only the user can make; without
  // escalate the main Agent has no path to ask and is stuck with a retry that changes nothing.
  expect(problemActions('stalled')).toEqual(expect.arrayContaining(['retry', 'respond', 'escalate']));
  expect(problemActions('rework')).toEqual(expect.arrayContaining(['retry', 'respond', 'escalate']));
});

test('unrecognized problem kinds do not advertise a retry that settlement rejects', async () => {
  const { store, lifecycle } = await fixture();
  store.db.prepare("UPDATE nodes SET status='blocked' WHERE task_id='t' AND id='work'").run();
  store.db.prepare("INSERT INTO questions(id,task_id,node_id,kind,data,owner,status) VALUES('future','t','work','future_problem','{}','main','open')").run();
  expect(problemActions('future_problem')).toEqual([]);
  expect(() => lifecycle.answer('t', 'future', { type: 'retry' })).toThrow('Answer type does not match');
  expect(store.db.prepare("SELECT status FROM questions WHERE id='future'").get()).toEqual({ status: 'open' });
  expect(store.db.prepare("SELECT status FROM nodes WHERE task_id='t' AND id='work'").get()).toEqual({ status: 'blocked' });
});

test('dispatch, unknown usage, and a human answer compose in one lifecycle transaction', async () => {
  const { store, lifecycle } = await fixture();
  const operation = lifecycle.admit({
    node: { id: 'work', taskId: 't', activationId: 'a' },
    reservation: 100,
    prepare: intent,
  });
  lifecycle.dispatch(operation);
  lifecycle.report(operation.id, operation.generation, { outcome: 'continue', output: { draft: true } });

  expect(operationSnapshots(store, 't')).toMatchObject([{ state: 'unknown' }]);
  const question = store.db.prepare("SELECT id FROM questions WHERE operation_id=? AND kind='unknown_usage' AND status='open'")
    .get(operation.id) as { id: string };

  store.transaction(() => lifecycle.answer('t', question.id, {
    type: 'usage',
    usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 },
    proof: 'Provider receipt',
  }));
  expect(operationSnapshots(store, 't')).toMatchObject([{ state: 'succeeded', reserved: 0, workerActive: false }]);
  expect(store.db.prepare("SELECT used,models_used FROM instances WHERE id='i'").get()).toMatchObject({
    used: 50,
    models_used: '["m"]',
  });
});


test('the external main can return structured review content without triggering an implicit graph rework loop', async () => {
  const { store, lifecycle } = await fixture();
  store.db.prepare("UPDATE nodes SET spec=?,stall_count=2 WHERE task_id='t' AND id='work'")
    .run(canonicalJson({ id: 'work', kind: 'agent', action: 'master', role: 'master' }));
  const operation = lifecycle.admit({
    node: { id: 'work', taskId: 't', activationId: 'a' }, reservation: 100,
    prepare: attempt => ({ ...intent(attempt), action: 'master' }),
  });
  lifecycle.dispatch(operation);
  const output = { kind: 'verification', outcome: 'rework', subjects: [], reports: [],
    blockers: [{ id: 'review', reason: 'Price is incorrectly stored as zero', evidence: [] }] };
  lifecycle.report(operation.id, operation.generation, {
    outcome: 'completed', output,
    usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 },
  });
  expect(lifecycle.get(operation.id)).toMatchObject({ state: 'succeeded', result: { output } });
  expect(store.db.prepare("SELECT status,stall_count FROM nodes WHERE id='work'").get())
    .toEqual({ status: 'succeeded', stall_count: 2 });
  expect(store.db.prepare("SELECT kind FROM questions WHERE status='open'").all()).toEqual([]);
});


test.each(['intent', 'dispatched', 'not_sent'])('restart restores delivered messages before adapter send (%s), once', async stage => {
  const { store, lifecycle } = await fixture();
  store.db.prepare("UPDATE tasks SET phase='chatting',conversation_id='c' WHERE id='t'").run();
  store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('c','p','t','chat',1,1)").run();
  store.db.prepare("UPDATE nodes SET spec=? WHERE id='work'").run(canonicalJson({ id: 'work', kind: 'agent', action: 'work', role: 'master' }));
  appendMessage(store, { conversationId: 'c', role: 'user', kind: 'chat', text: 'show status', state: 'pending' });
  const operation = lifecycle.admit({
    node: { id: 'work', taskId: 't', activationId: 'a' }, reservation: 100,
    prepare: attempt => ({ ...intent(attempt), accessPolicy: resolveAccessPolicy(fullAccessPolicy()) }),
    afterIntent: op => deliverMessages(store, op.id, op.attempt, pendingMessages(store, 'c')),
  });
  if (stage !== 'intent') lifecycle.dispatch(operation);
  if (stage === 'not_sent') {
    // Import the state written by the retired full-access restart implementation.
    // Current recovery must never recreate that unsafe transition itself.
    store.db.prepare("UPDATE operations SET state='not_sent',worker_active=0,reserved=0 WHERE id=?").run(operation.id);
    store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id='t' AND id='work'").run();
    store.event('t', 'operation.recovery_bypassed', { operationId: operation.id, policy: 'full_access' });
  }
  appendMessage(store, { conversationId: 'c', role: 'user', kind: 'chat', text: 'and recent work', state: 'queued' });
  const restored = new OperationLifecycle(store, { canReplayBeforeSend: () => true });
  restored.recover();
  expect(pendingMessages(store, 'c').map(message => message.text)).toEqual(['show status', 'and recent work']);
  expect(store.db.prepare("SELECT status FROM nodes WHERE id='work'").get()).toEqual({ status: 'pending' });
  expect(lifecycle.get(operation.id)).toMatchObject({ state: 'not_sent', reserved: 0 });
  restored.recover();
  expect(pendingMessages(store, 'c')).toHaveLength(2);
});

test('legacy unsent messages stay parked if a later turn may already have acted on that context', async () => {
  const { store, lifecycle } = await fixture();
  store.db.prepare("UPDATE tasks SET phase='chatting',conversation_id='c' WHERE id='t'").run();
  store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('c','p','t','chat',1,1)").run();
  store.db.prepare("UPDATE nodes SET spec=? WHERE id='work'").run(canonicalJson({ id: 'work', kind: 'agent', action: 'work', role: 'master' }));
  const operations: { id: string }[] = [];
  for (const text of ['original request', 'follow up']) {
    appendMessage(store, { conversationId: 'c', role: 'user', kind: 'chat', text, state: 'pending' });
    const op = lifecycle.admit({
      node: { id: 'work', taskId: 't', activationId: 'a' }, reservation: 0,
      prepare: attempt => ({ ...intent(attempt), accessPolicy: resolveAccessPolicy(fullAccessPolicy()) }),
      afterIntent: current => deliverMessages(store, current.id, current.attempt, pendingMessages(store, 'c')),
    });
    lifecycle.dispatch(op);
    new OperationLifecycle(store).recover();
    operations.push(op);
  }
  new OperationLifecycle(store, {
    canReplayBeforeSend: op => op.id === operations[0]!.id,
  }).recover();
  expect(pendingMessages(store, 'c')).toEqual([]);
});
