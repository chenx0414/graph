import { expect, test } from 'vitest';
import { conversationActivityRecords } from '../../src/core/conversation.ts';

test('turn activity keeps narration and tool calls in the order they happened', () => {
  const records = conversationActivityRecords([
    { type: 'narration', text: '先看一下现有实现' },
    { type: 'tool', name: 'read', summary: 'src/web/Conversation.tsx', toolCallId: 't1', state: 'done' },
    { type: 'narration', text: '现在改投影' },
    { type: 'tool', name: 'edit', summary: 'src/core/conversation.ts', toolCallId: 't2', state: 'error' },
  ], '最终回答');
  expect(records.map(record => record.kind)).toEqual(['narration', 'tool', 'narration', 'tool']);
  expect(records[0]).toEqual({ kind: 'narration', text: '先看一下现有实现' });
  expect(records[1]).toEqual({ kind: 'tool', text: 'read: src/web/Conversation.tsx', data: { tool: 'read', toolCallId: 't1' } });
  expect(records[3]).toMatchObject({ kind: 'tool', data: { tool: 'edit', toolCallId: 't2', error: true } });
});

test('the narration that is the final reply is dropped, not shown twice', () => {
  expect(conversationActivityRecords([
    { type: 'narration', text: '最终回答' },
    { type: 'narration', text: '   ' },
  ], '最终回答')).toEqual([]);
});

test('older operations keep their plain tool activity shape', () => {
  expect(conversationActivityRecords([
    { name: 'grep', summary: 'ordinal', toolCallId: 't9' },
  ], '')).toEqual([{ kind: 'tool', text: 'grep: ordinal', data: { tool: 'grep', toolCallId: 't9' } }]);
});

test('turn activity keeps the ordinal that orders it in the transcript', () => {
  const records = conversationActivityRecords([
    { type: 'narration', text: '先读代码', ordinal: 1 },
    { name: 'read', summary: 'a.ts', toolCallId: 'call-1', state: 'done', ordinal: 2 },
  ], '');
  expect(records.map(record => record.ordinal)).toEqual([1, 2]);
});
