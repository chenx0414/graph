import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { conversationStreams, publishConversationDelta, recordConversationOutput } from '../../src/core/conversation.ts';
import { TaskStore } from '../../src/core/store.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-conversation-stream-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.db.prepare("INSERT INTO projects VALUES('p','/tmp','[]')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq) VALUES('task','p','chat',1)").run();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec) VALUES('task','master','{\"role\":\"master\"}')").run();
  store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('conversation','p','task','chat',1,1)").run();
  // The conversation is found from the task side, so the link has to exist.
  store.db.prepare("UPDATE tasks SET conversation_id='conversation' WHERE id='task'").run();
  store.db.prepare(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active)
    VALUES('op','task','master',1,'{}','dispatched',0,1)`).run();
  return store;
}

test('live deltas persist a recoverable snapshot and append only the new suffix', async () => {
  const store = await fixture();

  publishConversationDelta(store, {
    taskId: 'task',
    conversationId: 'conversation',
    operationId: 'op',
    entryId: 'op',
    partId: 'text',
    ordinal: 1,
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
    ordinal: 1,
    delta: '继续',
    text: '完整开头继续',
    length: 6,
  });

  const events = store.db.prepare("SELECT data FROM events WHERE type='message.delta' ORDER BY cursor")
    .all() as { data: string }[];
  expect(events.map(row => JSON.parse(row.data))).toEqual([
    expect.objectContaining({ text: '完整开头', len: 4, reset: true, ordinal: 1 }),
    expect.objectContaining({ text: '继续', len: 6, reset: false, ordinal: 1 }),
  ]);
  expect(conversationStreams(store, 'conversation')).toMatchObject([{
    operationId: 'op',
    entryId: 'op',
    partId: 'text',
    ordinal: 1,
    text: '完整开头继续',
    length: 6,
  }]);

  store.db.prepare("UPDATE operations SET state='succeeded' WHERE id='op'").run();
  expect(conversationStreams(store, 'conversation')).toEqual([]);

  store.db.prepare("UPDATE operations SET state='unknown' WHERE id='op'").run();
  expect(conversationStreams(store, 'conversation')).toEqual([]);
});

test('two text parts of one operation stay apart and come back in turn order', async () => {
  const store = await fixture();

  // Text emitted before and after a tool call is two parts of one assistant
  // message, not one merged block.
  publishConversationDelta(store, {
    taskId: 'task', conversationId: 'conversation', operationId: 'op',
    entryId: 'entry-1', partId: '0', ordinal: 1, delta: '先看一下', text: '先看一下', length: 4,
  });
  publishConversationDelta(store, {
    taskId: 'task', conversationId: 'conversation', operationId: 'op',
    entryId: 'entry-1', partId: '2', ordinal: 3, delta: '再改投影', text: '再改投影', length: 5,
  });

  expect(conversationStreams(store, 'conversation').map(stream => [stream.partId, stream.ordinal, stream.text]))
    .toEqual([['0', 1, '先看一下'], ['2', 3, '再改投影']]);
});

test('a settled turn records its narration and tool calls in the order they happened', async () => {
  const store = await fixture();
  const operation = { id: 'op', taskId: 'task', nodeId: 'master', attempt: 1, kind: 'agent' } as unknown as Parameters<typeof recordConversationOutput>[1];
  const result = {
    outcome: 'completed',
    output: {
      text: '最终回答',
      activity: [
        { type: 'narration', text: '先读代码' },
        { type: 'tool', name: 'read', summary: 'a.ts', toolCallId: 't1', state: 'done' },
        { type: 'narration', text: '最终回答' },
        { type: 'tool', name: 'edit', summary: 'b.ts', toolCallId: 't2', state: 'error' },
      ],
    },
  } as unknown as Parameters<typeof recordConversationOutput>[2];

  recordConversationOutput(store, operation, result);

  const rows = store.db.prepare("SELECT role,kind,text FROM messages WHERE conversation_id='conversation' ORDER BY seq")
    .all();
  expect(rows).toEqual([
    { role: 'activity', kind: 'activity', text: '先读代码' },
    { role: 'tool', kind: 'tool', text: 'read: a.ts' },
    { role: 'tool', kind: 'tool', text: 'edit: b.ts' },
    { role: 'assistant', kind: 'chat', text: '最终回答' },
  ]);

  // A retry rewrites the activity instead of duplicating it.
  recordConversationOutput(store, operation, result);
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id='conversation'").get())
    .toEqual({ count: 4 });
});
