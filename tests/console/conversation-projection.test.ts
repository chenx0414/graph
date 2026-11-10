import { expect, test } from 'vitest';
import {
  applyConversationEvent,
  conversationProjectionSnapshot,
  createConversationProjection,
  observeConversationHistory,
  observeConversationView,
  type ConversationMessage,
} from '../../src/core/conversation-projection.ts';

function message(input: {
  id: string;
  seq: number;
  role?: string;
  text?: string;
  state?: string;
  operationId?: string | null;
  data?: Record<string, unknown> | null;
  updatedAt?: number;
}): ConversationMessage {
  return {
    id: input.id,
    seq: input.seq,
    role: input.role ?? 'user',
    kind: 'chat',
    text: input.text ?? input.id,
    data: input.data ?? null,
    state: input.state ?? 'done',
    operationId: input.operationId ?? null,
    turn: 1,
    createdAt: input.seq,
    updatedAt: input.updatedAt ?? input.seq,
  };
}

test('stable IDs keep the newest record and ignore stale history', () => {
  let state = createConversationProjection();
  state = observeConversationView(state, {
    messageCount: 1,
    messages: [message({ id: 'm', seq: 1, state: 'pending', updatedAt: 10 })],
  });
  state = applyConversationEvent(state, {
    type: 'message.updated',
    data: { message: message({ id: 'm', seq: 1, state: 'delivered', updatedAt: 20 }) },
  });
  state = observeConversationHistory(state, {
    request: { direction: 'before', cursor: 1 },
    messages: [message({ id: 'm', seq: 1, state: 'pending', updatedAt: 15 })],
  });
  expect(conversationProjectionSnapshot(state, { busy: false }).messages).toMatchObject([
    { id: 'm', state: 'delivered', updatedAt: 20 },
  ]);
});

test('history requests first fill older records and then sweep a burst hole forward', () => {
  let state = createConversationProjection();
  state = observeConversationView(state, {
    messageCount: 300,
    messages: Array.from({ length: 20 }, (_, index) => message({ id: `m${index}`, seq: index })),
  });
  expect(conversationProjectionSnapshot(state, { busy: false }).historyRequest)
    .toEqual({ direction: 'after', cursor: 0 });

  const first = Array.from({ length: 200 }, (_, index) => message({ id: `m${index + 20}`, seq: index + 20 }));
  state = observeConversationHistory(state, {
    request: { direction: 'after', cursor: 0 },
    messages: first,
  });
  expect(conversationProjectionSnapshot(state, { busy: false }).historyRequest)
    .toEqual({ direction: 'after', cursor: 219 });

  state = observeConversationHistory(state, {
    request: { direction: 'after', cursor: 219 },
    messages: Array.from({ length: 80 }, (_, index) => message({ id: `m${index + 220}`, seq: index + 220 })),
  });
  expect(conversationProjectionSnapshot(state, { busy: false }).historyRequest).toBeNull();
});

test('an empty before page switches to the forward sweep when the earliest record has a global sequence gap', () => {
  let state = createConversationProjection();
  state = observeConversationView(state, {
    messageCount: 4,
    messages: [
      message({ id: 'm10', seq: 10 }),
      message({ id: 'm11', seq: 11 }),
      message({ id: 'm12', seq: 12 }),
    ],
  });
  expect(conversationProjectionSnapshot(state, { busy: false }).historyRequest)
    .toEqual({ direction: 'before', cursor: 10 });

  state = observeConversationHistory(state, {
    request: { direction: 'before', cursor: 10 },
    messages: [],
  });
  expect(conversationProjectionSnapshot(state, { busy: false }).historyRequest)
    .toEqual({ direction: 'after', cursor: 10 });
});

test('live deltas and tools disappear when durable records arrive, while queued messages stay visible', () => {
  let state = createConversationProjection();
  state = applyConversationEvent(state, {
    type: 'message.delta',
    data: { operationId: 'op', text: 'partial' },
  });
  state = applyConversationEvent(state, {
    type: 'message.tool',
    data: { toolCallId: 'tool-1', toolName: 'read', summary: 'README.md', phase: 'start' },
  });
  expect(conversationProjectionSnapshot(state, { busy: true })).toMatchObject({
    streaming: [{ operationId: 'op', text: 'partial' }],
    liveTools: [{ toolCallId: 'tool-1', name: 'read', done: false }],
  });

  state = applyConversationEvent(state, {
    type: 'message.created',
    data: { message: message({ id: 'assistant', seq: 2, role: 'assistant', operationId: 'op', text: 'final' }) },
  });
  state = applyConversationEvent(state, {
    type: 'message.created',
    data: { message: message({ id: 'tool', seq: 3, role: 'tool', data: { toolCallId: 'tool-1' } }) },
  });
  state = applyConversationEvent(state, {
    type: 'message.created',
    data: { message: message({ id: 'queued', seq: 4, role: 'user', state: 'queued' }) },
  });

  expect(conversationProjectionSnapshot(state, { busy: false })).toMatchObject({
    streaming: [],
    liveTools: [],
    queuedMessages: [{ id: 'queued' }],
  });
});

test('tool records render before the final assistant answer for the same turn', () => {
  let state = createConversationProjection();
  state = observeConversationView(state, {
    messageCount: 3,
    messages: [
      message({ id: 'user', seq: 1, role: 'user' }),
      message({ id: 'assistant', seq: 2, role: 'assistant', text: 'final answer' }),
      message({ id: 'tool', seq: 3, role: 'tool', text: 'read README.md' }),
    ],
  });

  expect(conversationProjectionSnapshot(state, { busy: false }).messages.map(item => item.id))
    .toEqual(['user', 'tool', 'assistant']);
});

test('terminal operation events discard abandoned live output without touching the active attempt', () => {
  let state = createConversationProjection();
  for (const [operationId, text] of [['abandoned', '旧输出'], ['active', '新输出']] as const) {
    state = applyConversationEvent(state, {
      type: 'message.delta',
      data: { operationId, text },
    });
    state = applyConversationEvent(state, {
      type: 'message.tool',
      data: { operationId, toolCallId: `tool-${operationId}`, toolName: 'read', summary: `${operationId}.md`, phase: 'start' },
    });
  }

  state = applyConversationEvent(state, {
    type: 'operation.interrupted',
    data: { operationId: 'abandoned' },
  });

  expect(conversationProjectionSnapshot(state, { busy: true })).toMatchObject({
    streaming: [{ operationId: 'active', text: '新输出' }],
    liveTools: [{ operationId: 'active', toolCallId: 'tool-active' }],
  });
});

test('an uncertain operation also ends its live stream so the answer stops flashing', () => {
  let state = createConversationProjection();
  state = applyConversationEvent(state, { type: 'message.delta', data: { operationId: 'uncertain', text: '一半的回答' } });
  state = applyConversationEvent(state, {
    type: 'message.tool',
    data: { operationId: 'uncertain', toolCallId: 'tool-1', toolName: 'read', summary: 'a.md', phase: 'start' },
  });
  state = applyConversationEvent(state, { type: 'operation.unknown', data: { operationId: 'uncertain' } });
  expect(conversationProjectionSnapshot(state, { busy: true })).toMatchObject({ streaming: [], liveTools: [] });
});

test('interrupted retries do not push the durable final answer above stale stream rows', () => {
  let state = createConversationProjection();
  for (const operationId of ['attempt-1', 'attempt-2']) {
    state = applyConversationEvent(state, {
      type: 'message.delta',
      data: { operationId, text: `${operationId} partial` },
    });
    state = applyConversationEvent(state, {
      type: 'operation.interrupted',
      data: { operationId },
    });
  }
  state = applyConversationEvent(state, {
    type: 'message.created',
    data: {
      message: message({
        id: 'final',
        seq: 2,
        role: 'assistant',
        text: 'final answer',
        operationId: 'attempt-3',
      }),
    },
  });

  expect(conversationProjectionSnapshot(state, { busy: false })).toMatchObject({
    messages: [{ id: 'final', text: 'final answer' }],
    streaming: [],
    liveTools: [],
  });
});

test('length-checked append deltas extend in place and recover from a snapshot after desync', () => {
  let state = createConversationProjection();
  state = applyConversationEvent(state, {
    type: 'message.delta',
    data: {
      operationId: 'op',
      entryId: 'op',
      partId: 'text',
      text: '完整开头',
      len: 4,
      reset: true,
    },
  });
  state = applyConversationEvent(state, {
    type: 'message.delta',
    data: {
      operationId: 'op',
      entryId: 'op',
      partId: 'text',
      text: '继续',
      len: 6,
      reset: false,
    },
  });
  expect(conversationProjectionSnapshot(state, { busy: true }).streaming).toMatchObject([
    { operationId: 'op', entryId: 'op', partId: 'text', text: '完整开头继续', length: 6 },
  ]);

  state = applyConversationEvent(state, {
    type: 'message.delta',
    data: {
      operationId: 'op',
      entryId: 'op',
      partId: 'text',
      text: '错位',
      len: 9,
      reset: false,
    },
  });
  expect(conversationProjectionSnapshot(state, { busy: true }).streamNeedsResync).toBe(true);

  state = observeConversationView(state, {
    messageCount: 0,
    messages: [],
    streams: [{
      operationId: 'op',
      entryId: 'op',
      partId: 'text',
      ordinal: 0,
      text: '权威快照',
      length: 4,
      updatedAt: 20,
    }],
  });
  expect(conversationProjectionSnapshot(state, { busy: true })).toMatchObject({
    streamNeedsResync: false,
    streaming: [{ operationId: 'op', text: '权威快照', length: 4 }],
  });
});

test('a live turn keeps its two text parts apart, in the order they happened', () => {
  let state = createConversationProjection();
  state = applyConversationEvent(state, {
    type: 'message.delta',
    data: { operationId: 'op', entryId: 'entry-1', partId: '0', ordinal: 1, text: '先看一下', len: 4, reset: true },
  });
  state = applyConversationEvent(state, {
    type: 'message.tool',
    data: { operationId: 'op', toolCallId: 'tool-1', toolName: 'read', summary: 'a.ts', phase: 'start', ordinal: 2 },
  });
  state = applyConversationEvent(state, {
    type: 'message.delta',
    data: { operationId: 'op', entryId: 'entry-1', partId: '2', ordinal: 3, text: '再改投影', len: 5, reset: true },
  });
  const snapshot = conversationProjectionSnapshot(state, { busy: true });
  expect(snapshot.streaming.map(item => [item.partId, item.text, item.ordinal]))
    .toEqual([['0', '先看一下', 1], ['2', '再改投影', 3]]);
  expect(snapshot.liveTools.map(tool => [tool.toolCallId, tool.ordinal])).toEqual([['tool-1', 2]]);
});

test('a reconnect keeps every part and its ordinal', () => {
  let state = createConversationProjection();
  state = observeConversationView(state, {
    messageCount: 0,
    messages: [],
    streams: [
      { operationId: 'op', entryId: 'entry-1', partId: '0', ordinal: 1, text: '前', length: 1, updatedAt: 10 },
      { operationId: 'op', entryId: 'entry-1', partId: '2', ordinal: 3, text: '后', length: 1, updatedAt: 20 },
    ],
  });
  expect(conversationProjectionSnapshot(state, { busy: true }).streaming.map(item => [item.partId, item.ordinal]))
    .toEqual([['0', 1], ['2', 3]]);
});

test('a settled operation drops every live part, not just the first', () => {
  let state = createConversationProjection();
  state = applyConversationEvent(state, {
    type: 'message.delta',
    data: { operationId: 'op', entryId: 'entry-1', partId: '0', ordinal: 1, text: '前', len: 1, reset: true },
  });
  state = applyConversationEvent(state, {
    type: 'message.delta',
    data: { operationId: 'op', entryId: 'entry-1', partId: '2', ordinal: 3, text: '后', len: 1, reset: true },
  });
  state = applyConversationEvent(state, { type: 'operation.unknown', data: { operationId: 'op' } });
  expect(conversationProjectionSnapshot(state, { busy: true }).streaming).toEqual([]);
});

test('snapshot does not resurrect settled live text and ignores replayed deltas', () => {
  let state = createConversationProjection();
  const stream = { operationId: 'op', entryId: 'e', partId: '0', ordinal: 1, text: 'done', length: 4, updatedAt: 1 };
  state = observeConversationView(state, { messages: [], messageCount: 0, streams: [stream] });
  state = applyConversationEvent(state, { type: 'message.delta', data: { ...stream, text: 'do', len: 2, reset: true } });
  expect(conversationProjectionSnapshot(state, { busy: true }).streaming[0]?.text).toBe('done');
  state = observeConversationView(state, { messages: [], messageCount: 0, streams: [] });
  expect(conversationProjectionSnapshot(state, { busy: true }).streaming).toEqual([]);
});

test('snapshot cursor filters old events and an in-flight snapshot cannot erase newer text', () => {
  let state = observeConversationView(createConversationProjection(), { eventCursor: 100, messages: [], messageCount: 0, streams: [] });
  const event = { type: 'message.delta', data: { operationId: 'op', entryId: 'e', partId: '0', text: 'new', len: 3, reset: true } };
  expect(applyConversationEvent(state, { ...event, cursor: 90 })).toBe(state);
  state = applyConversationEvent(state, { ...event, cursor: 101 });
  state = observeConversationView(state, { eventCursor: 100, messages: [], messageCount: 0, streams: [] });
  expect(conversationProjectionSnapshot(state, { busy: true }).streaming[0]?.text).toBe('new');
});

test('a fresh tail snapshot cannot swallow an older cached message update in flight', () => {
  let state = observeConversationView(createConversationProjection(), { eventCursor: 10, messages: [message({ id: 'old', seq: 1, state: 'pending' })], messageCount: 1 });
  state = observeConversationView(state, { eventCursor: 30, messages: [message({ id: 'new', seq: 20 })], messageCount: 20 });
  state = applyConversationEvent(state, { cursor: 25, type: 'message.updated', data: { message: message({ id: 'old', seq: 1, state: 'delivered', updatedAt: 25 }) } });
  expect(state.records.old?.state).toBe('delivered');
});

test('message image attachments retain their payload for rendering after reload', async () => {
  const { messageAttachments } = await import('../../src/core/conversation-projection.ts');
  const image = { name: 'photo.png', type: 'image/png', size: 3, text: '', data: 'YWJj' };
  expect(messageAttachments(message({ id: 'image', seq: 1, data: { attachments: [image] } }))).toEqual([{ ...image, imageUrl: '/api/messages/image/attachments/0' }]);
});

test('a turn answer stays ahead of the next turn that starts in the same record run', () => {
  let state = createConversationProjection();
  state = observeConversationView(state, {
    messageCount: 4,
    messages: [
      message({ id: 'u1', seq: 1, role: 'user', text: '第一轮' }),
      message({ id: 't1', seq: 2, role: 'tool', operationId: 'op-a', data: { toolName: 'bash', toolCallId: 't1', ordinal: 1 } }),
      message({ id: 'a1', seq: 3, role: 'assistant', operationId: 'op-a', text: '第一轮答案' }),
      message({ id: 't2', seq: 4, role: 'tool', operationId: 'op-b', data: { toolName: 'bash', toolCallId: 't2', ordinal: 1 } }),
    ],
  } as never);
  const snapshot = conversationProjectionSnapshot(state, { busy: true });
  expect(snapshot.messages.map(entry => entry.id)).toEqual(['u1', 't1', 'a1', 't2']);
});
