import { expect, test } from 'vitest';
import { nodeMessages, type Entry } from '../../src/web/node-transcript.ts';
import { buildTranscriptRows } from '../../src/web/transcript-model.ts';
const entry = (seq: number, role: string, kind: string, text: string): Entry => ({ seq, id: String(seq), role, kind, text, data: null, operationId: 'operation', createdAt: seq });
test('a settled node keeps its intermediate narration and tools in place while its final answer stays visible', () => {
  const entries = [entry(1, 'assistant', 'message', '先检查'), { ...entry(2, 'tool', 'call', 'read file'), data: { toolCallId: 'call', toolName: 'read' } },
    { ...entry(3, 'tool', 'result', '工具执行完成'), data: { toolCallId: 'call', toolName: 'read' } }, entry(4, 'assistant', 'message', '完成')];
  const input = { messages: nodeMessages(entries, [{ id: 'operation', state: 'completed' }], false), liveTools: [], streaming: [], busy: false };
  const rows = buildTranscriptRows(input);
  expect(rows.map(row => row.kind)).toEqual(['activity', 'assistant']);
  expect(rows[0]).toMatchObject({ collapsed: false, items: [{ kind: 'narration' }, { kind: 'tool', tool: { done: true } }] });
  expect(rows[1]).toMatchObject({ text: '完成' });
  const running = buildTranscriptRows({ ...input, messages: nodeMessages(entries, [{ id: 'operation', state: 'dispatched', workerActive: true }], true), busy: true });
  expect(running.some(row => row.kind === 'activity' && row.collapsed)).toBe(false);
});

test('a peer Agent message reads as an incoming prompt attributed to its sender, not as this node speaking', () => {
  const peer: Entry = { seq: 9, id: 'peer', role: 'assistant', kind: 'chat', text: '先处理空值', data: { peer: true, from: 'sibling' }, operationId: 'operation', createdAt: 9 };
  const [message] = nodeMessages([peer], [{ id: 'operation', state: 'completed' }], false);
  // It is an incoming message (role user), so the target chat shows it like a prompt...
  expect(message).toMatchObject({ role: 'user', kind: 'chat', text: '先处理空值' });
  // ...and it stays marked with the sender so the UI can say who sent it.
  expect(message!.data).toMatchObject({ peer: true, from: 'sibling' });
  // A normal assistant row is untouched by this path.
  const [plain] = nodeMessages([entry(1, 'assistant', 'message', '完成')], [{ id: 'operation', state: 'completed' }], false);
  expect(plain!.role).toBe('assistant');
});
