import { expect, test } from 'vitest';
import type { ConversationMessage } from '../../src/core/conversation-projection.ts';
import { copyText, writeClipboardText } from '../../src/web/chat-copy.ts';
import { buildTranscriptRows } from '../../src/web/transcript-model.ts';

function message(overrides: Partial<ConversationMessage> & { id: string; role: string; text: string }): ConversationMessage {
  return {
    seq: 1,
    kind: 'text',
    data: null,
    state: 'done',
    operationId: null,
    turn: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function rowsFrom(input: {
  messages?: ConversationMessage[];
  streaming?: { operationId: string; entryId: string; partId: string; text: string; length: number; updatedAt: number }[];
}) {
  return buildTranscriptRows({
    messages: input.messages ?? [],
    liveTools: [],
    streaming: input.streaming ?? [],
    busy: false,
  });
}

test('Agent 行的复制内容等于 transcript 行携带的 Markdown 源文本', () => {
  const source = '# 标题\n\n- **粗体** 与 `行内代码`\n\n| a | b |\n| - | - |';
  const rows = rowsFrom({
    messages: [message({ id: 'a1', role: 'assistant', operationId: 'op1', text: source })],
  });
  const assistant = rows.find(row => row.kind === 'assistant');
  expect(assistant).toBeDefined();
  expect(copyText(assistant!)).toBe(source);
});

test('用户行的复制内容等于原始输入文本', () => {
  const original = '第一行\n第二行 @src/web/TranscriptRows.tsx';
  const rows = rowsFrom({
    messages: [message({ id: 'u1', role: 'user', text: original })],
  });
  const user = rows.find(row => row.kind === 'message');
  expect(user).toBeDefined();
  expect(copyText(user!)).toBe(original);
});

test('streaming 中的 Agent 行不可复制', () => {
  const rows = rowsFrom({
    streaming: [{ operationId: 'op2', entryId: 'e1', partId: 'p1', text: '正在生成…', length: 5, updatedAt: 0 }],
  });
  const assistant = rows.find(row => row.kind === 'assistant');
  expect(assistant).toBeDefined();
  expect((assistant as { streaming: boolean }).streaming).toBe(true);
  expect(copyText(assistant!)).toBe('');
});

test('系统与工具行不可复制', () => {
  const rows = rowsFrom({
    messages: [
      message({ id: 's1', role: 'system', text: '系统提示' }),
      message({ id: 't1', role: 'tool', text: '工具输出' }),
    ],
  });
  const system = rows.find(row => row.kind === 'message' && row.message.role === 'system');
  const tools = rows.find(row => row.kind === 'tools');
  expect(system).toBeDefined();
  expect(tools).toBeDefined();
  expect(copyText(system!)).toBe('');
  expect(copyText(tools!)).toBe('');
});

test('写入剪贴板成功与失败都走提示回调', async () => {
  const calls: { message: string; tone: string }[] = [];
  const notify = (message: string, tone: string) => { calls.push({ message, tone }); };
  const written: string[] = [];

  const ok = await writeClipboardText('原文', { writeText: async (text: string) => { written.push(text); } }, notify);
  expect(ok).toBe(true);
  expect(written).toEqual(['原文']);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.tone).toBe('success');

  calls.length = 0;
  const failed = await writeClipboardText('原文', {
    writeText: async () => { throw new Error('拒绝访问'); },
  }, notify);
  expect(failed).toBe(false);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.tone).toBe('danger');
  expect(calls[0]!.message).toContain('拒绝访问');
});

test('空文本不写剪贴板也不提示', async () => {
  const calls: unknown[] = [];
  const ok = await writeClipboardText('', { writeText: async () => undefined }, (...args: unknown[]) => { calls.push(args); });
  expect(ok).toBe(false);
  expect(calls).toHaveLength(0);
});
