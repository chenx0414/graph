import { expect, test } from 'vitest';
import {
  conversationProjectionSnapshot,
  type ConversationMessage,
  type ConversationProjectionState,
} from '../../src/core/conversation-projection.ts';
import { buildTranscriptRows } from '../../src/web/transcript-model.ts';

function message(input: {
  id: string;
  seq: number;
  role: string;
  kind?: string;
  text?: string;
  operationId?: string | null;
  data?: Record<string, unknown> | null;
}): ConversationMessage {
  return {
    id: input.id,
    seq: input.seq,
    role: input.role,
    kind: input.kind ?? 'chat',
    text: input.text ?? input.id,
    data: input.data ?? null,
    state: 'done',
    operationId: input.operationId ?? null,
    turn: 1,
    createdAt: input.seq,
    updatedAt: input.seq,
  };
}

test('a background full-suite report never reaches the transcript', () => {
  const text = [
    '[后台全量确认失败]',
    '提交: 6549520f0e',
    '判定: 回归',
    'FAIL tests/e2e/desktop-shell.test.ts > OpenRouter authorization',
    '完整日志: /tmp/async-full.log',
  ].join('\n');
  const rows = buildTranscriptRows({
    messages: [{
      ...message({ id: 'full', seq: 1, role: 'user', text }),
      data: { source: { kind: 'rsi_async_full', commit: '6549520f0e' }, environment: false },
    }],
    streaming: [], liveTools: [], busy: false,
  });

  expect(rows).toEqual([]);
});

test('a compaction leaves no line in the transcript', () => {
  const rows = buildTranscriptRows({
    messages: [{
      ...message({ id: 'compaction', seq: 1, role: 'system', text: '上下文已压缩' }),
      kind: 'compaction',
      data: { tokensAfter: 1200, summary: '前文摘要' },
    }],
    streaming: [], liveTools: [], busy: false,
  });

  expect(rows).toEqual([]);
});

test('a self-improvement report leaves no row but its turn keeps the tool calls', () => {
  const rows = buildTranscriptRows({
    messages: [
      { ...message({ id: 'call', seq: 1, role: 'tool', operationId: 'a', text: 'node --run check' }), data: { toolName: 'bash' } },
      { ...message({ id: 'rsi', seq: 2, role: 'system', operationId: 'a', text: '### RSI 已应用：修复超时' }), kind: 'rsi', data: { status: 'applied', title: '修复超时' } },
    ],
    streaming: [], liveTools: [], busy: false,
  });

  expect(rows.map(row => row.kind)).toEqual(['tools']);
  expect(JSON.stringify(rows)).not.toContain('修复超时');
});

test('an ordinary user message keeps its bubble even when it quotes a notice', () => {
  const rows = buildTranscriptRows({
    messages: [message({ id: 'user', seq: 1, role: 'user', text: '[后台全量确认失败] 这是什么意思？' })],
    streaming: [], liveTools: [], busy: false,
  });

  expect(rows.map(row => row.kind)).toEqual(['message']);
});

test('a finished background command leaves no row and is not a queued message', () => {
  const rows = buildTranscriptRows({
    messages: [{
      ...message({ id: 'settled', seq: 1, role: 'user', text: 'bash 已经结束（settled），结果在会话的工具调用里；请读它继续。' }),
      state: 'done',
      data: { source: { kind: 'tool_settled', toolName: 'bash', toolCallId: 'call-1', state: 'settled' } },
    }],
    streaming: [], liveTools: [], busy: false,
  });

  expect(rows).toEqual([]);
});

test('a background tool result never shows up as a message waiting in the queue', () => {
  const record = {
    ...message({ id: 'settled', seq: 1, role: 'user', text: 'bash 已经结束（settled）' }),
    state: 'queued' as const,
    data: { source: { kind: 'tool_settled', toolName: 'bash' } },
  };
  const typed = { ...message({ id: 'typed', seq: 2, role: 'user', text: '再跑一条' }), state: 'queued' as const };
  const snapshot = conversationProjectionSnapshot({
    records: { settled: record, typed }, liveText: {}, liveTools: {}, streamNeedsResync: false,
  } as unknown as ConversationProjectionState, { busy: true });

  expect(snapshot.queuedMessages.map(entry => entry.id)).toEqual(['typed']);
});

test('a background result steered into the running turn leaves no row', () => {
  const settle = {
    ...message({ id: 'settled', seq: 2, role: 'user', text: 'bash 已经结束（settled）' }),
    state: 'delivered' as const,
    data: { source: { kind: 'tool_settled', toolName: 'bash', state: 'settled' } },
  };
  const rows = buildTranscriptRows({ messages: [settle], streaming: [], liveTools: [], busy: true });
  expect(rows.filter(row => row.kind === 'message'), 'a raw tool result must never read as something the user typed').toEqual([]);
  expect(rows.map(row => row.kind)).toEqual(['thinking']);
});
