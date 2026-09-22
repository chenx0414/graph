import { randomUUID } from 'node:crypto';
import { canonicalJson, type TaskStore } from './store.ts';
import { RuntimeError, type Json, type NodeSpec, type Operation, type OperationResult } from './types.ts';

/**
 * Conversation records live next to the execution ledger: every master turn is
 * still an operation with its own budget, gate and questions. This module owns
 * the message queue and the read-only summaries handed to the master prompt.
 */
export interface ConversationRow {
  id: string; project_id: string | null; workspace_project_id: string; anchor_task_id: string;
  title: string; created_seq: number; created_at: number;
  archived_at: number | null; thinking_level: string;
  /** Messages after this seq belong to the current project binding. */
  binding_since_seq: number;
}
export interface MessageRow {
  seq: number; id: string; conversation_id: string; role: string; kind: string; text: string;
  data: string | null; state: string; operation_id: string | null; turn: number; created_at: number; updated_at: number;
}
export interface ConversationStreamRow {
  operation_id: string; conversation_id: string; entry_id: string; part_id: string;
  text: string; length: number; updated_at: number;
}
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';
export type MessageState = 'pending' | 'queued' | 'delivered' | 'done' | 'failed';

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

/** Persist one appendable live response, publishing only the new suffix in the
 * common case. A reset carries the full active text so a reconnect can repair
 * any missing prefix without guessing. */
export function publishConversationDelta(store: TaskStore, input: {
  taskId: string;
  conversationId: string;
  operationId: string;
  entryId: string;
  partId: string;
  delta: string;
  text: string;
  length: number;
}) {
  const previous = store.db.prepare('SELECT * FROM conversation_streams WHERE operation_id=?')
    .get(input.operationId) as ConversationStreamRow | undefined;
  const appendable = Boolean(
    previous
    && input.text.startsWith(previous.text)
    && previous.length + input.delta.length === input.length,
  );
  const reset = !appendable;
  const text = reset ? input.text : input.delta;
  store.transaction(() => {
    store.db.prepare(`INSERT INTO conversation_streams(
      operation_id,conversation_id,entry_id,part_id,text,length,updated_at
    ) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(operation_id) DO UPDATE SET
      conversation_id=excluded.conversation_id,
      entry_id=excluded.entry_id,
      part_id=excluded.part_id,
      text=excluded.text,
      length=excluded.length,
      updated_at=excluded.updated_at`).run(
      input.operationId,
      input.conversationId,
      input.entryId,
      input.partId,
      input.text,
      input.length,
      Date.now(),
    );
    store.event(input.taskId, 'message.delta', {
      operationId: input.operationId,
      entryId: input.entryId,
      partId: input.partId,
      text,
      len: input.length,
      reset,
    });
  });
}

export function clearConversationStream(store: TaskStore, operationId: string) {
  store.db.prepare('DELETE FROM conversation_streams WHERE operation_id=?').run(operationId);
}

export function conversationStreams(store: TaskStore, conversationId: string) {
  return (store.db.prepare(`SELECT s.* FROM conversation_streams s
    JOIN operations o ON o.id=s.operation_id
    WHERE s.conversation_id=? AND o.state IN ('intent','dispatched')
    ORDER BY s.updated_at`).all(conversationId) as unknown as ConversationStreamRow[]).map(row => ({
    operationId: row.operation_id,
    entryId: row.entry_id,
    partId: row.part_id,
    text: row.text,
    length: row.length,
    updatedAt: row.updated_at,
  }));
}

/** Append one durable message and publish it on the conversation stream. */
export function appendMessage(store: TaskStore, input: {
  conversationId: string; role: MessageRole; kind: string; text: string; data?: Json;
  state?: MessageState; operationId?: string | null; turn?: number; /** When set, an existing row is finalized instead of inserted. */
  messageId?: string;
}) {
  const now = Date.now();
  if (input.operationId && input.role !== 'user') clearConversationStream(store, input.operationId);
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
  return store.db.prepare("SELECT * FROM messages WHERE conversation_id=? AND state IN ('pending','queued') ORDER BY seq LIMIT ?").all(conversationId, limit) as unknown as MessageRow[];
}

/** Move accepted queued messages to the current end of the stream before
 * marking them delivered. This keeps a queued turn after the assistant reply
 * that preceded it instead of reusing the timestamp at which the user typed. */
export function deliverMessages(store: TaskStore, operationId: string, turn: number, messages: MessageRow[]) {
  for (const message of messages) {
    if (message.state === 'queued') {
      const next = (store.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages').get() as { seq: number }).seq;
      store.db.prepare(`UPDATE messages SET seq=?,state='delivered',operation_id=?,turn=?,updated_at=MAX(?,updated_at+1)
        WHERE id=? AND state='queued'`).run(next, operationId, turn, Date.now(), message.id);
      store.db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='messages'").run(next);
    } else {
      store.db.prepare(`UPDATE messages SET state='delivered',operation_id=?,turn=?,updated_at=MAX(?,updated_at+1)
        WHERE id=? AND state='pending'`).run(operationId, turn, Date.now(), message.id);
    }
    publishMessageUpdate(store, message.id);
  }
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

/** Where a failed turn failed: before the model ran (a setup failure) or during the run.
 * The distinction decides how the reason text is read. */
export type TurnFailureKind = 'setup' | 'run';

/** Turn an internal failure into a short, actionable line for the chat. Raw
 * exception text, stack traces and JSON stay in the problem ledger. */
export function turnFailureText(reason: string, kind: TurnFailureKind = 'run') {
  // A setup failure never reached the model, so its text is the environment story and has to be
  // shown. Reading a stack that merely mentions package_json_reader as a truncated model output
  // is how a Pi worker that could not load its own modules became an actively misleading notice.
  const detail = failureDetail(reason);
  if (kind === 'setup') {
    return `主 Agent 本轮没有启动起来，回复没有完成。消息已保留，可以再发一次重试。${detail ? ` 原因：${detail}` : ''}`;
  }
  if (/unterminated string|unexpected end of (json|input)|unexpected token|output token limit|truncat/i.test(reason)) {
    return '主 Agent 本轮的模型输出被截断，回复没有完成。消息已保留，可以再发一次或切换模型后重试。';
  }
  if (/unknown usage/i.test(reason)) return '主 Agent 本轮缺少可核对的用量，消息已保留，稍后可以重试。';
  return `主 Agent 本轮没有完成回复，消息已保留，可以再发一次重试。${detail ? ` 原因：${detail}` : ''}`;
}

/** The one line worth showing from a failure blob: its longest early line carries the message
 * while stack frames stay short. Single line, bounded. */
function failureDetail(reason: string) {
  const lines = reason.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8);
  return lines.reduce((best, line) => (line.length > best.length ? line : best), '').slice(0, 240);
}

/** The concrete reason behind a failed master turn plus the field it came from: a run
 * failure carries error, a setup failure carries setupError, and anything else falls back to
 * the raw result. Reading the field is what keeps a setup failure from being described as a
 * truncated model output. */
export function turnFailureReason(result: OperationResult): { reason: string; kind: TurnFailureKind } {
  const output = result.output && typeof result.output === 'object' && !Array.isArray(result.output)
    ? result.output as { [key: string]: Json }
    : undefined;
  for (const key of ['error', 'setupError'] as const) {
    const value = output?.[key];
    if (typeof value === 'string' && value.trim()) return { reason: value, kind: key === 'setupError' ? 'setup' : 'run' };
  }
  return { reason: JSON.stringify(result.output ?? result.outcome), kind: 'run' };
}

/** Persist the durable side of one master turn: its assistant reply and the
 * summarized tool activity. Idempotent per operation. */
export function recordConversationOutput(store: TaskStore, operation: Operation, result: OperationResult) {
  if (operation.kind !== 'agent') return;
  const nodeSpec = JSON.parse((store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?')
    .get(operation.taskId, operation.nodeId) as { spec: string }).spec) as NodeSpec;
  if (nodeSpec.role !== 'master') return;
  const conversation = conversationForTask(store, operation.taskId);
  if (!conversation) return;
  if (store.db.prepare("SELECT id FROM messages WHERE operation_id=? AND role='assistant' LIMIT 1").get(operation.id)) return;
  const output = result.output && typeof result.output === 'object' && !Array.isArray(result.output)
    ? result.output as { [key: string]: Json }
    : undefined;
  if (result.outcome === 'completed') {
    const reply = typeof output?.text === 'string' ? output.text.trim() : '';
    const suggestedPrompt = typeof output?.suggestedPrompt === 'string' ? output.suggestedPrompt.trim().slice(0, 500) : '';
    if (reply) {
      appendMessage(store, {
        conversationId: conversation.id,
        role: 'assistant',
        kind: 'chat',
        text: reply,
        state: 'done',
        operationId: operation.id,
        turn: operation.attempt,
        ...(suggestedPrompt ? { data: { suggestedPrompt } } : {}),
      });
    }
    const activity = Array.isArray(output?.toolActivity) ? output.toolActivity : [];
    for (const item of activity) {
      const entry = item as { name?: unknown; summary?: unknown; state?: unknown; toolCallId?: unknown };
      if (typeof entry.summary !== 'string' || !entry.summary.trim()) continue;
      appendMessage(store, {
        conversationId: conversation.id,
        role: 'tool',
        kind: 'tool',
        text: typeof entry.name === 'string' ? `${entry.name}: ${entry.summary}` : entry.summary,
        data: {
          tool: typeof entry.name === 'string' ? entry.name : 'tool',
          ...(typeof entry.toolCallId === 'string' ? { toolCallId: entry.toolCallId } : {}),
          ...(entry.state === 'error' ? { error: true } : {}),
        },
        state: 'done',
        operationId: operation.id,
        turn: operation.attempt,
      });
    }
  } else if (result.outcome === 'failed') {
    const failure = turnFailureReason(result);
    appendMessage(store, {
      conversationId: conversation.id,
      role: 'system',
      kind: 'error',
      text: turnFailureText(failure.reason ?? '', failure.kind),
      state: 'done',
      operationId: operation.id,
      turn: operation.attempt,
    });
  }
}

/** Record one plain-language interruption for a master turn whose outcome is
 * uncertain and which will therefore not reach recordConversationOutput. */
export function recordConversationInterruption(store: TaskStore, operation: Operation, reason: string, kind: TurnFailureKind = 'run') {
  if (operation.kind !== 'agent') return;
  const nodeSpec = JSON.parse((store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?')
    .get(operation.taskId, operation.nodeId) as { spec: string }).spec) as NodeSpec;
  if (nodeSpec.role !== 'master') return;
  const conversation = conversationForTask(store, operation.taskId);
  if (!conversation) return;
  if (store.db.prepare("SELECT id FROM messages WHERE operation_id=? AND role='system' AND kind='error' LIMIT 1").get(operation.id)) return;
  appendMessage(store, {
    conversationId: conversation.id,
    role: 'system',
    kind: 'error',
    text: turnFailureText(reason, kind),
    state: 'done',
    operationId: operation.id,
    turn: operation.attempt,
  });
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

function questionSummary(kind: string, data: Json) {
  const body = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  for (const key of ['prompt', 'reason', 'message', 'grant', 'requested'] as const) {
    const value = body?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500);
  }
  return `执行问题：${kind}`;
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
  const mainProblems = store.db.prepare(`SELECT q.id,q.task_id,q.node_id,q.kind,q.data
    FROM questions q JOIN tasks t ON t.id=q.task_id
    WHERE q.owner='main' AND q.status='open' AND (t.id=? OR t.conversation_id=?)
    ORDER BY q.rowid`).all(anchor.id, conversationId) as { id: string; task_id: string; node_id: string; kind: string; data: string }[];
  if (mainProblems.length) {
    lines.push('Problems awaiting main Agent:');
    for (const problem of mainProblems) {
      const data = JSON.parse(problem.data) as Json;
      lines.push(`- ${problem.id} · ${problem.kind}@${problem.node_id} on task ${problem.task_id.slice(0, 8)}: ${questionSummary(problem.kind, data)}`);
    }
  }
  const tasks = store.db.prepare("SELECT id,phase,paused,request,integration_sha,accepted_proposal FROM tasks WHERE conversation_id=? AND phase!='chatting' ORDER BY created_seq").all(conversationId) as { id: string; phase: string; paused: number; request: string; integration_sha: string | null; accepted_proposal: number | null }[];
  if (!tasks.length) lines.push('Feature tasks: none (nothing has been dispatched)');
  for (const task of tasks) {
    const questions = store.db.prepare("SELECT id,kind,node_id,owner,data FROM questions WHERE task_id=? AND status='open' ORDER BY rowid").all(task.id) as { id: string; kind: string; node_id: string; owner: string; data: string }[];
    const usage = store.db.prepare('SELECT COALESCE(SUM(i.used),0) AS used, COALESCE(SUM(i.budget),0) AS budget FROM instances i JOIN nodes n ON n.instance_id=i.id WHERE n.task_id=?').get(task.id) as { used: number; budget: number };
    lines.push(`Feature task ${task.id.slice(0, 8)} (${task.phase}${task.paused ? ', paused' : ''}): request "${task.request.slice(0, 120)}"; commit ${task.integration_sha?.slice(0, 10) ?? 'none'}; tokens ${usage.used}/${usage.budget}; nodes: ${nodeSummary(store, task.id) || 'none'}`);
    const userQuestions = questions.filter(question => question.owner === 'user');
    const internalQuestions = questions.filter(question => question.owner === 'main');
    if (userQuestions.length) lines.push(`  questions awaiting user: ${userQuestions.map(question => `${question.kind}@${question.node_id}`).join(', ')}`);
    if (internalQuestions.length) {
      lines.push('  problems awaiting main Agent:');
      for (const question of internalQuestions) {
        lines.push(`  - ${question.id} · ${question.kind}@${question.node_id}: ${questionSummary(question.kind, JSON.parse(question.data) as Json)}`);
      }
    }
    const evidence = store.db.prepare('SELECT acceptance_id,valid FROM evidence WHERE task_id=? ORDER BY rowid').all(task.id) as { acceptance_id: string; valid: number }[];
    if (evidence.length) lines.push(`  evidence: ${evidence.map(item => `${item.acceptance_id}:${item.valid ? 'valid' : 'invalid'}`).join(', ')}`);
  }
  return lines.join('\n');
}

export function newConversationId() { return randomUUID(); }
