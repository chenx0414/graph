import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import {
  approveHumanCheck, humanCheckPreReview, insertQuestion, pendingHumanChecks,
} from '../../src/core/question-routing.ts';
import { pendingWakes } from '../../src/core/wake-ledger.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

/**
 * A graph task whose human acceptance check has just opened, plus the conversation that
 * owns it. This is the exact moment "main reviews first" happens at.
 */
function fixture() {
  return mkdtemp(join(tmpdir(), 'graph-human-prereview-')).then(async root => {
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = new TaskStore(join(root, 'tasks.sqlite'));
    cleanup.push(async () => store.close());
    store.transaction(() => {
      store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
      store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('anchor','p','chat',1,'chatting','c')").run();
      store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('c','p','anchor','chat',1,1)").run();
      store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('anchor','master','{\"role\":\"master\"}','a','succeeded')").run();
      store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES('work','p','work',2,'running','c')").run();
      store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES('work','accept','{\"action\":\"graph.human_check\"}','h','blocked')").run();
    });
    return store;
  });
}

const masterStatus = (store: TaskStore) =>
  (store.db.prepare("SELECT status FROM nodes WHERE task_id='anchor' AND id='master'").get() as { status: string }).status;

/** The question the human check node opens when it finds nobody has approved it yet. */
function openCheck(store: TaskStore) {
  return insertQuestion(store, {
    taskId: 'work',
    nodeId: 'accept',
    kind: 'human_check',
    data: { prompt: 'A human acceptance check is required', activationId: 'h', commitSha: null },
  }).id;
}

test('a human check opens to the user, and the master is told to look first', async () => {
  const store = await fixture();
  const check = openCheck(store);
  // The person is still the decider: the question's owner never changes.
  expect(store.db.prepare('SELECT owner,status FROM questions WHERE id=?').get(check))
    .toEqual({ owner: 'user', status: 'open' });
  // And the master is awake with the reason, which is the whole point of reviewing first.
  expect(pendingWakes(store, 'anchor', 'master').map(wake => wake.kind)).toEqual(['human_check']);
  expect(masterStatus(store)).toBe('pending');
});

test('approving is not acceptance: the person still has to pass it themselves', async () => {
  const store = await fixture();
  const check = openCheck(store);
  const approved = approveHumanCheck(store, check, 'looks done to me');
  expect(approved).toBe(true);

  // The check is still open and still the user's, exactly as before the approval.
  expect(store.db.prepare('SELECT owner,status FROM questions WHERE id=?').get(check))
    .toEqual({ owner: 'user', status: 'open' });
  // The approval is a recorded fact, not a silent state change.
  const row = store.db.prepare('SELECT data FROM questions WHERE id=?').get(check) as { data: string };
  expect(JSON.parse(row.data)).toMatchObject({ preReview: { approved: true, note: 'looks done to me' } });
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='human.prereview_approved'").get())
    .toEqual({ count: 1 });
});

test('the same approval twice is still one approval', async () => {
  const store = await fixture();
  const check = openCheck(store);
  // Idempotent like every other wake: re-observing the same decision must not write a
  // second fact or wake the master again.
  expect(approveHumanCheck(store, check, 'once')).toBe(true);
  expect(approveHumanCheck(store, check, 'twice')).toBe(false);
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='human.prereview_approved'").get())
    .toEqual({ count: 1 });
  const row = store.db.prepare('SELECT data FROM questions WHERE id=?').get(check) as { data: string };
  expect(JSON.parse(row.data).preReview.note).toBe('once');
});

test('only checks that are still open can be approved, and a stranger question cannot', async () => {
  const store = await fixture();
  const check = openCheck(store);
  store.db.prepare("UPDATE questions SET status='resolved',answer='null' WHERE id=?").run(check);
  expect(approveHumanCheck(store, check, 'too late')).toBe(false);

  const other = insertQuestion(store, { taskId: 'work', nodeId: 'accept', kind: 'permission', data: { grant: 'x' } }).id;
  expect(humanCheckPreReview(store, other)).toBeNull();
  expect(approveHumanCheck(store, other, 'wrong kind')).toBe(false);
});

test('the open checks awaiting review are listed, and stop being listed once approved', async () => {
  const store = await fixture();
  const check = openCheck(store);
  expect(pendingHumanChecks(store, 'c')).toEqual([
    { questionId: check, taskId: 'work', nodeId: 'accept' },
  ]);
  store.transaction(() => approveHumanCheck(store, check, 'fine'));
  expect(pendingHumanChecks(store, 'c')).toEqual([]);
});
