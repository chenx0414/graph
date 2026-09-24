import { expect, test } from 'vitest';
import type { ConversationMessage } from '../../src/core/conversation-projection.ts';
import { clockLabel, elapsedLabel } from '../../src/web/labels.ts';
import { buildTranscriptRows } from '../../src/web/transcript-model.ts';

// Local-time fixtures: the label is about what the reader sees on the wall clock.
const at = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
const now = at(2026, 2, 10, 20, 0);

function message(overrides: Partial<ConversationMessage> & { id: string; role: string; text: string }): ConversationMessage {
  return {
    seq: 1,
    kind: 'chat',
    data: null,
    state: 'done',
    operationId: null,
    turn: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function rows(messages: ConversationMessage[], streaming: { operationId: string; entryId: string; partId: string; ordinal: number; text: string; length: number; updatedAt: number }[] = []) {
  return buildTranscriptRows({ messages, liveTools: [], streaming, busy: false });
}

function assistant(row: ReturnType<typeof rows>[number]) {
  return row as { kind: string; createdAt?: number; elapsedMs?: number | null };
}

test('同一天只显示时分，昨天与更早带日期，跨年带年份', () => {
  expect(clockLabel(at(2026, 2, 10, 14, 32), now)).toBe('14:32');
  expect(clockLabel(at(2026, 2, 10, 9, 5), now)).toBe('09:05');
  expect(clockLabel(at(2026, 2, 9, 23, 5), now)).toBe('昨天 23:05');
  expect(clockLabel(at(2026, 2, 5, 9, 7), now)).toBe('2月5日 09:07');
  expect(clockLabel(at(2025, 12, 31, 23, 59), now)).toBe('2025年12月31日 23:59');
  expect(clockLabel(null, now)).toBe('—');
});

test('耗时按秒 / 分 / 小时分档', () => {
  expect(elapsedLabel(8_000)).toBe('耗时 8 秒');
  expect(elapsedLabel(59_000)).toBe('耗时 59 秒');
  expect(elapsedLabel(60_000)).toBe('耗时 1 分');
  expect(elapsedLabel(133_000)).toBe('耗时 2 分 13 秒');
  expect(elapsedLabel(3_600_000)).toBe('耗时 1 小时');
  expect(elapsedLabel(3_900_000)).toBe('耗时 1 小时 5 分');
});

test('最终回答带上整轮耗时（同一 operation 最早一条 → 回答）', () => {
  const built = rows([
    message({ id: 'u1', seq: 1, role: 'user', operationId: 'op1', text: '做点什么', createdAt: at(2026, 2, 10, 14, 0) }),
    message({ id: 'n1', seq: 2, role: 'activity', kind: 'activity', operationId: 'op1', text: '先看看代码', createdAt: at(2026, 2, 10, 14, 0) + 1_000 }),
    message({ id: 'a1', seq: 3, role: 'assistant', kind: 'chat', operationId: 'op1', text: '做完了', createdAt: at(2026, 2, 10, 14, 1) }),
  ]);
  const answer = assistant(built.find(row => row.kind === 'assistant')!);
  expect(answer.createdAt).toBe(at(2026, 2, 10, 14, 1));
  expect(answer.elapsedMs).toBe(60_000);
});

test('只有回答一条、或行还在流式时，没有耗时', () => {
  const alone = assistant(rows([
    message({ id: 'a1', seq: 1, role: 'assistant', kind: 'chat', operationId: 'op2', text: '好的', createdAt: at(2026, 2, 10, 14, 0) }),
  ]).find(row => row.kind === 'assistant')!);
  expect(alone.elapsedMs).toBeNull();

  const live = assistant(rows([], [{ operationId: 'op3', entryId: 'e1', partId: 'p1', ordinal: 1, text: '正在生成…', length: 5, updatedAt: 0 }])
    .find(row => row.kind === 'assistant')!);
  expect(live.elapsedMs ?? null).toBeNull();
});

test('进行中的叙述气泡也带时间戳（该段最后一次更新的时间）', () => {
  // Live narration renders through the same copyable row as a final answer, so
  // it needs a stamp too; there is no recorded message yet, so the segment's own
  // last update is the honest time to show.
  const live = assistant(rows([], [{ operationId: 'op3', entryId: 'e1', partId: 'p1', ordinal: 1, text: '正在说…', length: 5, updatedAt: at(2026, 2, 10, 14, 2) }])
    .find(row => row.kind === 'assistant')!);
  expect(live.createdAt).toBe(at(2026, 2, 10, 14, 2));
});

test('不足一秒的耗时不说「0 秒」', () => {
  expect(elapsedLabel(400)).toBe('不到 1 秒');
  expect(elapsedLabel(0)).toBe('不到 1 秒');
});
