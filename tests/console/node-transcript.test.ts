import { expect, test } from 'vitest';
import { nodeMessages, type Entry } from '../../src/web/node-transcript.ts';
import { buildTranscriptRows } from '../../src/web/transcript-model.ts';
const entry = (seq: number, role: string, kind: string, text: string): Entry => ({ seq, id: String(seq), role, kind, text, data: null, operationId: 'operation', createdAt: seq });
test('a settled node folds intermediate narration and tools while keeping its final answer visible', () => {
  const entries = [entry(1, 'assistant', 'message', '先检查'), { ...entry(2, 'tool', 'call', 'read file'), data: { toolCallId: 'call', toolName: 'read' } },
    { ...entry(3, 'tool', 'result', '工具执行完成'), data: { toolCallId: 'call', toolName: 'read' } }, entry(4, 'assistant', 'message', '完成')];
  const input = { messages: nodeMessages(entries, [{ id: 'operation', state: 'completed' }], false), liveTools: [], streaming: [], busy: false };
  const rows = buildTranscriptRows(input);
  expect(rows.map(row => row.kind)).toEqual(['activity', 'assistant']);
  expect(rows[0]).toMatchObject({ collapsed: true, items: [{ kind: 'narration' }, { kind: 'tool', tool: { done: true } }] });
  expect(rows[1]).toMatchObject({ text: '完成' });
  const running = buildTranscriptRows({ ...input, messages: nodeMessages(entries, [{ id: 'operation', state: 'dispatched', workerActive: true }], true), busy: true });
  expect(running.some(row => row.kind === 'activity' && row.collapsed)).toBe(false);
});
