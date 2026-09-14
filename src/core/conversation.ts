import { randomUUID } from 'node:crypto';
import { canonicalJson, type TaskStore } from './store.ts';
import { RuntimeError, type Json } from './types.ts';

/**
 * Conversation records live next to the execution ledger: every master turn is
 * still an operation with its own budget, gate and questions. This module owns
 * the message queue and the read-only summaries handed to the master prompt.
 */
export interface ConversationRow {
  id: string; project_id: string | null; workspace_project_id: string; anchor_task_id: string;
  title: string; created_seq: number; created_at: number;
  /** Messages after this seq belong to the current project binding. */
  binding_since_seq: number;
}
export interface MessageRow {
  seq: number; id: string; conversation_id: string; role: string; kind: string; text: string;
  data: string | null; state: string; operation_id: string | null; turn: number; created_at: number; updated_at: number;
}
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';
export type MessageState = 'pending' | 'delivered' | 'done' | 'failed';

export function conversationRow(store: TaskStore, conversationId: string): ConversationRow {
  const row = store.db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId) as ConversationRow | undefined;
  if (!row) throw new RuntimeError('not_found', 'Conversation not found');
  return row;
}

export function conversationForTask(store: TaskStore, taskId: string): ConversationRow | undefined {
  return store.db.prepare('SELECT c.* FROM conversations c JOIN tasks t ON t.conversation_id=c.id WHERE t.id=?').get(taskId) as ConversationRow | undefined;
}

export function publicMessage(row: MessageRow) {
  return {
    id: row.id, seq: row.seq, role: row.role, kind: row.kind, text: row.text,
    data: row.data ? JSON.parse(row.data) as Json : null,
    state: row.state, operationId: row.operation_id, turn: row.turn,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** Append one durable message and publish it on the conversation stream. */
export function appendMessage(store: TaskStore, input: {
  conversationId: string; role: MessageRole; kind: string; text: string; data?: Json;
  state?: MessageState; operationId?: string | null; turn?: number; /** When set, an existing row is finalized instead of inserted. */
  messageId?: string;
}) {
  const now = Date.now();
  let row: MessageRow;
  if (input.messageId) {
    store.db.prepare('UPDATE messages SET text=?,data=?,state=?,operation_id=?,turn=?,updated_at=MAX(?,updated_at+1) WHERE id=? AND conversation_id=?')
      .run(input.text, input.data === undefined ? null : canonicalJson(input.data), input.state ?? 'done', input.operationId ?? null, input.turn ?? 0, now, input.messageId, input.conversationId);
    row = store.db.prepare('SELECT * FROM messages WHERE id=?').get(input.messageId) as unknown as MessageRow;
    store.event((store.db.prepare('SELECT anchor_task_id FROM conversations WHERE id=?').get(input.conversationId) as { anchor_task_id: string }).anchor_task_id, 'message.updated', { message: publicMessage(row) });
    return { ...publicMessage(row), cursor: null as number | null };
  }
  const id = randomUUID();
  const sequence = store.db.prepare('INSERT INTO messages(conversation_id,id,role,kind,text,data,state,operation_id,turn,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(input.conversationId, id, input.role, input.kind, input.text, input.data === undefined ? null : canonicalJson(input.data), input.state ?? 'done', input.operationId ?? null, input.turn ?? 0, now, now);
  row = store.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as unknown as MessageRow;
  const cursor = store.event(conversationRow(store, input.conversationId).anchor_task_id, 'message.created', { message: publicMessage(row) });
  return { ...publicMessage(row), cursor };
}

/** Messages the next master turn must answer; consumed atomically with the operation. */
export function pendingMessages(store: TaskStore, conversationId: string, limit = 50): MessageRow[] {
  return store.db.prepare("SELECT * FROM messages WHERE conversation_id=? AND state='pending' ORDER BY seq LIMIT ?").all(conversationId, limit) as unknown as MessageRow[];
}

/** Messages bound to one operation, used by failure paths to requeue or report. */
export function messagesForOperation(store: TaskStore, operationId: string): MessageRow[] {
  return store.db.prepare('SELECT * FROM messages WHERE operation_id=? ORDER BY seq').all(operationId) as unknown as MessageRow[];
}

/** Publish one durable message record on the conversation stream. */
export function publishMessageUpdate(store: TaskStore, messageId: string) {
  const row = store.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as unknown as MessageRow | undefined;
  if (!row) return;
  store.event(conversationRow(store, row.conversation_id).anchor_task_id, 'message.updated', { message: publicMessage(row) });
}

/** A pre-send refusal proves the model never saw the message, so it queues
 * again; the state change is published so incremental caches catch up. */
export function releaseMessages(store: TaskStore, operationId: string) {
  const rows = messagesForOperation(store, operationId).filter(row => row.state === 'delivered');
  if (!rows.length) return;
  store.db.prepare("UPDATE messages SET state='pending',operation_id=NULL,updated_at=MAX(?,updated_at+1) WHERE operation_id=? AND state='delivered'").run(Date.now(), operationId);
  for (const row of rows) publishMessageUpdate(store, row.id);
}

/** Page messages without ever hiding the newest records: the default page is
 * the latest window, `after` walks forward (incremental reads) and `before`
 * walks backward (history). */
export function listMessages(store: TaskStore, conversationId: string, query: { after?: number; before?: number; limit?: number } = {}) {
  const cap = Number.isSafeInteger(query.limit) && query.limit! > 0 ? Math.min(query.limit!, 500) : 200;
  if (query.after !== undefined) {
    return (store.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?').all(conversationId, query.after, cap) as unknown as MessageRow[])
      .map(publicMessage);
  }
  if (query.before !== undefined) {
    return (store.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(conversationId, query.before, cap) as unknown as MessageRow[])
      .reverse().map(publicMessage);
  }
  return (store.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT ?').all(conversationId, cap) as unknown as MessageRow[])
    .reverse().map(publicMessage);
}

function projectLine(store: TaskStore, projectId: string | null) {
  if (!projectId) return 'Project: not bound (ask the user to choose one from the configured projects)';
  const row = store.db.prepare('SELECT root FROM projects WHERE id=?').get(projectId) as { root: string } | undefined;
  return `Project: ${projectId}${row ? ` (root ${row.root})` : ''}`;
}

function nodeSummary(store: TaskStore, taskId: string) {
  const rows = store.db.prepare('SELECT id,spec,status FROM nodes WHERE task_id=? ORDER BY rowid').all(taskId) as { id: string; spec: string; status: string }[];
  return rows.map(row => `${row.id}:${row.status}`).join(', ');
}

/**
 * Compact, factual execution status handed to the master on every turn. It is
 * a projection of recorded state, never a fabricated summary: questions,
 * phases, commits and node states come straight from the ledger.
 */
export function conversationDigest(store: TaskStore, conversationId: string) {
  const conversation = conversationRow(store, conversationId);
  const anchor = store.task(conversation.anchor_task_id);
  const master = store.db.prepare("SELECT n.id,n.status,n.output,i.used,i.budget,i.model FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? AND json_extract(n.spec,'$.role')='master'").get(anchor.id) as { status: string; used: number | null; budget: number | null; model: string | null } | undefined;
  const lines = [projectLine(store, conversation.project_id)];
  const proposal = anchor.latest_proposal
    ? store.db.prepare('SELECT version,requirement_version,spec FROM proposals WHERE task_id=? AND version=?').get(anchor.id, anchor.latest_proposal) as { version: number; requirement_version: number; spec: string } | undefined
    : undefined;
  if (proposal) {
    const spec = JSON.parse(proposal.spec) as { summary?: string };
    const stale = proposal.requirement_version !== anchor.requirement_version ? ' (stale: requirement changed)' : '';
    lines.push(`Draft: v${proposal.version} on requirement v${proposal.requirement_version}${stale} — ${spec.summary ?? '(no summary)'}`);
  } else lines.push('Draft: none yet');
  if (master) lines.push(`Master: ${master.status}, model ${master.model ?? 'unknown'}, used ${master.used ?? 0}/${master.budget ?? 0} tokens`);
  const tasks = store.db.prepare("SELECT id,phase,paused,request,integration_sha,accepted_proposal FROM tasks WHERE conversation_id=? AND phase!='chatting' ORDER BY created_seq").all(conversationId) as { id: string; phase: string; paused: number; request: string; integration_sha: string | null; accepted_proposal: number | null }[];
  if (!tasks.length) lines.push('Feature tasks: none (nothing has been dispatched)');
  for (const task of tasks) {
    const questions = store.db.prepare("SELECT kind,node_id FROM questions WHERE task_id=? AND status='open' ORDER BY rowid").all(task.id) as { kind: string; node_id: string }[];
    const usage = store.db.prepare('SELECT COALESCE(SUM(i.used),0) AS used, COALESCE(SUM(i.budget),0) AS budget FROM instances i JOIN nodes n ON n.instance_id=i.id WHERE n.task_id=?').get(task.id) as { used: number; budget: number };
    lines.push(`Feature task ${task.id.slice(0, 8)} (${task.phase}${task.paused ? ', paused' : ''}): request "${task.request.slice(0, 120)}"; commit ${task.integration_sha?.slice(0, 10) ?? 'none'}; tokens ${usage.used}/${usage.budget}; nodes: ${nodeSummary(store, task.id) || 'none'}`);
    if (questions.length) lines.push(`  open questions: ${questions.map(question => `${question.kind}@${question.node_id}`).join(', ')}`);
    const evidence = store.db.prepare('SELECT acceptance_id,valid FROM evidence WHERE task_id=? ORDER BY rowid').all(task.id) as { acceptance_id: string; valid: number }[];
    if (evidence.length) lines.push(`  evidence: ${evidence.map(item => `${item.acceptance_id}:${item.valid ? 'valid' : 'invalid'}`).join(', ')}`);
  }
  return lines.join('\n');
}

export function newConversationId() { return randomUUID(); }
