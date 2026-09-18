import { expect, test } from 'vitest';
import type { ConversationMessage, LiveTool } from '../../src/core/conversation-projection.ts';
import {
  activeToolStatus,
  buildTranscriptRows,
  toolGroupSummary,
} from '../../src/web/transcript-model.ts';

function message(input: {
  id: string;
  seq: number;
  role: string;
  text?: string;
  operationId?: string | null;
  data?: Record<string, unknown> | null;
}): ConversationMessage {
  return {
    id: input.id,
    seq: input.seq,
    role: input.role,
    kind: 'chat',
    text: input.text ?? input.id,
    data: input.data ?? null,
    state: 'done',
    operationId: input.operationId ?? null,
    turn: 1,
    createdAt: input.seq,
    updatedAt: input.seq,
  };
}

test('consecutive durable tools become one collapsed group before the answer', () => {
  const rows = buildTranscriptRows({
    messages: [
      message({ id: 'user', seq: 1, role: 'user', text: '检查项目' }),
      message({ id: 'read', seq: 2, role: 'tool', text: 'README.md', data: { toolCallId: 'read-1', toolName: 'read' } }),
      message({ id: 'run', seq: 3, role: 'tool', text: 'npm test', data: { toolCallId: 'run-1', toolName: 'run_command' } }),
      message({ id: 'answer', seq: 4, role: 'assistant', text: '检查完成', operationId: 'op-1' }),
    ],
    liveTools: [],
    streaming: [],
    busy: false,
  });

  expect(rows.map(row => row.kind)).toEqual(['message', 'tools', 'message']);
  const tools = rows[1];
  expect(tools?.kind).toBe('tools');
  if (tools?.kind !== 'tools') throw new Error('expected tool group');
  expect(tools.active).toBe(false);
  expect(toolGroupSummary(tools.tools)).toBe('读取 1 项 · 运行 1 条命令');
});

test('live activity stays open and is followed by streamed markdown text', () => {
  const live: LiveTool = {
    toolCallId: 'live-read',
    operationId: 'op-live',
    name: 'read',
    summary: 'src/web/Conversation.tsx',
    done: false,
    error: false,
  };
  const rows = buildTranscriptRows({
    messages: [],
    liveTools: [live],
    streaming: [['op-live', '## 进度\n\n正在整理结果']],
    busy: true,
  });

  expect(rows.map(row => row.kind)).toEqual(['tools', 'streaming']);
  expect(rows[0]?.kind).toBe('tools');
  if (rows[0]?.kind !== 'tools') throw new Error('expected tool group');
  expect(rows[0].active).toBe(true);
  expect(activeToolStatus(rows[0].tools)).toContain('读取 src/web/Conversation.tsx');
  expect(rows[1]).toMatchObject({ kind: 'streaming', text: '## 进度\n\n正在整理结果' });
});

test('duplicate tool start and end records keep one stable row and preserve failure state', () => {
  const rows = buildTranscriptRows({
    messages: [
      message({
        id: 'tool-start',
        seq: 1,
        role: 'tool',
        text: 'npm test',
        data: { toolCallId: 'same-tool', toolName: 'run_command' },
      }),
      message({
        id: 'tool-end',
        seq: 2,
        role: 'tool',
        text: '工具执行失败',
        data: { toolCallId: 'same-tool', toolName: 'run_command', isError: true },
      }),
    ],
    liveTools: [],
    streaming: [],
    busy: false,
  });

  expect(rows).toHaveLength(1);
  expect(rows[0]?.kind).toBe('tools');
  if (rows[0]?.kind !== 'tools') throw new Error('expected tool group');
  expect(rows[0].tools).toHaveLength(1);
  expect(rows[0].tools[0]).toMatchObject({ id: 'same-tool', error: true, done: true });
});
