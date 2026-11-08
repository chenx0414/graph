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

test('a background full-suite notice is its own row, never a user message', () => {
  const text = [
    '[后台全量确认失败]',
    '提交: 6549520f0e',
    '判定: 回归',
    'FAIL tests/e2e/desktop-shell.test.ts > OpenRouter authorization',
    '  - tests/e2e/desktop-crash-recovery.test.ts [assertion]',
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

  expect(rows.map(row => row.kind)).toEqual(['rsiFull']);
  expect(rows[0]).toMatchObject({
    verdict: '回归',
    commit: '6549520f0e',
    environment: false,
    files: ['tests/e2e/desktop-shell.test.ts', 'tests/e2e/desktop-crash-recovery.test.ts'],
    logPath: '/tmp/async-full.log',
  });
});

test('a long verdict is split so the card headline stays one short line', () => {
  const text = [
    '[后台全量确认失败]',
    '提交: 11138f1c4392',
    '判定: 回归；未匹配: tests/e2e/desktop-shell.test.ts: locator.click: Timeout 30000ms exceeded；合并了 3 次确认请求，只跑一次全量',
    '完整日志: /tmp/async-full.log',
  ].join('\n');
  const rows = buildTranscriptRows({
    messages: [{
      ...message({ id: 'long', seq: 1, role: 'user', text }),
      data: { source: { kind: 'rsi_async_full', commit: '11138f1c4392' }, environment: false },
    }],
    streaming: [], liveTools: [], busy: false,
  });
  expect(rows.map(row => row.kind)).toEqual(['rsiFull']);
  expect(rows[0]).toMatchObject({
    verdict: '回归',
    verdictDetails: [
      '未匹配: tests/e2e/desktop-shell.test.ts: locator.click: Timeout 30000ms exceeded',
      '合并了 3 次确认请求，只跑一次全量',
    ],
  });
});

test('an ordinary user message keeps its bubble even when it quotes a notice', () => {
  const rows = buildTranscriptRows({
    messages: [message({ id: 'user', seq: 1, role: 'user', text: '[后台全量确认失败] 这是什么意思？' })],
    streaming: [], liveTools: [], busy: false,
  });

  expect(rows.map(row => row.kind)).toEqual(['message']);
});
