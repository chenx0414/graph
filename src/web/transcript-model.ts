import { toolActivity } from './tool-activity.ts';
import { assistantVisibleText } from '../core/assistant-visible-text.ts';
import { withoutUnexecutedToolCall } from '../runtime/unexecuted-tool-call.ts';
import { messageAttachments } from '../core/conversation-projection.ts';
import type {
  ConversationMessage,
  LiveText,
  LiveTool,
} from '../core/conversation-projection.ts';

export type TranscriptTool = {
  id: string;
  operationId: string;
  name: string;
  summary: string;
  done: boolean;
  error: boolean;
  attachments?: ReturnType<typeof messageAttachments>;
};

export type TranscriptRsi = {
  id: string;
  status: 'applied' | 'checks_failed' | 'rolled_back' | 'unavailable';
  title: string;
  problem: string;
  branch: string | null;
  commit: string | null;
  files: string[];
  validation: { command: string; status: string }[];
  restartRequired: boolean;
  activation: 'saved' | 'pending_reload' | 'active' | null;
  force: boolean;
  pendingFiles: string[];
  error?: string;
  diff?: string;
  report: string;
};

/** One ordered step of a finished turn: the narration the Agent wrote between
 * tool calls, or a tool call itself. */
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
  | { kind: 'tools'; id: string; tools: TranscriptTool[]; active: boolean }
  | { kind: 'rsi'; id: string; rsi: TranscriptRsi }
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
  return {
    id: typeof message.data?.toolCallId === 'string' ? message.data.toolCallId : message.id,
    operationId: message.operationId ?? 'history',
    name: toolName(message),
    summary: message.text,
    done: message.state !== 'pending',
    error: toolError(message),
    attachments: messageAttachments(message),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function durableRsi(message: ConversationMessage): TranscriptRsi {
  const data = (message.data ?? {}) as Record<string, unknown>;
  const status = data.status === 'applied' || data.status === 'checks_failed'
    || data.status === 'rolled_back' || data.status === 'unavailable'
    ? data.status
    : 'unavailable';
  const validation = Array.isArray(data.validation)
    ? (data.validation as unknown[]).flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        return typeof record.command === 'string' && typeof record.status === 'string'
          ? [{ command: record.command, status: record.status }]
          : [];
      })
    : [];
  return {
    id: message.id,
    status,
    title: typeof data.title === 'string' && data.title ? data.title : '自我改进',
    problem: typeof data.problem === 'string' ? data.problem : '',
    branch: typeof data.branch === 'string' ? data.branch : null,
    commit: typeof data.commit === 'string' ? data.commit : null,
    files: stringArray(data.files),
    validation,
    restartRequired: data.restartRequired === true,
    activation: data.activation && typeof data.activation === 'object' && !Array.isArray(data.activation)
      && ['saved', 'pending_reload', 'active'].includes(String((data.activation as Record<string, unknown>).state))
      ? (data.activation as Record<string, unknown>).state as 'saved' | 'pending_reload' | 'active'
      : status === 'applied' ? (data.restartRequired === true ? 'pending_reload' : 'saved') : null,
    force: data.force === true,
    pendingFiles: stringArray(data.pendingFiles),
    ...(typeof data.error === 'string' ? { error: data.error } : {}),
    ...(typeof data.diff === 'string' ? { diff: data.diff } : {}),
    report: message.text,
  };
}

function liveTool(tool: LiveTool): TranscriptTool {
  return {
    id: tool.toolCallId,
    operationId: tool.operationId,
    name: tool.name,
    summary: tool.summary,
    done: tool.done,
    error: tool.error,
  };
}

function mergeTool(previous: TranscriptTool | undefined, incoming: TranscriptTool) {
  if (!previous) return incoming;
  const genericResult = /^(工具执行完成|工具执行失败)$/.test(incoming.summary);
  return {
    ...previous,
    ...incoming,
    summary: genericResult && previous.summary ? previous.summary : incoming.summary,
    done: previous.done || incoming.done,
    error: previous.error || incoming.error,
  };
}

function pushToolGroup(rows: TranscriptRow[], tools: TranscriptTool[]) {
  if (!tools.length) return;
  rows.push({
    kind: 'tools',
    id: `tools:${tools[0]!.id}`,
    tools,
    active: tools.some(tool => !tool.done),
  });
}

function isActivityMessage(message: ConversationMessage) {
  return message.role === 'tool' || message.role === 'activity';
}

/** The ordinal the server assigned to a text part, a tool call, or a steering
 * message: the shared order of one turn. */
function messageOrdinal(message: ConversationMessage): number | undefined {
  const value = message.data?.ordinal;
  return typeof value === 'number' ? value : undefined;
}

/** A steering message joined a turn that was already running. It carries the
 * ordinal of the place it interrupted, so it stays there instead of at the top. */
function isSteeredMessage(message: ConversationMessage) {
  return message.role === 'user' && Boolean(message.operationId) && messageOrdinal(message) !== undefined;
}

/** A turn's own order is the ordinal the server assigned; records without one
 * keep the order they were written in. */
function sortByOrdinal(items: TranscriptActivityItem[]) {
  if (items.length < 2 || items.some(item => item.ordinal === undefined)) return items;
  return [...items].sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0));
}

/** Narration is its own record in the conversation ledger; anything else in the
 * activity stream is a tool call. */
function activityItem(message: ConversationMessage): TranscriptActivityItem {
  const ordinal = messageOrdinal(message);
  if (message.kind === 'activity') return { kind: 'narration', id: message.id, text: message.text, ...(ordinal !== undefined ? { ordinal } : {}) };
  const tool = durableTool(message);
  return { kind: 'tool', id: tool.id, tool, ...(ordinal !== undefined ? { ordinal } : {}) };
}

/** The rows of one turn's activity in the order it happened: a narration bubble,
 * then the tool calls that followed it, and so on. A contiguous run of tool calls
 * is one group, exactly as it renders while the turn is still running. */
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
      // The user's own message stays a visible bubble even when the work around
      // it folds away.
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
  // A reload is a transport boundary within the same user request.
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
  // History is paged. A page may contain activity from an older operation but
  // omit its answer; a later operation proves the older one has ended.
  const operationOrder = [...new Set(input.messages.map(message => message.operationId).filter((id): id is string => Boolean(id)))];
  const currentOperation = operationOrder.at(-1);
  for (const operationId of operationOrder) {
    if (operationId !== currentOperation) answered.add(operationId);
  }

  // Durable activity is buffered per turn, so a finished turn becomes one
  // collapsible block and a running one keeps its individual rows.
  let activityKey: string | null = null;
  let activityItems: TranscriptActivityItem[] = [];
  const activityToolIndex = new Map<string, number>();

  const emitActivity = (key: string, items: TranscriptActivityItem[]) => {
    if (!items.length) return;
    const ordered = sortByOrdinal(items);
    if (key && answered.has(key)) {
      // Keep steering messages visible in place, but fold every stretch of
      // activity around them once the operation is complete.
      let folded: TranscriptActivityItem[] = [];
      const flushFolded = () => {
        if (!folded.length) return;
        rows.push({ kind: 'activity', id: `activity:${key}:${folded[0]!.id}`, operationId: key, items: folded, rows: activityRows(key, folded), collapsed: true });
        folded = [];
      };
      for (const item of ordered) {
        if (item.kind === 'steer') {
          flushFolded();
          rows.push({ kind: 'message', id: item.message.id, message: item.message });
        } else folded.push(item);
      }
      flushFolded();
      return;
    }
    // A running turn is not wrapped: its narration bubbles and tool groups sit
    // directly in the transcript.
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
        // A tool call and its result are two records of the same call.
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
    rows.push({ kind: 'message', id: message.id, message });
  }
  // A running turn keeps its rows in the buffer until the live tail is known, so
  // the durable rows and the live ones can share one order.
  const pendingKey = activityKey;
  const pendingItems = activityKey === null ? [] : sortByOrdinal(activityItems);
  activityKey = null;
  activityItems = [];
  activityToolIndex.clear();

  // The live tail is ordered by the same ordinal, so a text part emitted before
  // a tool call stays above it while the turn is still running.
  const tail: { ordinal: number; item?: TranscriptActivityItem; tool?: TranscriptTool; stream?: LiveText }[] = [
    ...input.liveTools.map(tool => ({ ordinal: tool.ordinal, tool: liveTool(tool) })),
    ...input.streaming.map(stream => ({ ordinal: stream.ordinal, stream })),
  ].sort((left, right) => left.ordinal - right.ordinal);
  // A turn that is still running shows its durable rows and the live tail in one
  // order, so a steering message stays where it interrupted instead of above the
  // output it interrupted. Without ordinals the old order is kept.
  const merged: { ordinal: number; item?: TranscriptActivityItem; tool?: TranscriptTool; stream?: LiveText }[] = tail.length && pendingItems.length && pendingItems.every(item => item.ordinal !== undefined)
    ? [...pendingItems.map(item => ({ ordinal: item.ordinal ?? 0, item })), ...tail].sort((left, right) => left.ordinal - right.ordinal)
    : tail;
  if (!tail.length || merged === tail) emitActivity(pendingKey ?? '', pendingItems);
  let liveTools: TranscriptTool[] = [];
  const flushLiveTools = () => {
    pushToolGroup(rows, liveTools);
    liveTools = [];
  };
  // A narration becomes a chat bubble as soon as it stops being the newest thing
  // in the turn, so a finished segment never waits for its tool call to end.
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
        // Live narration renders through the same copyable row as a final answer,
        // so it carries a stamp too; with no recorded message yet, the segment's
        // own last update is the honest time to show.
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

export function toolGroupSummary(input: TranscriptTool[]) {
  const counts = {
    read: 0,
    run: 0,
    edit: 0,
    search: 0,
    browse: 0,
    other: 0,
    skill: 0,
    mcp: 0,
    failed: 0,
  };
  for (const tool of input) {
    const kind = toolActivity(tool.name, tool.summary).kind;
    if (kind === 'read' || kind === 'list') counts.read += 1;
    else if (kind === 'run') counts.run += 1;
    else if (kind === 'search') counts.search += 1;
    else if (kind === 'edit') counts.edit += 1;
    else if (kind === 'browse') counts.browse += 1;
    else if (kind === 'skill') counts.skill += 1;
    else if (kind === 'mcp') counts.mcp += 1;
    else counts.other += 1;
    if (tool.error) counts.failed += 1;
  }
  const parts: string[] = [];
  if (counts.read) parts.push(`读取 ${counts.read} 项`);
  if (counts.run) parts.push(`运行 ${counts.run} 条命令`);
  if (counts.edit) parts.push(`编辑 ${counts.edit} 个文件`);
  if (counts.search) parts.push(`搜索 ${counts.search} 次`);
  if (counts.browse) parts.push(`访问 ${counts.browse} 个页面`);
  if (counts.skill) parts.push(`读取 ${counts.skill} 个 Skill`);
  if (counts.mcp) parts.push(`MCP 调用 ${counts.mcp} 次`);
  if (counts.other) parts.push(`调用 ${counts.other} 个工具`);
  if (counts.failed) parts.push(`${counts.failed} 项失败`);
  return parts.join(' · ') || `${input.length} 个工具`;
}

export function toolActionLabel(name: string) {
  if (name === 'read' || name === 'list_dir') return '读取';
  if (name === 'run_command') return '运行';
  if (['write_file', 'apply_patch', 'edit'].includes(name)) return '编辑';
  if (['search', 'glob'].includes(name)) return '搜索';
  if (['fetch', 'web_search'].includes(name)) return '访问';
  return '调用';
}

export function activeToolStatus(tools: TranscriptTool[]) {
  const active = [...tools].reverse().find(tool => !tool.done);
  if (!active) return '正在整理结果';
  const action = toolActivity(active.name, active.summary).label;
  return `正在${action}${active.summary ? ` ${active.summary}` : ''}`;
}
