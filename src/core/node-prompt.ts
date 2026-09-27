import { readFileSync } from 'node:fs';
import type { TaskStore } from './store.ts';
import { RuntimeError, type NodeSpec } from './types.ts';

/** One send's own record: the system prompt and tool declarations the model really received. */
export interface RecordedPrompt {
  operationId: string;
  at: number;
  text: string;
  tools: string | null;
}

/** The first user message of a node's own session: the briefing the worker really read. */
export interface NodeBriefing {
  text: string;
  sessionFile: string;
}

export interface NodePromptView {
  taskId: string;
  nodeId: string;
  kind: string;
  action: string;
  role: string | null;
  definitionVersion: string | null;
  model: string | null;
  status: string;
  recorded: RecordedPrompt | null;
  briefing: NodeBriefing | null;
  /**
   * Why a part is absent. These are facts about the records, never a guess at what a
   * send might have carried: a prompt that was never recorded is reported as missing
   * rather than recomputed, so this view cannot drift from the send it describes.
   */
  notes: string[];
}

/** The first user message in a Pi session file, read from the session's own JSONL. */
function firstUserMessage(file: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (!message || message.role !== 'user') continue;
    if (typeof message.content === 'string' && message.content.length) return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map(part => (typeof part === 'string' ? part : (part as { text?: string } | null)?.text ?? ''))
        .join('');
      if (text.length) return text;
    }
  }
  return null;
}

/**
 * The role a send is assembled for, by the same rule the assembler uses: the master node
 * is main, an action that says review is the independent reviewer, everything else is a worker.
 */
function promptRole(spec: NodeSpec, kind: string): string | null {
  if (kind !== 'agent') return null;
  if (spec.role === 'master') return 'main';
  return spec.action.toLowerCase().includes('review') ? 'reviewer' : 'worker';
}

/**
 * What one subagent node really sent.
 *
 * Both halves come from durable records: the system prompt and tool declarations are
 * the ones recorded at the provider call of the node's newest send, and the briefing is
 * the first user message of the node's own session file. Nothing is recomposed here, so
 * the panel shows the send rather than a lookalike - and a node that never sent, or a
 * program node that is never sent a prompt, says exactly that.
 */
export function nodePromptView(store: TaskStore, taskId: string, nodeId: string): NodePromptView {
  const row = store.db.prepare('SELECT spec, instance_id, status FROM nodes WHERE task_id = ? AND id = ?')
    .get(taskId, nodeId) as { spec: string; instance_id: string | null; status: string } | undefined;
  if (!row) throw new RuntimeError('not_found', `Unknown node ${nodeId}`);
  const spec = JSON.parse(row.spec) as NodeSpec;
  const kind = spec.kind ?? 'agent';
  const notes: string[] = [];
  const recorded = store.nodeSystemPrompt(taskId, nodeId);
  let briefing: NodeBriefing | null = null;
  if (kind !== 'agent') {
    notes.push('程序节点：它在进程内运行，不会被发送 system prompt。');
    if (recorded) notes.push('节点类型已改变，但台账里仍留着它更早那次作为 agent 发送的记录。');
  } else {
    if (!recorded) notes.push('台账里没有这个节点的发送记录：它可能还没发送过，也可能是在工作进程里发送、这份记录尚未回传。');
    const session = row.instance_id
      ? store.db.prepare('SELECT session_file FROM node_sessions WHERE instance_id = ?')
        .get(row.instance_id) as { session_file: string } | undefined
      : undefined;
    if (!session) notes.push('该节点没有自己的会话，简报无法找回。');
    else {
      const text = firstUserMessage(session.session_file);
      if (text === null) notes.push(`它的会话（${session.session_file}）里没有 user 消息。`);
      else briefing = { text, sessionFile: session.session_file };
    }
  }
  return {
    taskId,
    nodeId,
    kind,
    action: spec.action,
    role: promptRole(spec, kind),
    definitionVersion: spec.definitionVersion ?? null,
    model: spec.model ?? null,
    status: row.status,
    recorded,
    briefing,
    notes,
  };
}
