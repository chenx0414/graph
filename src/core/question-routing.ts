import { randomUUID } from 'node:crypto';
import { canonicalJson, type TaskStore } from './store.ts';
import { conversationForTask } from './conversation.ts';
import { openUserWait } from './time-ledger.ts';
import type { Json } from './types.ts';

export type QuestionOwner = 'user' | 'main';

const DIRECT_USER_KINDS = new Set([
  'permission',
  'budget',
  'reservation_exceeded',
  'human_check',
  'system_change',
]);

function record(value: Json): Record<string, Json> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Only decisions the user alone can make bypass the main Agent. Everything
 * else is first routed to the main Agent for diagnosis and resolution. */
export function questionOwner(kind: string, data: Json): QuestionOwner {
  if (DIRECT_USER_KINDS.has(kind)) return 'user';
  const body = record(data);
  if (kind === 'waiting' && body?.requestType === 'model_access') return 'user';
  return 'main';
}

export function questionSummary(kind: string, data: Json): string {
  const body = record(data);
  for (const key of ['prompt', 'reason', 'message', 'grant', 'requested'] as const) {
    const value = body?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500);
  }
  return `执行问题：${kind}`;
}

function masterNode(store: TaskStore, anchorTaskId: string) {
  return store.db.prepare(
    "SELECT id,status FROM nodes WHERE task_id=? AND json_extract(spec,'$.role')='master' LIMIT 1",
  ).get(anchorTaskId) as { id: string; status: string } | undefined;
}

/** Insert one durable question and route it to the correct owner. Main-owned
 * questions wake the conversation master; user-owned questions open the human
 * wait ledger and become visible in the inbox. */
export function insertQuestion(store: TaskStore, input: {
  taskId: string;
  nodeId: string;
  operationId?: string | null;
  kind: string;
  data: Json;
}) {
  const id = randomUUID();
  const preferred = questionOwner(input.kind, input.data);
  const conversation = conversationForTask(store, input.taskId);
  const master = conversation ? masterNode(store, conversation.anchor_task_id) : undefined;
  const owner: QuestionOwner = preferred === 'main' && master ? 'main' : 'user';
  // A problem on the master node itself cannot be resolved by waking the same
  // master: it would immediately hit the identical failure again. It stays a
  // main-owned problem (invisible to the user) and is parked from the scheduler
  // until an explicit retry or configuration recovery releases it.
  const selfOwned = Boolean(master && master.id === input.nodeId);
  store.db.prepare(
    'INSERT INTO questions(id,task_id,node_id,operation_id,kind,data,owner) VALUES(?,?,?,?,?,?,?)',
  ).run(id, input.taskId, input.nodeId, input.operationId ?? null, input.kind, canonicalJson(input.data), owner);

  if (owner === 'main' && conversation && master) {
    const routing = {
      questionId: id,
      taskId: input.taskId,
      nodeId: input.nodeId,
      kind: input.kind,
      summary: questionSummary(input.kind, input.data),
      owner,
    };
    // The main Agent runs as the conversation master. Its prompt reads the
    // structured problem list; no user-visible raw error message is inserted.
    if (!['preparing', 'running'].includes(master.status)) {
      store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?").run(conversation.anchor_task_id, master.id);
    }
    store.event(conversation.anchor_task_id, selfOwned ? 'problem.parked' : 'problem.routed', routing);
  } else {
    openUserWait(store, input.taskId, input.nodeId);
  }

  store.event(input.taskId, 'question.opened', {
    nodeId: input.nodeId,
    kind: input.kind,
    data: input.data,
    operationId: input.operationId ?? null,
    questionId: id,
    owner,
  });
  return { id, owner };
}
