import { expect, test } from 'vitest';
import type { ConversationMessage, LiveTool } from '../../src/core/conversation-projection.ts';
import {
  activeToolStatus,
  buildTranscriptRows,
  toolGroupSummary,
} from '../../src/web/transcript-model.ts';

test('an rsi system message becomes a self-improvement report row', () => {
  const rows = buildTranscriptRows({
    messages: [{
      ...message({ id: 'rsi', seq: 1, role: 'system', text: '### RSI 已应用：修复超时' }),
      kind: 'rsi',
      data: {
        id: 'rsi-1',
        status: 'applied',
        title: '修复超时',
        problem: '命令在含空格路径下失败',
        branch: 'rsi/fix-timeout',
        commit: 'a'.repeat(40),
        files: ['src/runtime/rsi.ts'],
        validation: [{ command: 'node --run check', status: 'passed', output: '' }],
        restartRequired: true,
        diff: 'diff --git a/x b/x',
        report: '### RSI 已应用：修复超时',
      },
    }],
    liveTools: [],
    streaming: [],
    busy: false,
  });
  expect(rows.map(row => row.kind)).toEqual(['rsi']);
  const row = rows[0];
  if (row?.kind !== 'rsi') throw new Error('expected rsi row');
  expect(row.rsi.status).toBe('applied');
  expect(row.rsi.title).toBe('修复超时');
  expect(row.rsi.branch).toBe('rsi/fix-timeout');
  expect(row.rsi.files).toEqual(['src/runtime/rsi.ts']);
  expect(row.rsi.validation[0]).toMatchObject({ command: 'node --run check', status: 'passed' });
  expect(row.rsi.restartRequired).toBe(true);
});

test('an rsi report without receipt data still renders with a fallback title', () => {
  const rows = buildTranscriptRows({
    messages: [{ ...message({ id: 'rsi', seq: 1, role: 'system', text: 'plain report' }), kind: 'rsi' }],
    liveTools: [],
    streaming: [],
    busy: false,
  });
  const row = rows[0];
  if (row?.kind !== 'rsi') throw new Error('expected rsi row');
  expect(row.rsi.status).toBe('unavailable');
  expect(row.rsi.title).toBe('自我改进');
  expect(row.rsi.report).toBe('plain report');
});

test('a failed-check rsi report keeps its pending files', () => {
  const rows = buildTranscriptRows({
    messages: [{
      ...message({ id: 'rsi', seq: 1, role: 'system', text: '### RSI 检查未通过，改动已保留：修复超时' }),
      kind: 'rsi',
      data: {
        id: 'rsi-1',
        status: 'checks_failed',
        title: '修复超时',
        problem: '命令在含空格路径下失败',
        branch: 'rsi/fix-timeout',
        commit: null,
        files: [],
        pendingFiles: ['src/runtime/rsi.ts'],
        validation: [{ command: 'node --run check', status: 'failed', output: 'boom' }],
        restartRequired: false,
        report: '### RSI 检查未通过，改动已保留：修复超时',
      },
    }],
    liveTools: [],
    streaming: [],
    busy: false,
  });
  const row = rows[0];
  if (row?.kind !== 'rsi') throw new Error('expected rsi row');
  expect(row.rsi.status).toBe('checks_failed');
  expect(row.rsi.pendingFiles).toEqual(['src/runtime/rsi.ts']);
  expect(row.rsi.restartRequired).toBe(false);
});

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

  expect(rows.map(row => row.kind)).toEqual(['message', 'tools', 'assistant']);
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
    ordinal: 1,
  };
  const rows = buildTranscriptRows({
    messages: [],
    liveTools: [live],
    streaming: [{
      operationId: 'op-live',
      entryId: 'op-live',
      partId: 'text',
      ordinal: 2,
      text: '## 进度\n\n正在整理结果',
      length: 14,
      updatedAt: 1,
    }],
    busy: true,
  });

  expect(rows.map(row => row.kind)).toEqual(['tools', 'assistant']);
  expect(rows[0]?.kind).toBe('tools');
  if (rows[0]?.kind !== 'tools') throw new Error('expected tool group');
  expect(rows[0].active).toBe(true);
  expect(activeToolStatus(rows[0].tools)).toContain('读取 src/web/Conversation.tsx');
  expect(rows[1]).toMatchObject({ kind: 'assistant', streaming: true, text: '## 进度\n\n正在整理结果' });
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

test('live and durable assistant rows share the turn key the reveal is paced by', () => {
  const live = buildTranscriptRows({
    messages: [],
    liveTools: [],
    streaming: [{
      operationId: 'op-1',
      entryId: 'entry-1',
      partId: '0',
      ordinal: 1,
      text: '第一段\n\n第二段',
      length: 9,
      updatedAt: 1,
    }],
    busy: true,
  });
  const durable = buildTranscriptRows({
    messages: [message({ id: 'answer-1', seq: 2, role: 'assistant', text: '第一段\n\n第二段', operationId: 'op-1' })],
    liveTools: [],
    streaming: [],
    busy: false,
  });

  expect(live[0]).toMatchObject({ kind: 'assistant', id: 'assistant:op-1:entry-1:0', operationId: 'op-1', streaming: true });
  expect(durable[0]).toMatchObject({ kind: 'assistant', id: 'assistant:op-1', operationId: 'op-1', streaming: false });
});

test('a finished turn folds its thinking and tool calls above the answer', () => {
  const rows = buildTranscriptRows({
    messages: [
      message({ id: 'user', seq: 1, role: 'user', text: '看一下', operationId: 'op-1' }),
      message({ id: 'n1', seq: 2, role: 'activity', kind: 'activity', text: '先读代码', operationId: 'op-1' }),
      message({ id: 't1', seq: 3, role: 'tool', text: 'a.ts', data: { toolCallId: 'tool-1', toolName: 'read' }, operationId: 'op-1' }),
      message({ id: 'n2', seq: 4, role: 'activity', kind: 'activity', text: '现在改投影', operationId: 'op-1' }),
      message({ id: 't2', seq: 5, role: 'tool', text: 'b.ts', data: { toolCallId: 'tool-2', toolName: 'edit' }, operationId: 'op-1' }),
      message({ id: 'answer', seq: 6, role: 'assistant', kind: 'chat', text: '改好了', operationId: 'op-1' }),
    ],
    liveTools: [],
    streaming: [],
    busy: false,
  });

  // The turn folds away: the answer is what the reader sees, and opening the line
  // brings back the very rows the turn showed while it was running.
  expect(rows.map(row => row.kind)).toEqual(['message', 'activity', 'assistant']);
  const activity = rows[1];
  if (activity?.kind !== 'activity') throw new Error('expected a folded turn');
  expect(activity.collapsed).toBe(true);
  expect(activity.items.map(item => item.kind)).toEqual(['narration', 'tool', 'narration', 'tool']);
  expect(activity.rows.map(child => child.kind)).toEqual(['narration', 'tools', 'narration', 'tools']);
  expect(activity.rows[1]).toMatchObject({ kind: 'tools', active: false });
  expect(rows[2]).toMatchObject({ kind: 'assistant', text: '改好了' });
});

test('a narration becomes a bubble as soon as a tool call follows it', () => {
  const rows = buildTranscriptRows({
    messages: [],
    liveTools: [{ toolCallId: 'tool-1', operationId: 'op-1', name: 'read', summary: 'a.ts', done: false, error: false, ordinal: 2 }],
    streaming: [{ operationId: 'op-1', entryId: 'entry-1', partId: '0', ordinal: 1, text: '先看一下', length: 4, updatedAt: 1 }],
    busy: true,
  });

  // The tool call is the newest thing, so the narration above it is already a
  // finished bubble while that call is still running.
  expect(rows[0]).toMatchObject({ kind: 'assistant', narration: true, streaming: false });
  expect(rows[1]).toMatchObject({ kind: 'tools', active: true });
});

test('a turn without a final answer keeps narration and tools as their own rows', () => {
  const rows = buildTranscriptRows({
    messages: [
      message({ id: 'n1', seq: 1, role: 'activity', kind: 'activity', text: '先读代码', operationId: 'op-1' }),
      message({ id: 't1', seq: 2, role: 'tool', text: 'a.ts', data: { toolCallId: 'tool-1', toolName: 'read' }, operationId: 'op-1' }),
      message({ id: 't2', seq: 3, role: 'tool', text: 'b.ts', data: { toolCallId: 'tool-2', toolName: 'read' }, operationId: 'op-1' }),
      message({ id: 'n2', seq: 4, role: 'activity', kind: 'activity', text: '现在改投影', operationId: 'op-1' }),
    ],
    liveTools: [],
    streaming: [],
    busy: false,
  });

  expect(rows.map(row => row.kind)).toEqual(['narration', 'tools', 'narration']);
  expect(rows[1]).toMatchObject({ kind: 'tools', active: false });
});

test('the live tail interleaves a text part and a tool call by ordinal', () => {
  const rows = buildTranscriptRows({
    messages: [],
    liveTools: [{ toolCallId: 'tool-1', operationId: 'op-1', name: 'read', summary: 'a.ts', done: false, error: false, ordinal: 2 }],
    streaming: [
      { operationId: 'op-1', entryId: 'entry-1', partId: '0', ordinal: 1, text: '先看一下', length: 4, updatedAt: 1 },
      { operationId: 'op-1', entryId: 'entry-1', partId: '2', ordinal: 3, text: '再改投影', length: 4, updatedAt: 2 },
    ],
    busy: true,
  });

  expect(rows.map(row => row.kind)).toEqual(['assistant', 'tools', 'assistant']);
  // The part before the tool call is already a complete narration bubble; only
  // the newest part is still growing.
  expect(rows[0]).toMatchObject({ kind: 'assistant', text: '先看一下', narration: true, streaming: false });
  expect(rows[2]).toMatchObject({ kind: 'assistant', text: '再改投影', narration: true, streaming: true });
});

test('a steered user message stays where it interrupted the turn', () => {
  const rows = buildTranscriptRows({
    messages: [
      message({ id: 'u1', seq: 1, role: 'user', text: '先做这个', operationId: 'op-1' }),
      message({ id: 'n1', seq: 2, role: 'activity', kind: 'activity', text: '先读代码', operationId: 'op-1', data: { ordinal: 1 } }),
      message({ id: 't1', seq: 3, role: 'tool', kind: 'tool', text: 'read: a.ts', operationId: 'op-1', data: { ordinal: 2, tool: 'read' } }),
      message({ id: 'u2', seq: 4, role: 'user', text: '插队：改成 B', operationId: 'op-1', data: { ordinal: 3 } }),
      message({ id: 'n2', seq: 5, role: 'activity', kind: 'activity', text: '改成 B 了', operationId: 'op-1', data: { ordinal: 4 } }),
      message({ id: 'a1', seq: 6, role: 'assistant', text: '好了', operationId: 'op-1' }),
    ],
    liveTools: [],
    streaming: [],
    busy: false,
  });

  // Only the work before the interruption folds; the steered message itself stays
  // visible and keeps the place it interrupted.
  expect(rows.map(row => row.kind)).toEqual(['message', 'activity', 'message', 'narration', 'assistant']);
  const folded = rows[1];
  if (folded?.kind !== 'activity') throw new Error('expected the folded activity block');
  expect(folded.rows.map(child => child.kind)).toEqual(['narration', 'tools']);
  const steered = rows[2];
  if (steered?.kind !== 'message') throw new Error('expected the steered message row');
  expect(steered.message.text).toBe('插队：改成 B');
});

test('a steered message interleaves with the running turn by ordinal', () => {
  const rows = buildTranscriptRows({
    messages: [
      message({ id: 'u1', seq: 1, role: 'user', text: '先做这个', operationId: 'op-1' }),
      message({ id: 'n1', seq: 2, role: 'activity', kind: 'activity', text: '先读代码', operationId: 'op-1', data: { ordinal: 1 } }),
      message({ id: 'u2', seq: 3, role: 'user', text: '插队：改成 B', operationId: 'op-1', data: { ordinal: 3 } }),
    ],
    liveTools: [{ toolCallId: 'tool-1', operationId: 'op-1', name: 'read', summary: 'a.ts', done: false, error: false, ordinal: 2 }],
    streaming: [],
    busy: true,
  });

  expect(rows.map(row => row.kind)).toEqual(['message', 'assistant', 'tools', 'message']);
  const steered = rows[3];
  if (steered?.kind !== 'message') throw new Error('expected the steered message row');
  expect(steered.message.text).toBe('插队：改成 B');
});


test('reload continuation retains one activity group and one final answer', () => {
  const activity = (id: string, seq: number, op: string) => ({ ...message({ id, seq, role: 'activity', operationId: op, text: id }), kind: 'activity', data: { ordinal: 1 } });
  const rows = buildTranscriptRows({
    messages: [activity('before', 1, 'a'),
      { ...message({ id: 'rsi', seq: 2, role: 'system', operationId: 'a' }), kind: 'rsi', data: { status: 'applied', activation: { state: 'active' } } },
      { ...message({ id: 'receipt', seq: 3, role: 'assistant', operationId: 'a' }), data: { reloadReceipt: true } },
      activity('after', 4, 'b'), message({ id: 'answer', seq: 5, role: 'assistant', operationId: 'b', text: 'finished' })],
    continuations: [{ operationId: 'a', resumedOperationId: 'b' }], liveTools: [], streaming: [], busy: false,
  });
  expect(rows.map(row => row.kind)).toEqual(['activity', 'assistant']);
  expect(rows[0]).toMatchObject({ operationId: 'a', items: [{ id: 'before' }, { id: 'rsi:rsi' }, { id: 'after' }] });
  expect(rows[1]).toMatchObject({ text: 'finished' });
});

test('older activity without ordinals is retained alongside a new live tail', () => {
  const rows = buildTranscriptRows({ messages: [{ ...message({ id: 'old', seq: 1, role: 'activity', operationId: 'a', text: 'retained' }), kind: 'activity' }], liveTools: [], streaming: [{ operationId: 'b', entryId: 'e', partId: '0', text: 'new', ordinal: 1, length: 3, updatedAt: 2 }], busy: true });
  expect(rows).toContainEqual(expect.objectContaining({ text: 'retained' }));
});
