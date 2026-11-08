export interface ConversationMessage {
  id: string;
  seq: number;
  role: string;
  kind: string;
  text: string;
  data: Record<string, unknown> | null;
  state: string;
  operationId: string | null;
  turn: number;
  createdAt: number;
  updatedAt: number;
}

export interface LiveTool extends ToolCallDisplay {
  toolCallId: string;
  operationId: string;
  name: string;
  summary: string;
  ordinal: number;
}

export interface LiveText {
  attached?: boolean;
  operationId: string;
  entryId: string;
  partId: string;
  text: string;
  length: number;
  updatedAt: number;
  ordinal: number;
}

const RUNNING_TOOL_STATES = new Set(['accepted', 'running']);
const TERMINAL_TOOL_STATES = new Set(['settled', 'failed', 'cancelled', 'timed_out', 'interrupted']);

export interface ToolCallDisplay {
  done: boolean;
  error: boolean;
  background?: boolean;
  deferred?: boolean;
  state?: string;
  reason?: string;
}

function recordedText(...values: unknown[]) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

export function toolCallDisplay(input: {
  messageState?: string | null;
  data?: Record<string, unknown> | null;
  ended?: boolean;
}): ToolCallDisplay {
  const data = input.data ?? {};
  const declared = typeof data.state === 'string' ? data.state
    : typeof data.deferredState === 'string' ? data.deferredState : '';
  const toolState = RUNNING_TOOL_STATES.has(declared) || TERMINAL_TOOL_STATES.has(declared) ? declared : '';
  const messageState = input.messageState ?? '';
  const reason = recordedText(data.message, data.reason);
  const messageEnded = messageState === 'done' || messageState === 'error' || messageState === 'failed';
  const error = toolState === 'cancelled' ? false
    : toolState === 'failed' || toolState === 'timed_out' || toolState === 'interrupted'
      || messageState === 'error' || messageState === 'failed' || data.error === true || data.isError === true;
  const deferredRunning = data.deferred === true || RUNNING_TOOL_STATES.has(toolState);
  const done = TERMINAL_TOOL_STATES.has(toolState) || messageEnded
    || (input.ended === true && !deferredRunning);
  return {
    done,
    error,
    background: !done && (messageState === 'running' || deferredRunning),
    ...(toolState || data.deferred === true ? { deferred: true } : {}),
    ...(toolState ? { state: toolState } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function streamKey(operationId: string, entryId: string, partId: string) {
  return `${operationId}\u0000${entryId}\u0000${partId}`;
}

function dropOperationStreams(liveText: Record<string, LiveText>, operationId: string) {
  return Object.fromEntries(Object.entries(liveText).filter(([, item]) => item.operationId !== operationId));
}

export interface ConversationProjectionState {
  eventCursor: number;
  snapshotCursor: number;
  records: Record<string, ConversationMessage>;
  liveText: Record<string, LiveText>;
  liveTools: Record<string, LiveTool>;
  streamNeedsResync: boolean;
  messageCount: number;
  windowStartSeq: number | null;
  windowEndSeq: number | null;
  forwardCursor: number | null;
  olderExhausted: boolean;
  historyExhausted: boolean;
}

export interface ConversationProjectionEvent {
  cursor?: number;
  type: string;
  data?: {
    operationId?: string;
    text?: string;
    entryId?: string;
    partId?: string;
    ordinal?: number;
    len?: number;
    reset?: boolean;
    message?: ConversationMessage;
    phase?: string;
    toolCallId?: string;
    toolName?: string;
    summary?: string;
    isError?: boolean;
  };
}

export interface ConversationHistoryRequest {
  direction: 'before' | 'after';
  cursor: number;
}

const TERMINAL_OPERATION_EVENTS = new Set([
  'operation.result',
  'operation.unknown',
  'operation.interrupted',
  'operation.not_sent',
  'operation.report_rejected',
  'operation.reconciled',
  'context.rejected',
]);

export interface ConversationProjectionSnapshot {
  messages: ConversationMessage[];
  queuedMessages: ConversationMessage[];
  streaming: LiveText[];
  liveTools: LiveTool[];
  streamNeedsResync: boolean;
  historyRequest: ConversationHistoryRequest | null;
}

function systemAuthored(message: ConversationMessage): boolean {
  const source = (message.data as { source?: { kind?: string } } | null)?.source;
  return source?.kind === 'tool_settled' || source?.kind === 'rsi_async_full';
}

function bySequence(left: ConversationMessage, right: ConversationMessage) {
  return left.seq - right.seq;
}

function ranOutsideTurn(message: ConversationMessage) {
  const declared = typeof message.data?.state === 'string' ? message.data.state
    : typeof message.data?.deferredState === 'string' ? message.data.deferredState : '';
  return message.role === 'tool'
    && (message.state === 'running' || message.data?.deferred === true
      || (typeof declared === 'string' && (RUNNING_TOOL_STATES.has(declared) || TERMINAL_TOOL_STATES.has(declared))));
}

function mergeRecords(
  current: Record<string, ConversationMessage>,
  incoming: ConversationMessage[],
) {
  let changed = false;
  const next = { ...current };
  for (const incomingMessage of incoming) {
    const message = next[incomingMessage.id] && ranOutsideTurn(next[incomingMessage.id]!)
      && incomingMessage.role === 'tool' && incomingMessage.data?.toolCallId === next[incomingMessage.id]!.data?.toolCallId
      && !ranOutsideTurn(incomingMessage)
      ? { ...incomingMessage, data: { ...(incomingMessage.data ?? {}), deferred: true } }
      : incomingMessage;
    const previous = next[message.id];
    if (previous && message.updatedAt < previous.updatedAt) continue;
    if (!previous
      || previous.text !== message.text
      || previous.state !== message.state
      || previous.data !== message.data
      || previous.updatedAt !== message.updatedAt) {
      next[message.id] = message;
      changed = true;
    }
  }
  return changed ? next : current;
}

function orderMessages(messages: ConversationMessage[]) {
  const ordered: ConversationMessage[] = [];
  for (let index = 0; index < messages.length;) {
    if (messages[index]!.role !== 'assistant') {
      ordered.push(messages[index]!);
      index += 1;
      continue;
    }
    const answers: ConversationMessage[] = [];
    const tools: ConversationMessage[] = [];
    while (index < messages.length && (messages[index]!.role === 'assistant' || messages[index]!.role === 'tool')) {
      if (messages[index]!.role === 'assistant') answers.push(messages[index]!);
      else tools.push(messages[index]!);
      index += 1;
    }
    ordered.push(...tools, ...answers);
  }
  return ordered;
}

export function createConversationProjection(): ConversationProjectionState {
  return {
    eventCursor: 0,
    snapshotCursor: 0,
    records: {},
    liveText: {},
    liveTools: {},
    streamNeedsResync: false,
    messageCount: 0,
    windowStartSeq: null,
    windowEndSeq: null,
    forwardCursor: null,
    olderExhausted: false,
    historyExhausted: false,
  };
}

export function observeConversationView(
  state: ConversationProjectionState,
  view: {
    eventCursor?: number;
    messages: ConversationMessage[];
    messageCount: number;
    streams?: { operationId: string; entryId: string; partId: string; ordinal: number; text: string; length: number; updatedAt: number }[];
  },
) {
  const records = mergeRecords(state.records, view.messages);
  const stale = view.eventCursor !== undefined && view.eventCursor < state.eventCursor;
  const sequences = view.messages.map(message => message.seq);
  const liveText: Record<string, LiveText> = stale || view.streams === undefined ? { ...state.liveText } : {};
  for (const stream of stale ? [] : view.streams ?? []) {
    const key = streamKey(stream.operationId, stream.entryId, stream.partId);
    const previous = state.liveText[key];
    if (view.eventCursor !== undefined || state.streamNeedsResync || !previous || stream.text.startsWith(previous.text) || stream.length > previous.length) {
      liveText[key] = { ...stream, attached: previous?.attached ?? !previous };
    } else if (previous) liveText[key] = previous;
  }
  return {
    ...state,
    records,
    liveText,
    eventCursor: state.eventCursor || (view.eventCursor ?? 0),
    snapshotCursor: Math.max(state.snapshotCursor, view.eventCursor ?? 0),
    streamNeedsResync: stale ? state.streamNeedsResync : false,
    messageCount: view.messageCount,
    windowStartSeq: sequences.length ? Math.min(...sequences) : state.windowStartSeq,
    windowEndSeq: sequences.length ? Math.max(...sequences) : state.windowEndSeq,
  };
}

export function applyConversationEvent(state: ConversationProjectionState, event: ConversationProjectionEvent) {
  if (event.cursor !== undefined && event.cursor <= state.eventCursor) return state;
  const coveredStream = event.type === 'message.delta' && event.cursor !== undefined && event.cursor <= state.snapshotCursor;
  const next = coveredStream ? state : reduceConversationEvent(state, event);
  return event.cursor === undefined ? next : { ...next, eventCursor: event.cursor };
}

function reduceConversationEvent(
  state: ConversationProjectionState,
  event: ConversationProjectionEvent,
) {
  const data = event.data;
  if (event.type === 'message.delta' && data?.text) {
    const operationId = data.operationId ?? 'stream';
    const entryId = data.entryId ?? 'entry';
    const partId = data.partId ?? 'text';
    const key = streamKey(operationId, entryId, partId);
    const previous = state.liveText[key];
    const length = data.len ?? (previous?.length ?? 0) + data.text.length;
    if (previous && data.len !== undefined && data.len <= previous.length
      && (data.reset !== true || (event.cursor === undefined && previous.text.startsWith(data.text)))) return state;
    if (!previous && data.reset !== true && data.len !== undefined && data.len !== data.text.length) return { ...state, streamNeedsResync: true };
    const reset = data.reset === true || !previous;
    const appendable = Boolean(previous && previous.length + data.text.length === length);
    if (!reset && !appendable && data.len !== undefined) {
      return { ...state, streamNeedsResync: true };
    }
    const ordinal = data.ordinal ?? previous?.ordinal ?? 0;
    return {
      ...state,
      liveText: {
        ...state.liveText,
        [key]: reset
          ? { operationId, entryId, partId, ordinal, text: data.text, length, updatedAt: Date.now() }
          : { ...previous!, ordinal, text: previous!.text + data.text, length, updatedAt: Date.now() },
      },
      streamNeedsResync: false,
    };
  }
  if (event.type === 'message.tool' && data?.toolCallId) {
    return {
      ...state,
      liveTools: {
        ...state.liveTools,
        [data.toolCallId]: {
          toolCallId: data.toolCallId,
          operationId: data.operationId ?? 'stream',
          name: data.toolName ?? 'tool',
          summary: data.summary ?? '',
          ordinal: data.ordinal ?? 0,
          ...toolCallDisplay({ data: data as Record<string, unknown>, ended: data.phase === 'end' }),
        },
      },
    };
  }
  if (TERMINAL_OPERATION_EVENTS.has(event.type) && data?.operationId) {
    const liveTools = Object.fromEntries(Object.entries(state.liveTools)
      .filter(([, tool]) => tool.operationId !== data.operationId || (tool.background && !tool.done)));
    return { ...state, liveText: dropOperationStreams(state.liveText, data.operationId), liveTools, streamNeedsResync: false };
  }
  const message = data?.message;
  if (!message || (event.type !== 'message.created' && event.type !== 'message.updated')) return state;
  const knownMax = Object.values(state.records).reduce((max, candidate) => Math.max(max, candidate.seq), 0);
  const records = event.type === 'message.updated' || message.seq > knownMax
    ? mergeRecords(state.records, [message])
    : state.records;
  const liveText = { ...state.liveText };
  if (message.role === 'assistant' && message.operationId) {
    for (const key of Object.keys(liveText)) {
      if (liveText[key]!.operationId === message.operationId) delete liveText[key];
    }
  }
  const liveTools = { ...state.liveTools };
  if (message.role === 'tool' && typeof message.data?.toolCallId === 'string') {
    delete liveTools[message.data.toolCallId];
  }
  return { ...state, records, liveText, liveTools, streamNeedsResync: false };
}

export function conversationHistoryRequest(state: ConversationProjectionState): ConversationHistoryRequest | null {
  if (state.historyExhausted || state.messageCount <= Object.keys(state.records).length) return null;
  const cached = Object.values(state.records).sort(bySequence);
  const earliest = cached[0]?.seq;
  if (!state.olderExhausted && earliest !== undefined && earliest > 1) {
    return { direction: 'before', cursor: earliest };
  }
  const belowWindow = state.windowStartSeq === null
    ? cached
    : cached.filter(message => message.seq < state.windowStartSeq!);
  const base = belowWindow.length ? belowWindow[belowWindow.length - 1]!.seq : (earliest ?? 0);
  const cursor = state.forwardCursor === null ? base : Math.max(state.forwardCursor, base);
  return { direction: 'after', cursor };
}

export function observeConversationHistory(
  state: ConversationProjectionState,
  page: { request: ConversationHistoryRequest; messages: ConversationMessage[] },
) {
  const records = mergeRecords(state.records, page.messages);
  if (page.request.direction === 'after') {
    if (!page.messages.length) return { ...state, records, historyExhausted: true };
    return {
      ...state,
      records,
      forwardCursor: page.messages[page.messages.length - 1]!.seq,
    };
  }
  return page.messages.length
    ? { ...state, records }
    : { ...state, records, olderExhausted: true };
}

export function conversationProjectionSnapshot(
  state: ConversationProjectionState,
  options: { busy: boolean },
): ConversationProjectionSnapshot {
  const all = Object.values(state.records).sort(bySequence);
  const queuedMessages = all.filter(message =>
    message.role === 'user' && message.state === 'queued' && !systemAuthored(message));
  const durableAssistantOps = new Set(
    all.filter(message => message.role === 'assistant' && message.operationId)
      .map(message => message.operationId!),
  );
  const durableToolIds = new Set(
    all.filter(message => message.role === 'tool' && typeof message.data?.toolCallId === 'string')
      .map(message => String(message.data!.toolCallId)),
  );
  const durableNarration = new Set(all.filter(message => message.role === 'activity' && typeof message.data?.ordinal === 'number')
    .map(message => `${message.operationId}:${message.data!.ordinal}`));
  const latestAssistant = [...all].reverse().find(message => message.role === 'assistant');
  return {
    messages: orderMessages(all.filter(message => !(message.role === 'user' && message.state === 'queued'))),
    queuedMessages,
    streaming: Object.values(state.liveText).filter(item => !durableAssistantOps.has(item.operationId) && !durableNarration.has(`${item.operationId}:${item.ordinal}`)),
    liveTools: Object.values(state.liveTools).filter(tool => !durableToolIds.has(tool.toolCallId)),
    streamNeedsResync: state.streamNeedsResync,
    historyRequest: conversationHistoryRequest(state),
  };
}

export function messageAttachments(message: ConversationMessage) {
  const value = message.data?.attachments;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const attachment = item as Record<string, unknown>;
    if (typeof attachment.name !== 'string' || typeof attachment.text !== 'string') return [];
    return [{
      name: attachment.name,
      type: typeof attachment.type === 'string' ? attachment.type : 'text/plain',
      size: typeof attachment.size === 'number' ? attachment.size : attachment.text.length,
      text: attachment.text,
      ...(typeof attachment.data === 'string' ? { data: attachment.data } : {}),
      ...(['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(attachment.type))
        ? { imageUrl: `/api/messages/${encodeURIComponent(message.id)}/attachments/${index}` } : {}),
    }];
  });
}
