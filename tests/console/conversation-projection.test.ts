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
    streaming: [['op', 'partial']],
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
    promptSuggestion: '',
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
    streaming: [['active', '新输出']],
    liveTools: [{ operationId: 'active', toolCallId: 'tool-active' }],
  });
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
