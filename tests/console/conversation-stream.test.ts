import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { conversationStreams, publishConversationDelta } from '../../src/core/conversation.ts';
import { TaskStore } from '../../src/core/store.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

test('live deltas persist a recoverable snapshot and append only the new suffix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-conversation-stream-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.db.prepare("INSERT INTO projects VALUES('p','/tmp','[]')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq) VALUES('task','p','chat',1)").run();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec) VALUES('task','master','{}')").run();
  store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('conversation','p','task','chat',1,1)").run();
  store.db.prepare(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active)
    VALUES('op','task','master',1,'{}','dispatched',0,1)`).run();

  publishConversationDelta(store, {
    taskId: 'task',
    conversationId: 'conversation',
    operationId: 'op',
    entryId: 'op',
    partId: 'text',
    delta: '完整开头',
    text: '完整开头',
    length: 4,
  });
  publishConversationDelta(store, {
    taskId: 'task',
    conversationId: 'conversation',
    operationId: 'op',
    entryId: 'op',
    partId: 'text',
    delta: '继续',
    text: '完整开头继续',
    length: 6,
  });

  const events = store.db.prepare("SELECT data FROM events WHERE type='message.delta' ORDER BY cursor")
    .all() as { data: string }[];
  expect(events.map(row => JSON.parse(row.data))).toEqual([
    expect.objectContaining({ text: '完整开头', len: 4, reset: true }),
    expect.objectContaining({ text: '继续', len: 6, reset: false }),
  ]);
  expect(conversationStreams(store, 'conversation')).toMatchObject([{
    operationId: 'op',
    entryId: 'op',
    partId: 'text',
    text: '完整开头继续',
    length: 6,
  }]);

  store.db.prepare("UPDATE operations SET state='succeeded' WHERE id='op'").run();
  expect(conversationStreams(store, 'conversation')).toEqual([]);

  store.db.prepare("UPDATE operations SET state='unknown' WHERE id='op'").run();
  expect(conversationStreams(store, 'conversation')).toEqual([]);
});
