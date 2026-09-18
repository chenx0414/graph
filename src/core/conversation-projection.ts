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

export interface LiveTool {
  toolCallId: string;
  operationId: string;
  name: string;
  summary: string;
  done: boolean;
  error: boolean;
}

export interface ConversationProjectionState {
  records: Record<string, ConversationMessage>;
  liveText: Record<string, string>;
  liveTools: Record<string, LiveTool>;
  messageCount: number;
  windowStartSeq: number | null;
  windowEndSeq: number | null;
  forwardCursor: number | null;
  olderExhausted: boolean;
  historyExhausted: boolean;
}

export interface ConversationProjectionEvent {
  type: string;
  data?: {
    operationId?: string;
    text?: string;
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
  'operation.interrupted',
  'operation.not_sent',
  'operation.report_rejected',
  'operation.reconciled',
  'context.rejected',
]);

export interface ConversationProjectionSnapshot {
  messages: ConversationMessage[];
  queuedMessages: ConversationMessage[];
  streaming: [string, string][];
  liveTools: LiveTool[];
  promptSuggestion: string;
  historyRequest: ConversationHistoryRequest | null;
}

function bySequence(left: ConversationMessage, right: ConversationMessage) {
  return left.seq - right.seq;
}

function mergeRecords(
  current: Record<string, ConversationMessage>,
  incoming: ConversationMessage[],
) {
  let changed = false;
  const next = { ...current };
  for (const message of incoming) {
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

/**
 * Tool activity belongs to the assistant turn, but the final answer should
 * close that turn. Move adjacent tool records ahead of the answer they support
 * without changing the order of independent turns.
 */
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
    records: {},
    liveText: {},
    liveTools: {},
    messageCount: 0,
    windowStartSeq: null,
    windowEndSeq: null,
    forwardCursor: null,
    olderExhausted: false,
    historyExhausted: false,
  };
}

/** Observe a durable view window without treating it as an exhaustive history. */
export function observeConversationView(
  state: ConversationProjectionState,
  view: { messages: ConversationMessage[]; messageCount: number },
) {
  const records = mergeRecords(state.records, view.messages);
  const sequences = view.messages.map(message => message.seq);
  return {
    ...state,
    records,
    messageCount: view.messageCount,
    windowStartSeq: sequences.length ? Math.min(...sequences) : state.windowStartSeq,
    windowEndSeq: sequences.length ? Math.max(...sequences) : state.windowEndSeq,
  };
}

export function applyConversationEvent(
  state: ConversationProjectionState,
  event: ConversationProjectionEvent,
) {
  const data = event.data;
  if (event.type === 'message.delta' && data?.text) {
    const operationId = data.operationId ?? 'stream';
    return {
      ...state,
      liveText: {
        ...state.liveText,
        [operationId]: (state.liveText[operationId] ?? '') + data.text,
      },
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
          done: data.phase === 'end',
          error: data.isError === true,
        },
      },
    };
  }
  if (TERMINAL_OPERATION_EVENTS.has(event.type) && data?.operationId) {
    const liveText = { ...state.liveText };
    delete liveText[data.operationId];
    const liveTools = Object.fromEntries(
      Object.entries(state.liveTools).filter(([, tool]) => tool.operationId !== data.operationId),
    );
    return { ...state, liveText, liveTools };
  }
  const message = data?.message;
  if (!message || (event.type !== 'message.created' && event.type !== 'message.updated')) return state;
  const knownMax = Object.values(state.records).reduce((max, candidate) => Math.max(max, candidate.seq), 0);
  const records = event.type === 'message.updated' || message.seq > knownMax
    ? mergeRecords(state.records, [message])
    : state.records;
  const liveText = { ...state.liveText };
  if (message.role === 'assistant' && message.operationId) delete liveText[message.operationId];
  const liveTools = { ...state.liveTools };
  if (message.role === 'tool' && typeof message.data?.toolCallId === 'string') {
    delete liveTools[message.data.toolCallId];
  }
  return { ...state, records, liveText, liveTools };
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
  const queuedMessages = all.filter(message => message.role === 'user' && message.state === 'queued');
  const durableAssistantOps = new Set(
    all.filter(message => message.role === 'assistant' && message.operationId)
      .map(message => message.operationId!),
  );
  const durableToolIds = new Set(
    all.filter(message => message.role === 'tool' && typeof message.data?.toolCallId === 'string')
      .map(message => String(message.data!.toolCallId)),
  );
  const latestAssistant = [...all].reverse().find(message => message.role === 'assistant');
  const suggestedPrompt = typeof latestAssistant?.data?.suggestedPrompt === 'string'
    ? latestAssistant.data.suggestedPrompt.trim().slice(0, 500)
    : '';
  return {
    messages: orderMessages(all.filter(message => !(message.role === 'user' && message.state === 'queued'))),
    queuedMessages,
    streaming: Object.entries(state.liveText).filter(([operationId]) => !durableAssistantOps.has(operationId)),
    liveTools: Object.values(state.liveTools).filter(tool => !durableToolIds.has(tool.toolCallId)),
    promptSuggestion: !options.busy && !queuedMessages.length ? suggestedPrompt : '',
    historyRequest: conversationHistoryRequest(state),
  };
}

export function messageAttachments(message: ConversationMessage) {
  const value = message.data?.attachments;
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const attachment = item as Record<string, unknown>;
    if (typeof attachment.name !== 'string' || typeof attachment.text !== 'string') return [];
    return [{
      name: attachment.name,
      type: typeof attachment.type === 'string' ? attachment.type : 'text/plain',
      size: typeof attachment.size === 'number' ? attachment.size : attachment.text.length,
      text: attachment.text,
    }];
  });
}
