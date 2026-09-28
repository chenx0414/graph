import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { insertQuestion } from '../../src/core/question-routing.ts';
import {
  consumeWakes, pendingWakes, wakeMaster, wakeForBlockedNode, wakeForTaskCompleted, wakeForAnswer,
} from '../../src/core/wake-ledger.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

/** A chatting conversation whose anchor task holds the master, plus one graph task in it. */
function fixture() {
  return mkdtemp(join(tmpdir(), 'graph-wake-ledger-')).then(async root => {
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = new TaskStore(join(root, 'tasks.sqlite'));
    cleanup.push(async () => store.close());
    store.transaction(() => {
      store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
      store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('anchor','p','chat',1,'chatting','c')").run();
      store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('c','p','anchor','chat',1,1)").run();
      store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('anchor','master','{\"role\":\"master\"}','a','succeeded')").run();
      store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('work','p','work',2,'running','c')").run();
      store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('work','build','{}','w','blocked')").run();
      // consumed_operation_id is a real foreign key, so a test that consumes a wake
      // has to point at an operation that exists - the same thing production does.
      store.db.prepare(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active,activation_id,dispatched_at)
        VALUES('op-1','anchor','master',1,'{"role":"master"}','succeeded',0,0,'a',1)`).run();
    });
    return store;
  });
}

const masterStatus = (store: TaskStore) =>
  store.db.prepare("SELECT status FROM nodes WHERE task_id='anchor' AND id='master'").get() as { status: string };

test('a wake is idempotent: delivering the same fact N times wakes the master once', async () => {
  const store = await fixture();
  store.transaction(() => {
    for (let round = 0; round < 3; round += 1) {
      wakeForTaskCompleted(store, 'work', { commitSha: 'abc123', phase: 'completed' });
    }
  });
  expect(masterStatus(store)).toEqual({ status: 'pending' });
  // The second and third delivery added nothing: same fact, same row.
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM wake_intents').get()).toEqual({ count: 1 });
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='wake.ready'").get()).toEqual({ count: 1 });
});

test('two different facts of the same kind are two wakes, because they are two things to act on', async () => {
  const store = await fixture();
  store.transaction(() => {
    wakeMaster(store, { taskId: 'work', kind: 'node_blocked', dedupeKey: 'build:waiting', data: { nodeId: 'build' } });
    wakeMaster(store, { taskId: 'work', kind: 'node_blocked', dedupeKey: 'build:execution_failed', data: { nodeId: 'build' } });
  });
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM wake_intents').get()).toEqual({ count: 2 });
});

test('a consumed wake is not delivered again when the fact is observed once more', async () => {
  const store = await fixture();
  store.transaction(() => wakeForTaskCompleted(store, 'work', { phase: 'completed' }));
  const [pending] = pendingWakes(store, 'anchor', 'master');
  expect(pending?.kind).toBe('task_completed');
  store.transaction(() => consumeWakes(store, 'anchor', 'master', 'op-1'));

  // Observing the completed task again must not queue a second turn: the fact
  // was already acted on, and a master woken twice would re-plan done work.
  store.transaction(() => wakeForTaskCompleted(store, 'work', { phase: 'completed' }));
  expect(pendingWakes(store, 'anchor', 'master')).toEqual([]);
  expect(store.db.prepare("SELECT state FROM wake_intents WHERE kind='task_completed'").get())
    .toEqual({ state: 'consumed' });
});

test('a wake for a task that is not this conversation is never delivered', async () => {
  const store = await fixture();
  store.db.prepare("UPDATE tasks SET conversation_id=NULL WHERE id='work'").run();
  store.transaction(() => wakeForTaskCompleted(store, 'work', { phase: 'completed' }));
  expect(pendingWakes(store, 'anchor', 'master')).toEqual([]);
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM wake_intents').get()).toEqual({ count: 0 });
});

test('a wake is delivered once and remembers which turn consumed it', async () => {
  const store = await fixture();
  store.transaction(() => wakeForBlockedNode(store, 'work', { nodeId: 'build', reason: 'execution_failed' }));
  store.transaction(() => consumeWakes(store, 'anchor', 'master', 'op-1'));
  expect(store.db.prepare('SELECT state,consumed_operation_id FROM wake_intents').get())
    .toEqual({ state: 'consumed', consumed_operation_id: 'op-1' });
  expect(pendingWakes(store, 'anchor', 'master')).toEqual([]);
});

test('a wake follows the task into its own conversation, not the one that asked', async () => {
  const store = await fixture();
  store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('c2','p','anchor','other',2,2)").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('other','p','x',3,'running','c2')").run();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('other','master','{\"role\":\"master\"}','o','succeeded')").run();
  store.transaction(() => wakeForTaskCompleted(store, 'other', { phase: 'completed' }));
  // The fact happened in 'other', but the intent is recorded against the task that
  // owns the master it is for - one row, and the master it wakes is c2's.
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM wake_intents WHERE task_id='anchor'").get()).toEqual({ count: 1 });
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM wake_intents WHERE task_id='other'").get()).toEqual({ count: 0 });
  expect(pendingWakes(store, 'anchor', 'master')).toHaveLength(1);
});

test('a wake carries the reason with it instead of just the fact that something stopped', async () => {
  const store = await fixture();
  store.transaction(() => wakeForBlockedNode(store, 'work', { nodeId: 'build', reason: 'permission' }));
  const [pending] = pendingWakes(store, 'anchor', 'master');
  expect(pending).toMatchObject({ kind: 'node_blocked' });
  expect(JSON.parse(pending!.data ?? 'null')).toMatchObject({ nodeId: 'build', reason: 'permission' });
});

test('an answer wakes the master that is waiting to act on it', async () => {
  const store = await fixture();
  store.transaction(() => wakeForAnswer(store, 'work', { questionId: 'q1', kind: 'human_check', answer: { type: 'acknowledge' } }));
  const [pending] = pendingWakes(store, 'anchor', 'master');
  expect(pending?.kind).toBe('answer');
  expect(masterStatus(store)).toEqual({ status: 'pending' });
});

// --- The cases a real wake exposed after the first version shipped ---

/**
 * A problem on the master's own node must never wake that same master: it would start a
 * turn whose only content is the question it just asked. Ownership decides who answers;
 * a user-owned question still tells the master the graph is stuck, because the master is
 * the actor holding the context to say what happens next.
 */
test('a question the master raised itself never wakes that same master', async () => {
  const store = await fixture();
  insertQuestion(store, {
    taskId: 'anchor',
    nodeId: 'master',
    kind: 'waiting',
    data: { prompt: 'which shape do you want?', requestType: 'user_decision' },
  });
  expect(pendingWakes(store, 'anchor', 'master')).toEqual([]);
});

test('a human check wakes the master so it can review before the user is asked', async () => {
  const store = await fixture();
  insertQuestion(store, {
    taskId: 'work',
    nodeId: 'build',
    kind: 'human_check',
    data: { prompt: 'A human acceptance check is required', activationId: 'w', commitSha: null },
  });
  // It is a *different* wake from a block: the master is not unblocking anything, it is
  // looking at the evidence so a check that should never have been raised can be sent
  // back before the person is interrupted.
  expect(pendingWakes(store, 'anchor', 'master').map(wake => wake.kind)).toEqual(['human_check']);
});

test('a question the master owns wakes it; the same question once answered does too', async () => {
  const store = await fixture();
  const problem = insertQuestion(store, {
    taskId: 'work', nodeId: 'build', kind: 'recovery', data: { reason: 'boom' },
  });
  expect(problem.owner).toBe('main');
  expect(pendingWakes(store, 'anchor', 'master').map(wake => wake.kind)).toEqual(['node_blocked']);

  // Answering it is a fact the master has to act on, and it is a *different* fact from
  // the block, so it is a second wake rather than a repeat of the first.
  store.transaction(() => consumeWakes(store, 'anchor', 'master', 'op-1'));
  store.transaction(() => wakeForAnswer(store, 'work', { questionId: problem.id, nodeId: 'build', kind: 'recovery' }));
  expect(pendingWakes(store, 'anchor', 'master').map(wake => wake.kind)).toEqual(['answer']);
});

test('a node blocked on the user still tells the master, because the graph is stuck', async () => {
  const store = await fixture();
  // Ownership decides who answers, not whether the master hears: the user answers the
  // permission, and the master is told the graph cannot move. Those are two different
  // facts, and the statement "the user has it in their inbox" is only true if the
  // master was actually told which node and why.
  const permission = insertQuestion(store, {
    taskId: 'work', nodeId: 'build', kind: 'permission', data: { grant: 'mcp:demo:write' },
  });
  expect(permission.owner).toBe('user');
  expect(pendingWakes(store, 'anchor', 'master').map(wake => wake.kind)).toEqual(['node_blocked']);
});
