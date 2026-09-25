import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore, SCHEMA_VERSION } from '../../src/core/store.ts';
import { insertQuestion, isMasterParked, questionOwner, recoverMaster } from '../../src/core/question-routing.ts';
import { resetIdleNode } from '../../src/core/graph.ts';
import { OperationLifecycle } from '../../src/core/operation-lifecycle.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

function fixture() {
  return mkdtemp(join(tmpdir(), 'graph-question-routing-')).then(async root => {
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = new TaskStore(join(root, 'tasks.sqlite'));
    cleanup.push(async () => store.close());
    store.transaction(() => {
      store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
      store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('anchor','p','chat',1,'chatting','c')").run();
      store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('c','p','anchor','chat',1,1)").run();
      store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('anchor','master','{\"role\":\"master\"}','a','succeeded')").run();
      store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('work-task','p','work',2,'running','c')").run();
      store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('work-task','work','{}','w','blocked')").run();
    });
    return store;
  });
}

test('resetting a node supersedes the open questions of its retired activation', async () => {
  const store = await fixture();
  insertQuestion(store, {
    taskId: 'work-task', nodeId: 'work', kind: 'human_check',
    data: { prompt: 'A human acceptance check is required', activationId: 'w', commitSha: null },
  });
  const open = store.db.prepare("SELECT id FROM questions WHERE task_id='work-task' AND status='open'").get() as { id: string };
  resetIdleNode(store, 'work-task', 'work', 2, 1, ['pending']);
  const after = store.db.prepare('SELECT status,answer FROM questions WHERE id=?').get(open.id) as { status: string; answer: string };
  expect(after.status).toBe('resolved');
  expect(JSON.parse(after.answer)).toMatchObject({ type: 'superseded' });
});

test('only decisions the user alone owns are classified as direct user questions', () => {
  expect(questionOwner('permission', {})).toBe('user');
  expect(questionOwner('budget', {})).toBe('user');
  expect(questionOwner('human_check', {})).toBe('user');
  expect(questionOwner('system_change', {})).toBe('user');
  expect(questionOwner('waiting', { requestType: 'model_access' })).toBe('user');
  expect(questionOwner('waiting', { requestType: 'noncompliance_decision' })).toBe('user');
  expect(questionOwner('recovery', { reason: 'SyntaxError' })).toBe('main');
  expect(questionOwner('adapter_error', { reason: 'boom' })).toBe('main');
  expect(questionOwner('unknown_usage', { reason: 'missing' })).toBe('main');
  expect(questionOwner('result_noncompliant', { reason: 'result_handoff_invalid' })).toBe('main');
});

test('main-owned execution problems wake the master, while direct user questions keep the human wait', async () => {
  const store = await fixture();
  const problem = insertQuestion(store, {
    taskId: 'work-task',
    nodeId: 'work',
    operationId: null,
    kind: 'recovery',
    data: { reason: 'SyntaxError: Unterminated string in JSON' },
  });
  expect(problem.owner).toBe('main');
  expect(store.db.prepare("SELECT status FROM nodes WHERE task_id='anchor' AND id='master'").get())
    .toEqual({ status: 'pending' });
  expect(store.db.prepare("SELECT user_wait_since FROM nodes WHERE task_id='work-task' AND id='work'").get())
    .toEqual({ user_wait_since: null });

  const permission = insertQuestion(store, {
    taskId: 'work-task',
    nodeId: 'work',
    operationId: null,
    kind: 'permission',
    data: { grant: 'mcp:demo:write' },
  });
  expect(permission.owner).toBe('user');
  expect((store.db.prepare("SELECT user_wait_since FROM nodes WHERE task_id='work-task' AND id='work'").get() as { user_wait_since: number | null }).user_wait_since)
    .not.toBeNull();
});

test('a problem on the master node itself parks instead of re-waking the same master', async () => {
  const store = await fixture();
  store.db.prepare("UPDATE nodes SET status='blocked' WHERE task_id='anchor' AND id='master'").run();
  const parked = insertQuestion(store, {
    taskId: 'anchor',
    nodeId: 'master',
    operationId: null,
    kind: 'adapter_error',
    data: { reason: 'No credential bound for model local' },
  });
  expect(parked.owner).toBe('main');
  expect(isMasterParked(store, 'anchor', 'master')).toBe(true);
  // The master cannot resolve a problem on itself; auto-waking it would repeat
  // the identical failure forever. It is parked for an explicit retry or
  // configuration recovery and never becomes a user-facing question.
  expect(store.db.prepare("SELECT status FROM nodes WHERE task_id='anchor' AND id='master'").get())
    .toEqual({ status: 'pending' });
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='problem.routed'").get())
    .toEqual({ count: 0 });
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='problem.parked'").get())
    .toEqual({ count: 1 });
});

test('a same-named node in another task routes to the conversation master instead of parking it', async () => {
  const store = await fixture();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec,status) VALUES('work-task','master','{}','blocked')").run();
  const problem = insertQuestion(store, { taskId: 'work-task', nodeId: 'master', kind: 'recovery', data: {} });
  expect(problem.owner).toBe('main');
  expect(isMasterParked(store, 'anchor', 'master')).toBe(false);
  expect(store.db.prepare("SELECT type FROM events WHERE type IN ('problem.routed','problem.parked')").all())
    .toEqual([{ type: 'problem.routed' }]);
});

test('messages retry transient master problems while configuration recovery also releases other internal problems', async () => {
  const store = await fixture();
  const transient = insertQuestion(store, { taskId: 'anchor', nodeId: 'master', kind: 'adapter_error', data: {} });
  const model = insertQuestion(store, { taskId: 'anchor', nodeId: 'master', kind: 'model_unavailable', data: {} });
  const usage = insertQuestion(store, { taskId: 'anchor', nodeId: 'master', kind: 'unknown_usage', data: {} });
  const worker = insertQuestion(store, { taskId: 'work-task', nodeId: 'work', kind: 'adapter_error', data: {} });
  const status = (id: string) => store.db.prepare('SELECT status,answer FROM questions WHERE id=?').get(id);

  expect(recoverMaster(store, 'anchor', 'message')).toBe(true);
  expect(status(transient.id)).toEqual({ status: 'resolved', answer: '{"type":"retry"}' });
  for (const question of [model, usage, worker]) expect(status(question.id)).toEqual({ status: 'open', answer: null });
  expect(isMasterParked(store, 'anchor', 'master')).toBe(true);
  expect(recoverMaster(store, 'anchor', 'message')).toBe(false);

  expect(recoverMaster(store, 'anchor', 'configuration')).toBe(true);
  expect(isMasterParked(store, 'anchor', 'master')).toBe(false);
  expect(status(worker.id)).toEqual({ status: 'open', answer: null });
  expect(recoverMaster(store, 'anchor', 'configuration')).toBe(false);
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='task.master_recovered'").get())
    .toEqual({ count: 1 });
});

test('configuration recovery preserves user decisions and joins the surrounding transaction', async () => {
  const store = await fixture();
  const problem = insertQuestion(store, { taskId: 'anchor', nodeId: 'master', kind: 'recovery', data: {} });
  store.db.prepare("INSERT INTO nodes(task_id,id,spec,status) VALUES('anchor','other','{}','blocked')").run();
  const permission = insertQuestion(store, {
    taskId: 'anchor', nodeId: 'other', kind: 'permission', data: { grant: 'extra' },
  });
  expect(recoverMaster(store, 'anchor', 'configuration')).toBe(false);
  expect(isMasterParked(store, 'anchor', 'master')).toBe(true);
  expect(store.db.prepare('SELECT status FROM questions WHERE id=?').get(permission.id)).toEqual({ status: 'open' });

  const lifecycle = new OperationLifecycle(store, { advance: () => undefined });
  lifecycle.answer('anchor', permission.id, { type: 'grant', grant: 'extra' });
  expect(() => store.transaction(() => {
    expect(recoverMaster(store, 'anchor', 'configuration')).toBe(true);
    throw new Error('abort enclosing command');
  })).toThrow('abort enclosing command');
  expect(store.db.prepare('SELECT status,answer FROM questions WHERE id=?').get(problem.id)).toEqual({ status: 'open', answer: null });
  expect(isMasterParked(store, 'anchor', 'master')).toBe(true);
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='task.master_recovered'").get())
    .toEqual({ count: 0 });
  expect(recoverMaster(store, 'anchor', 'configuration')).toBe(true);
  expect(isMasterParked(store, 'anchor', 'master')).toBe(false);
});

test('without a conversation master, execution problems fall back to the user', async () => {
  const store = await fixture();
  store.db.prepare("DELETE FROM nodes WHERE task_id='anchor' AND id='master'").run();
  const problem = insertQuestion(store, { taskId: 'work-task', nodeId: 'work', kind: 'recovery', data: {} });
  expect(problem.owner).toBe('user');
  expect(store.db.prepare("SELECT user_wait_since FROM nodes WHERE task_id='work-task' AND id='work'").get())
    .toMatchObject({ user_wait_since: expect.any(Number) });
  expect(recoverMaster(store, 'anchor', 'configuration')).toBe(false);
});

test('upgrading reclassifies legacy internal questions so they leave the user inbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-question-upgrade-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'tasks.sqlite');
  let store = new TaskStore(path);
  store.transaction(() => {
    // Rewind to the pre-owner shape, then seed the legacy open questions that
    // the upgrade must classify: one genuine permission and one recovery.
    store.db.exec('DROP INDEX IF EXISTS questions_task_status; DROP INDEX IF EXISTS questions_owner_status; ALTER TABLE questions DROP COLUMN owner; ALTER TABLE operations DROP COLUMN system_prompt; PRAGMA user_version=24;');
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('anchor','p','chat',1,'chatting','c')").run();
    store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('c','p','anchor','chat',1,1)").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('anchor','master','{\"role\":\"master\"}','a','succeeded')").run();
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('work','p','work',2,'running','c')").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('work','work','{}','w','blocked')").run();
    store.db.prepare("INSERT INTO questions(id,task_id,node_id,kind,data,status) VALUES('rec','work','work','recovery','{\"reason\":\"SyntaxError\"}','open')").run();
    store.db.prepare("INSERT INTO questions(id,task_id,node_id,kind,data,status) VALUES('perm','work','work','permission','{\"grant\":\"mcp:demo:write\"}','open')").run();
  });
  store.close();
  store = new TaskStore(path);
  cleanup.push(async () => store.close());
  expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
  expect(store.db.prepare('SELECT id,kind,owner FROM questions ORDER BY id').all()).toEqual([
    { id: 'perm', kind: 'permission', owner: 'user' },
    { id: 'rec', kind: 'recovery', owner: 'main' },
  ]);
});
