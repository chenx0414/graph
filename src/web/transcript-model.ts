import type {
  ConversationMessage,
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

export type TranscriptRow =
  | { kind: 'message'; id: string; message: ConversationMessage }
  | { kind: 'tools'; id: string; tools: TranscriptTool[]; active: boolean }
  | { kind: 'streaming'; id: string; operationId: string; text: string }
  | { kind: 'thinking'; id: 'thinking' };

export type TranscriptModelInput = {
  messages: ConversationMessage[];
  liveTools: LiveTool[];
  streaming: [string, string][];
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
  return {
    ...previous,
    ...incoming,
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

/**
 * Turn the stream projection into stable visual rows. A contiguous run of
 * tool records is one group; the live tail is appended after durable history
 * so the same row survives the live-to-durable handoff.
 */
export function buildTranscriptRows(input: TranscriptModelInput): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let tools: TranscriptTool[] = [];
  let toolsById = new Map<string, TranscriptTool>();

  const flushTools = () => {
    pushToolGroup(rows, tools);
    tools = [];
    toolsById = new Map();
  };

  for (const message of input.messages) {
    if (message.role !== 'tool') {
      flushTools();
      rows.push({ kind: 'message', id: message.id, message });
      continue;
    }
    const incoming = durableTool(message);
    const previous = toolsById.get(incoming.id);
    const merged = mergeTool(previous, incoming);
    toolsById.set(incoming.id, merged);
    if (previous) {
      const index = tools.findIndex(tool => tool.id === incoming.id);
      if (index >= 0) tools[index] = merged;
    } else {
      tools.push(merged);
    }
  }
  flushTools();

  if (input.liveTools.length) {
    pushToolGroup(rows, input.liveTools.map(liveTool));
  }
  for (const [operationId, text] of input.streaming) {
    rows.push({ kind: 'streaming', id: `streaming:${operationId}`, operationId, text });
  }
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
