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
  | { kind: 'narration'; id: string; text: string }
  | { kind: 'tool'; id: string; tool: TranscriptTool };

export type TranscriptRow =
  | { kind: 'message'; id: string; message: ConversationMessage }
  | { kind: 'assistant'; id: string; operationId: string; text: string; streaming: boolean; /** When the row's message was recorded; live rows have no stamp yet. */ createdAt?: number; /** How long the whole turn took, from its earliest record to this answer. */ elapsedMs?: number | null; /** Interim narration of a turn, not the final answer. */ narration?: boolean }
  | { kind: 'narration'; id: string; operationId: string; text: string }
  | { kind: 'activity'; id: string; operationId: string; items: TranscriptActivityItem[]; /** The turn's activity as ordinary rows: narration bubbles with the tool calls interleaved. */ rows: TranscriptRow[]; collapsed: boolean }
  | { kind: 'tools'; id: string; tools: TranscriptTool[]; active: boolean }
  | { kind: 'rsi'; id: string; rsi: TranscriptRsi }
  | { kind: 'thinking'; id: 'thinking' };

export type TranscriptModelInput = {
  messages: ConversationMessage[];
  liveTools: LiveTool[];
  streaming: LiveText[];
  busy: boolean;
};

function toolName(message: ConversationMessage) {
  const value = message.data?.toolName;
  return typeof value === 'string' && value ? value : 'tool';
}

function toolError(message: ConversationMessage) {
  return message.data?.isError === true || /失败|error/i.test(message.text);
}

function durableTool(message: ConversationMessage): TranscriptTool {
  return {
    id: typeof message.data?.toolCallId === 'string' ? message.data.toolCallId : message.id,
    operationId: message.operationId ?? 'history',
    name: toolName(message),
    summary: message.text,
    done: message.state !== 'pending',
    error: toolError(message),
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

/** Narration is its own record in the conversation ledger; anything else in the
 * activity stream is a tool call. */
function activityItem(message: ConversationMessage): TranscriptActivityItem {
  if (message.kind === 'activity') return { kind: 'narration', id: message.id, text: message.text };
  const tool = durableTool(message);
  return { kind: 'tool', id: tool.id, tool };
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
    if (item.kind === 'narration') {
      flush();
      rows.push({ kind: 'narration', id: `narration:${item.id}`, operationId, text: item.text });
      continue;
    }
    tools.push(item.tool);
  }
  flush();
  return rows;
}

/**
 * Turn the stream projection into stable visual rows. A turn keeps its own
 * order: narration and tool calls are interleaved by the ordinal the server
 * assigned, and a turn that already produced its final answer collapses into one
 * activity block so the answer stays the visible outcome. The live tail is
 * appended after durable history so the same row survives the handoff.
 */
/**
 * When the turn behind one answer began, as the transcript can see it: the later
 * of the user message that asked for it and the previous answer, so a turn nobody
 * asked for (a reload continuation) still measures itself. Only when neither is
 * visible does it fall back to the earliest record of the same operation.
 */
function turnStart(messages: ConversationMessage[], message: ConversationMessage): number | null {
  let start: number | null = null;
  for (const item of messages) {
    if (item.seq >= message.seq) continue;
    if (item.role === 'user' || (item.role === 'assistant' && item.kind === 'chat')) {
      if (start === null || item.createdAt > start) start = item.createdAt;
    }
  }
  if (start !== null) return start;
  if (!message.operationId) return null;
  const sameOperation = messages.filter(item => item.operationId === message.operationId);
  if (sameOperation.length < 2) return null;
  return sameOperation.reduce((earliest, item) => Math.min(earliest, item.createdAt), message.createdAt);
}

/**
 * How long the turn behind one answer took. Null when there is nothing to measure
 * against, so a turn with no visible start shows no duration instead of a fake
 * zero. A receipt written while the turn is still running is the first record of
 * its own operation, which is why the start comes from the turn boundary.
 */
function turnElapsedMs(messages: ConversationMessage[], message: ConversationMessage): number | null {
  const start = turnStart(messages, message);
  if (start === null) return null;
  const elapsed = message.createdAt - start;
  return elapsed > 0 ? elapsed : null;
}

export function buildTranscriptRows(input: TranscriptModelInput): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const answered = new Set(input.messages
    .filter(message => message.role === 'assistant' && message.kind === 'chat' && message.operationId)
    .map(message => message.operationId as string));

  // Durable activity is buffered per turn, so a finished turn becomes one
  // collapsible block and a running one keeps its individual rows.
  let activityKey: string | null = null;
  let activityItems: TranscriptActivityItem[] = [];
  const activityToolIndex = new Map<string, number>();

  const flushActivity = () => {
    if (activityKey === null) return;
    const key = activityKey;
    const items = activityItems;
    activityKey = null;
    activityItems = [];
    activityToolIndex.clear();
    if (!items.length) return;
    if (key && answered.has(key)) {
      // The turn is over: its thinking and tool calls fold away behind one muted
      // line above the answer, and opening that line brings back the very rows the
      // turn showed while it was running.
      rows.push({ kind: 'activity', id: `activity:${key}`, operationId: key, items, rows: activityRows(key, items), collapsed: true });
      return;
    }
    // A running turn is not wrapped: its narration bubbles and tool groups sit
    // directly in the transcript.
    rows.push(...activityRows(key, items));
  };

  for (const message of input.messages) {
    if (isActivityMessage(message)) {
      const key = message.operationId ?? '';
      if (activityKey !== null && activityKey !== key) flushActivity();
      activityKey = key;
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
        elapsedMs: turnElapsedMs(input.messages, message),
      });
      continue;
    }
    if (message.role === 'system' && message.kind === 'rsi') {
      rows.push({ kind: 'rsi', id: `rsi:${message.id}`, rsi: durableRsi(message) });
      continue;
    }
    rows.push({ kind: 'message', id: message.id, message });
  }
  flushActivity();

  // The live tail is ordered by the same ordinal, so a text part emitted before
  // a tool call stays above it while the turn is still running.
  const tail: { ordinal: number; tool?: TranscriptTool; stream?: LiveText }[] = [
    ...input.liveTools.map(tool => ({ ordinal: tool.ordinal, tool: liveTool(tool) })),
    ...input.streaming.map(stream => ({ ordinal: stream.ordinal, stream })),
  ].sort((left, right) => left.ordinal - right.ordinal);
  let liveTools: TranscriptTool[] = [];
  const flushLiveTools = () => {
    pushToolGroup(rows, liveTools);
    liveTools = [];
  };
  // A narration becomes a chat bubble as soon as it stops being the newest thing
  // in the turn, so a finished segment never waits for its tool call to end.
  for (const [index, item] of tail.entries()) {
    if (item.stream) {
      flushLiveTools();
      rows.push({
        kind: 'assistant',
        id: `assistant:${item.stream.entryId}:${item.stream.partId}`,
        operationId: item.stream.operationId,
        text: item.stream.text,
        narration: true,
        streaming: index === tail.length - 1,
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
    failed: 0,
  };
  for (const tool of input) {
    if (tool.name === 'read' || tool.name === 'list_dir') counts.read += 1;
    else if (tool.name === 'run_command') counts.run += 1;
    else if (['write_file', 'apply_patch', 'edit'].includes(tool.name)) counts.edit += 1;
    else if (['search', 'glob'].includes(tool.name)) counts.search += 1;
    else if (['fetch', 'web_search'].includes(tool.name)) counts.browse += 1;
    else counts.other += 1;
    if (tool.error) counts.failed += 1;
  }
  const parts: string[] = [];
  if (counts.read) parts.push(`读取 ${counts.read} 项`);
  if (counts.run) parts.push(`运行 ${counts.run} 条命令`);
  if (counts.edit) parts.push(`编辑 ${counts.edit} 个文件`);
  if (counts.search) parts.push(`搜索 ${counts.search} 次`);
  if (counts.browse) parts.push(`访问 ${counts.browse} 个页面`);
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
  const action = toolActionLabel(active.name);
  return `正在${action}${active.summary ? ` ${active.summary}` : ''}`;
}
