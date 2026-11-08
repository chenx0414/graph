// graph:allow-large-file: its 21 KB predate the budget; this change only re-points one import and the transcript model is a single projection
import { toolActivity } from './tool-activity.ts';
import { toolGroupSummary } from './tool-activity.ts';
import { assistantVisibleText } from '../core/assistant-visible-text.ts';
import { withoutUnexecutedToolCall } from './unexecuted-tool-call.ts';
import { messageAttachments, toolCallDisplay } from '../core/conversation-projection.ts';
import { durableRsi, type TranscriptRsi } from './transcript-rsi.ts';
import type {
  ConversationMessage,
  LiveText,
  LiveTool,
} from '../core/conversation-projection.ts';

export type { TranscriptRsi } from './transcript-rsi.ts';

export const transcriptFoldPolicy = {
  turnExpanded: false,
  toolGroupExpanded: false,
} as const;

export type TranscriptTool = {
  id: string;
  operationId: string;
  name: string;
  summary: string;
  done: boolean;
  error: boolean;
  state?: string; reason?: string;
  attachments?: ReturnType<typeof messageAttachments>;
};

export type TranscriptActivityItem =
  | { kind: 'rsi'; id: string; rsi: TranscriptRsi; ordinal?: number }
  | { kind: 'narration'; id: string; text: string; ordinal?: number }
  | { kind: 'tool'; id: string; tool: TranscriptTool; ordinal?: number }
  | { kind: 'steer'; id: string; message: ConversationMessage; ordinal?: number };

export type TranscriptRow =
  | { kind: 'message'; id: string; message: ConversationMessage }
  | { kind: 'assistant'; id: string; operationId: string; text: string; streaming: boolean; attached?: boolean; /** When the row's message was recorded; live rows have no stamp yet. */ createdAt?: number; /** How long the whole turn took, from its earliest record to this answer. */ elapsedMs?: number | null; /** Interim narration of a turn, not the final answer. */ narration?: boolean }
  | { kind: 'narration'; id: string; operationId: string; text: string }
  | { kind: 'activity'; id: string; operationId: string; items: TranscriptActivityItem[]; /** The turn's activity as ordinary rows: narration bubbles with the tool calls interleaved. */ rows: TranscriptRow[]; collapsed: boolean }
  | { kind: 'tools'; id: string; tools: TranscriptTool[]; active: boolean; summary: string }
  | { kind: 'rsi'; id: string; rsi: TranscriptRsi }
  | { kind: 'compaction'; id: string; text: string; tokensAfter?: number; summary?: string }
  | { kind: 'rsiFull'; id: string; text: string; verdict: string; verdictDetails: string[]; commit: string; environment: boolean; files: string[]; logPath: string }
  | { kind: 'thinking'; id: 'thinking' };

export type TranscriptModelInput = {
  messages: ConversationMessage[];
  continuations?: { operationId: string; resumedOperationId: string | null }[];
  liveTools: LiveTool[];
  streaming: LiveText[];
  busy: boolean;
};

function toolName(message: ConversationMessage) {
  const value = message.data?.toolName ?? message.data?.tool;
  return typeof value === 'string' && value ? value : 'tool';
}

function toolError(message: ConversationMessage) {
  return (message.data?.isError === true || message.data?.error === true) || /失败|error/i.test(message.text);
}

function durableTool(message: ConversationMessage): TranscriptTool {
  const display = toolCallDisplay({ messageState: message.state, data: message.data });
  const id = typeof message.data?.toolCallId === 'string' ? message.data.toolCallId : message.id;
  return { id, operationId: message.operationId ?? 'history', name: toolName(message), summary: message.text,
    ...display, error: display.error || toolError(message),
    attachments: messageAttachments(message) };
}

function liveTool(tool: LiveTool): TranscriptTool {
  const { toolCallId, operationId, name, summary, done, error, state, reason } = tool;
  return { id: toolCallId, operationId, name, summary, done, error,
    ...(state ? { state } : {}), ...(reason ? { reason } : {}) };
}

function mergeTool(previous: TranscriptTool | undefined, incoming: TranscriptTool): TranscriptTool {
  if (!previous) return incoming;
  const genericResult = /^(工具执行完成|工具执行失败)$/.test(incoming.summary);
  const done = previous.done || incoming.done;
  const state = incoming.state ?? previous.state;
  const reason = incoming.reason ?? previous.reason;
  return { ...previous, ...incoming, done,
    summary: genericResult && previous.summary ? previous.summary : incoming.summary,
    error: previous.error || incoming.error,
    ...(state ? { state } : {}), ...(reason ? { reason } : {}) };
}

function pushToolGroup(rows: TranscriptRow[], tools: TranscriptTool[]) {
  if (!tools.length) return;
  const active = tools.some(tool => !tool.done);
  rows.push({ kind: 'tools', id: `tools:${tools[0]!.id}`, tools, active,
    summary: active ? activeToolStatus(tools) : toolGroupSummary(tools) });
}

function isActivityMessage(message: ConversationMessage) {
  return message.role === 'tool' || message.role === 'activity';
}

function messageOrdinal(message: ConversationMessage): number | undefined {
  const value = message.data?.ordinal;
  return typeof value === 'number' ? value : undefined;
}

function isSteeredMessage(message: ConversationMessage) {
  return message.role === 'user' && Boolean(message.operationId) && messageOrdinal(message) !== undefined;
}

function sortByOrdinal(items: TranscriptActivityItem[]) {
  if (items.length < 2 || items.some(item => item.ordinal === undefined)) return items;
  return [...items].sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0));
}

function activityItem(message: ConversationMessage): TranscriptActivityItem {
  const ordinal = messageOrdinal(message);
  if (message.kind === 'activity') return { kind: 'narration', id: message.id, text: message.text, ...(ordinal !== undefined ? { ordinal } : {}) };
  const tool = durableTool(message);
  return { kind: 'tool', id: tool.id, tool, ...(ordinal !== undefined ? { ordinal } : {}) };
}

function activityRows(operationId: string, items: TranscriptActivityItem[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let tools: TranscriptTool[] = [];
  const flush = () => {
    pushToolGroup(rows, tools);
    tools = [];
  };
  for (const item of items) {
    if (item.kind === 'rsi') { flush(); rows.push({ kind: 'rsi', id: item.id, rsi: item.rsi }); continue; }
    if (item.kind === 'narration') {
      flush();
      rows.push({ kind: 'narration', id: `narration:${item.id}`, operationId, text: item.text });
      continue;
    }
    if (item.kind === 'steer') {
      flush();
      rows.push({ kind: 'message', id: item.message.id, message: item.message });
      continue;
    }
    tools.push(item.tool);
  }
  flush();
  return rows;
}

export function buildTranscriptRows(input: TranscriptModelInput): TranscriptRow[] {
  const parents = new Map((input.continuations ?? []).filter(item => item.resumedOperationId).map(item => [item.resumedOperationId!, item.operationId]));
  const roots = new Map<string, string>();
  const root = (id: string) => {
    if (roots.has(id)) return roots.get(id)!;
    const visited = new Set<string>();
    while (parents.has(id) && !visited.has(id)) { visited.add(id); id = parents.get(id)!; }
    for (const key of visited) roots.set(key, id);
    return id;
  };
  const maxima = new Map<string, number>();
  for (const item of [...input.messages.map(message => ({ operationId: message.operationId, ordinal: messageOrdinal(message) })), ...input.streaming, ...input.liveTools]) {
    if (item.operationId) maxima.set(item.operationId, Math.max(maxima.get(item.operationId) ?? 0, item.ordinal ?? 0));
  }
  const offsets = new Map<string, number>();
  const offset = (id: string): number => {
    if (offsets.has(id)) return offsets.get(id)!;
    offsets.set(id, 0);
    const parent = parents.get(id);
    const value = parent ? offset(parent) + (maxima.get(parent) ?? 0) + 1 : 0;
    offsets.set(id, value);
    return value;
  };
  const isReceipt = (message: ConversationMessage) => message.data?.reloadReceipt === true
    || (message.role === 'assistant' && message.text.startsWith('RSI 改动已提交，等待重载。') && message.text.includes('重载确认后会自动继续'));
  input = { ...input,
    messages: input.messages.filter(message => !isReceipt(message)).map(message => {
      const visible = message.role === 'assistant' || message.role === 'activity'
        ? { ...message, text: assistantVisibleText(withoutUnexecutedToolCall(message.text)) } : message;
      return visible.operationId ? { ...visible, operationId: root(visible.operationId), ...(messageOrdinal(visible) !== undefined ? { data: { ...visible.data, ordinal: messageOrdinal(visible)! + offset(visible.operationId) } } : {}) } : visible;
    }),
    streaming: input.streaming.map(item => ({ ...item, text: assistantVisibleText(withoutUnexecutedToolCall(item.text)), operationId: root(item.operationId), ordinal: item.ordinal + offset(item.operationId) })),
    liveTools: input.liveTools.map(item => ({ ...item, operationId: root(item.operationId), ordinal: item.ordinal + offset(item.operationId) })),
  };
  const rows: TranscriptRow[] = [];
  const elapsed = new Map<string, number | null>();
  const earliest = new Map<string, number>();
  let boundary: number | null = null;
  for (const message of input.messages) {
    const key = message.operationId ?? message.id;
    if (!earliest.has(key)) earliest.set(key, message.createdAt);
    if (message.role === 'assistant') {
      const start = boundary ?? earliest.get(key)!;
      elapsed.set(message.id, message.createdAt > start ? message.createdAt - start : null);
    }
    if (message.role === 'user' || (message.role === 'assistant' && message.kind === 'chat')) boundary = message.createdAt;
  }
  const answered = new Set(input.messages
    .filter(message => message.role === 'assistant' && message.kind === 'chat' && message.operationId)
    .map(message => message.operationId as string));
  const operationOrder = [...new Set(input.messages.map(message => message.operationId).filter((id): id is string => Boolean(id)))];
  const currentOperation = operationOrder.at(-1);
  for (const operationId of operationOrder) {
    if (operationId !== currentOperation) answered.add(operationId);
  }

  let activityKey: string | null = null;
  let activityItems: TranscriptActivityItem[] = [];
  const activityToolIndex = new Map<string, number>();

  const emitActivity = (key: string, items: TranscriptActivityItem[]) => {
    if (!items.length) return;
    const ordered = sortByOrdinal(items);
    if (key && answered.has(key)) {
      let folded: TranscriptActivityItem[] = [];
      let running: TranscriptActivityItem[] = [];
      const flushFolded = () => {
        if (!folded.length) return;
        rows.push({ kind: 'activity', id: `activity:${key}:${folded[0]!.id}`, operationId: key, items: folded, rows: activityRows(key, folded), collapsed: !transcriptFoldPolicy.turnExpanded });
        folded = [];
      };
      const flushRunning = () => {
        if (!running.length) return;
        rows.push(...activityRows(key, running));
        running = [];
      };
      for (const item of ordered) {
        if (item.kind === 'steer') {
          flushFolded();
          flushRunning();
          rows.push({ kind: 'message', id: item.message.id, message: item.message });
        }
        else if (item.kind === 'tool' && item.tool.reason) running.push(item);
        else folded.push(item);
      }
      flushFolded();
      flushRunning();
      return;
    }
    rows.push(...activityRows(key, ordered));
  };

  const flushActivity = () => {
    if (activityKey === null) return;
    const key = activityKey;
    const items = activityItems;
    activityKey = null;
    activityItems = [];
    activityToolIndex.clear();
    emitActivity(key, items);
  };

  for (const message of input.messages) {
    if (isActivityMessage(message) || isSteeredMessage(message) || (message.kind === 'rsi' && message.operationId)) {
      const key = message.operationId ?? '';
      if (activityKey !== null && activityKey !== key) flushActivity();
      activityKey = key;
      if (isSteeredMessage(message)) {
        const ordinal = messageOrdinal(message);
        activityItems.push({ kind: 'steer', id: message.id, message, ...(ordinal !== undefined ? { ordinal } : {}) });
        continue;
      }
      if (message.kind === 'rsi') { activityItems.push({ kind: 'rsi', id: `rsi:${message.id}`, rsi: durableRsi(message) }); continue; }
      const incoming = activityItem(message);
      if (incoming.kind === 'tool') {
        const index = activityToolIndex.get(incoming.id);
        if (index !== undefined) {
          const previous = activityItems[index]!;
          if (previous.kind === 'tool') activityItems[index] = { ...previous, tool: mergeTool(previous.tool, incoming.tool) };
          continue;
        }
        activityToolIndex.set(incoming.id, activityItems.length);
      }
      activityItems.push(incoming);
      continue;
    }
    flushActivity();
    if (message.role === 'assistant') {
      rows.push({
        kind: 'assistant',
        id: `assistant:${message.operationId ?? message.id}`,
        operationId: message.operationId ?? message.id,
        text: message.text,
        streaming: false,
        createdAt: message.createdAt,
        elapsedMs: elapsed.get(message.id) ?? null,
      });
      continue;
    }
    if (message.role === 'system' && message.kind === 'rsi') {
      rows.push({ kind: 'rsi', id: `rsi:${message.id}`, rsi: durableRsi(message) });
      continue;
    }
    if (message.role === 'system' && message.kind === 'compaction') {
      const data = message.data as { tokensAfter?: number; summary?: string } | null | undefined;
      rows.push({
        kind: 'compaction', id: `compaction:${message.id}`, text: message.text,
        ...(typeof data?.tokensAfter === 'number' ? { tokensAfter: data.tokensAfter } : {}),
        ...(typeof data?.summary === 'string' && data.summary.trim() ? { summary: data.summary } : {}),
      });
      continue;
    }
    if (message.role === 'user' && rsiFullSource(message)) {
      rows.push(rsiFullRow(message));
      continue;
    }
    rows.push({ kind: 'message', id: message.id, message });
  }
  const pendingKey = activityKey;
  const pendingItems = activityKey === null ? [] : sortByOrdinal(activityItems);
  activityKey = null;
  activityItems = [];
  activityToolIndex.clear();

  const tail: { ordinal: number; item?: TranscriptActivityItem; tool?: TranscriptTool; stream?: LiveText }[] = [
    ...input.liveTools.map(tool => ({ ordinal: tool.ordinal, tool: liveTool(tool) })),
    ...input.streaming.map(stream => ({ ordinal: stream.ordinal, stream })),
  ].sort((left, right) => left.ordinal - right.ordinal);
  const merged: { ordinal: number; item?: TranscriptActivityItem; tool?: TranscriptTool; stream?: LiveText }[] = tail.length && pendingItems.length && pendingItems.every(item => item.ordinal !== undefined)
    ? [...pendingItems.map(item => ({ ordinal: item.ordinal ?? 0, item })), ...tail].sort((left, right) => left.ordinal - right.ordinal)
    : tail;
  if (!tail.length || merged === tail) emitActivity(pendingKey ?? '', pendingItems);
  let liveTools: TranscriptTool[] = [];
  const flushLiveTools = () => {
    pushToolGroup(rows, liveTools);
    liveTools = [];
  };
  for (const [index, item] of merged.entries()) {
    if (item.item) {
      if (item.item.kind === 'rsi') { flushLiveTools(); rows.push({ kind: 'rsi', id: item.item.id, rsi: item.item.rsi }); continue; }
      if (item.item.kind === 'narration') {
        flushLiveTools();
        rows.push({
          kind: 'assistant',
          id: `assistant:${item.item.id}`,
          operationId: pendingKey ?? '',
          text: item.item.text,
          narration: true,
          streaming: false,
        });
        continue;
      }
      if (item.item.kind === 'steer') {
        flushLiveTools();
        rows.push({ kind: 'message', id: item.item.message.id, message: item.item.message });
        continue;
      }
      liveTools.push(item.item.tool);
      continue;
    }
    if (item.stream) {
      flushLiveTools();
      rows.push({
        kind: 'assistant',
        id: `assistant:${item.stream.operationId}:${item.stream.entryId}:${item.stream.partId}`,
        operationId: item.stream.operationId,
        text: item.stream.text,
        attached: item.stream.attached ?? false,
        narration: true,
        streaming: index === merged.length - 1,
        createdAt: item.stream.updatedAt,
      });
      continue;
    }
    if (item.tool) liveTools.push(item.tool);
  }
  flushLiveTools();

  if (input.busy && !input.liveTools.length && !input.streaming.length) {
    rows.push({ kind: 'thinking', id: 'thinking' });
  }
  return rows;
}

export { toolGroupSummary } from './tool-activity.ts';

export function activeToolStatus(tools: TranscriptTool[]) {
  const active = [...tools].reverse().find(tool => !tool.done);
  if (!active) return '正在整理结果';
  const action = toolActivity(active.name, active.summary).label;
  return `正在${action}${active.summary ? ` ${active.summary}` : ''}`;
}

function rsiFullSource(message: ConversationMessage): boolean {
  const data = (message.data ?? {}) as { source?: { kind?: string } };
  return data.source?.kind === 'rsi_async_full';
}

function rsiFullRow(message: ConversationMessage): TranscriptRow {
  const lines = message.text.split('\n').map(line => line.trim()).filter(Boolean);
  const field = (label: string) => lines.find(line => line.startsWith(label))?.slice(label.length).trim() ?? '';
  const data = (message.data ?? {}) as { environment?: unknown };
  const clauses = field('判定:').split('；').map(clause => clause.trim()).filter(Boolean);
  return {
    kind: 'rsiFull',
    id: `rsiFull:${message.id}`,
    text: message.text,
    verdict: clauses[0] ?? '',
    verdictDetails: clauses.slice(1),
    commit: field('提交:'),
    environment: data.environment === true,
    files: [...new Set(lines
      .map(line => line.match(/([\w./@-]+\.test\.ts)/)?.[1] ?? '')
      .filter(Boolean))],
    logPath: field('完整日志:'),
  };
}
