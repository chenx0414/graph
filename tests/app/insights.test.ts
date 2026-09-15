import { describe, expect, test } from 'vitest';
import {
  buildTimeline, formatTokens, nodeTone, openQuestionTotal, summarizeUsage, usageText,
  type EventRow,
} from '../../src/web/insights.ts';

const event = (cursor: number, type: string, data: Record<string, unknown> = {}, timestamp = cursor * 1000): EventRow => ({ cursor, type, data, timestamp });

describe('run timeline', () => {
  test('labels known events, attaches node ids and sorts chronologically', () => {
    const entries = buildTimeline([
      event(3, 'operation.result', { operationId: 'op-1', result: { output: { summary: 'done' } } }, 3000),
      event(1, 'task.created', { request: 'build a page' }, 1000),
      event(2, 'operation.dispatched', { operationId: 'op-1' }, 2000),
    ]);
    expect(entries.map(entry => entry.cursor)).toEqual([1, 2, 3]);
    expect(entries[0]).toMatchObject({ label: '创建任务', tone: 'info' });
    expect(entries[1]).toMatchObject({ label: '发送调用', tone: 'active', detail: 'op-1' });
    expect(entries[2]).toMatchObject({ label: '调用完成', tone: 'success' });
    expect(entries[2]?.detail).toContain('summary');
  });

  test('keeps a node id when the payload has one and de-duplicates cursors', () => {
    const entries = buildTimeline([
      event(5, 'question.opened', { nodeId: 'work', kind: 'budget', data: { prompt: '需要更多预算' } }),
      event(5, 'question.opened', { nodeId: 'work', kind: 'budget' }),
      event(4, 'operation.interrupted', { nodeId: 'work', reason: 'paused', usage: 50 }),
      event(6, 'operation.interrupted', { nodeId: 'work', reason: 'paused', usage: null }),
    ]);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ label: '调用中断', nodeId: 'work', tone: 'warn' });
    expect(entries[0]?.detail).toBe('paused · 已结算 50 tokens');
    expect(entries[1]).toMatchObject({ label: '提出问题', nodeId: 'work' });
    expect(entries[1]?.detail).toBe('budget · 需要更多预算');
    expect(entries[2]?.detail).toBe('paused · 已知用量未结算');
  });

  test('falls back to the raw type and ignores malformed rows', () => {
    const entries = buildTimeline([
      { cursor: 1, type: 'custom.event', data: {}, timestamp: 1 },
      { cursor: Number.NaN, type: 'x', data: {}, timestamp: 1 },
      null as unknown as EventRow,
    ]);
    expect(entries).toEqual([{ cursor: 1, timestamp: 1, type: 'custom.event', label: 'custom.event', tone: 'info' }]);
  });

  test('describes rework edges and model switches', () => {
    const entries = buildTimeline([
      event(1, 'graph.rework', { from: 'check', to: ['work'] }),
      event(2, 'model.switched', { nodeId: 'work', from: 'small', to: 'large' }),
    ]);
    expect(entries[0]?.detail).toBe('→ work');
    expect(entries[1]?.detail).toBe('small → large');
  });
});

describe('usage summary', () => {
  test('sums measured nodes and counts unknown usage separately', () => {
    const summary = summarizeUsage([
      { id: 'a', status: 'succeeded', used: 100, budget: 1_000 },
      { id: 'b', status: 'running', used: null, budget: 2_000 },
      { id: 'c', status: 'pending', budget: null },
    ], { unknown: true });
    expect(summary).toMatchObject({ used: 100, budget: 3_000, remaining: 2_900, unlimited: false, measuredNodes: 1, unknownNodes: 2, unknownCost: true, cost: null });
    const text = usageText(summary);
    expect(text).toContain('已计量 100 tokens');
    expect(text).toContain('2 个节点用量未知');
    expect(text).toContain('费用未知');
  });

  test('never folds unknown usage to zero or invents a cost', () => {
    const summary = summarizeUsage([{ id: 'a', status: 'succeeded', used: null }], { amount: 1.5 });
    expect(summary.used).toBe(0);
    expect(summary.unknownNodes).toBe(1);
    expect(summary.remaining).toBeNull();
    expect(summary.cost).toBe(1.5);
    expect(formatTokens(undefined)).toBe('未知');
    expect(formatTokens(0)).toBe('0');
  });
});

describe('status tones and inbox count', () => {
  test('maps node statuses onto the palette used by the graph', () => {
    expect(nodeTone('preparing')).toBe('active');
    expect(nodeTone('succeeded')).toBe('success');
    expect(nodeTone('failed')).toBe('error');
    expect(nodeTone('blocked')).toBe('blocked');
    expect(nodeTone('pending')).toBe('pending');
  });

  test('counts open questions across tasks', () => {
    expect(openQuestionTotal([{ openQuestions: 2 }, { openQuestions: 0 }, {}])).toBe(2);
  });
});
