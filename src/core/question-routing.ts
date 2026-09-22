import { randomUUID } from 'node:crypto';
import { canonicalJson, type TaskStore } from './store.ts';
import { conversationForTask } from './conversation.ts';
import { openUserWait } from './time-ledger.ts';
import { RuntimeError, type Answer, type Json } from './types.ts';

export type QuestionOwner = 'user' | 'main';

type ProblemAction = 'retry' | 'acknowledge' | 'respond' | 'reconcile_usage' | 'escalate';
type QuestionPolicy = {
  owner: QuestionOwner;
  answers: readonly Answer['type'][];
  retryOnMessage?: boolean;
  escalate?: boolean;
};

// Ownership, offered actions and answer acceptance share the same policy.
// Message retries are deliberately narrower than configuration recovery.
const POLICIES: Readonly<Record<string, QuestionPolicy>> = {
  permission: { owner: 'user', answers: ['grant'] },
  budget: { owner: 'user', answers: ['add_budget'] },
  reservation_exceeded: { owner: 'user', answers: ['acknowledge'] },
  human_check: { owner: 'user', answers: ['acknowledge', 'reject'] },
  system_change: { owner: 'user', answers: ['respond'] },
  unknown_usage: { owner: 'main', answers: ['usage', 'reconcile_usage'] },
  waiting: { owner: 'main', answers: ['respond'] },
  adapter_error: { owner: 'main', answers: ['retry'], retryOnMessage: true },
  execution_failed: { owner: 'main', answers: ['retry'], retryOnMessage: true, escalate: true },
  model_unavailable: { owner: 'main', answers: ['retry'] },
  git_conflict: { owner: 'main', answers: ['retry'], retryOnMessage: true },
  context_rejected: { owner: 'main', answers: ['retry'], retryOnMessage: true, escalate: true },
  recovery: { owner: 'main', answers: ['retry'], retryOnMessage: true },
  result_noncompliant: { owner: 'main', answers: ['retry'], escalate: true },
  git_dirty: { owner: 'main', answers: ['acknowledge'] },
  rework: { owner: 'main', answers: ['respond', 'retry'] },
  stalled: { owner: 'main', answers: ['respond', 'retry'] },
};
const UNKNOWN_POLICY: QuestionPolicy = { owner: 'main', answers: [] };

function policy(kind: string): QuestionPolicy {
  return Object.hasOwn(POLICIES, kind) ? POLICIES[kind]! : UNKNOWN_POLICY;
}

/** Only expose actions that the settlement path can actually accept. */
export function problemActions(kind: string): ProblemAction[] {
  const rule = policy(kind);
  if (rule.owner !== 'main') return [];
  const actions = rule.answers.filter((answer): answer is Exclude<ProblemAction, 'escalate'> =>
    answer === 'retry' || answer === 'respond' || answer === 'acknowledge' || answer === 'reconcile_usage');
  return rule.escalate ? [...actions, 'escalate'] : actions;
}

/** Value validation and settlement effects remain with OperationLifecycle. */
export function assertQuestionAnswer(kind: string, answer: Answer) {
  if (!policy(kind).answers.includes(answer.type)) {
    throw new RuntimeError('invalid_answer', 'Answer type does not match the open question');
  }
}

function record(value: Json): Record<string, Json> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Only decisions the user alone can make bypass the main Agent. Everything
 * else is first routed to the main Agent for diagnosis and resolution. */
export function questionOwner(kind: string, data: Json): QuestionOwner {
  const body = record(data);
  // A worker or the main Agent may hand a decision back to the user through a
  // waiting question; those request types are the user's to answer.
  if (kind === 'waiting' && (body?.requestType === 'model_access' || body?.requestType === 'noncompliance_decision')) return 'user';
  return policy(kind).owner;
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

/** A pending master can still be parked; callers must not infer readiness from status alone. */
export function isMasterParked(store: TaskStore, taskId: string, nodeId: string): boolean {
  return Boolean(store.db.prepare(
    "SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open' AND owner='main' LIMIT 1",
  ).get(taskId, nodeId));
}

/**
 * Release a master for an explicit message or configuration change. Startup
 * does not call this: simply reopening the runtime must leave problems parked.
 * Returns whether a parked problem was resolved. Writes join an existing
 * command/recovery transaction, or open one when called on its own.
 */
export function recoverMaster(store: TaskStore, taskId: string, reason: 'message' | 'configuration'): boolean {
  const apply = () => {
    const master = masterNode(store, taskId);
    if (!master) return false;
    const parked = store.db.prepare(
      "SELECT id,kind FROM questions WHERE task_id=? AND node_id=? AND status='open' AND owner='main'",
    ).all(taskId, master.id) as { id: string; kind: string }[];
    if (reason === 'configuration') {
      if (!parked.length || store.db.prepare(
        "SELECT id FROM questions WHERE task_id=? AND status='open' AND owner='user' LIMIT 1",
      ).get(taskId)) return false;
    }
    const released = reason === 'configuration' ? parked : parked.filter(question => policy(question.kind).retryOnMessage);
    for (const question of released) {
      store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE id=?")
        .run(canonicalJson({ type: 'retry' }), question.id);
    }
    if (reason === 'configuration' || !['preparing', 'running', 'blocked'].includes(master.status)) {
      store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?").run(taskId, master.id);
    }
    if (reason === 'configuration') {
      store.event(taskId, 'task.master_recovered', { reason: 'internal problem parked while the environment was unavailable' });
    }
    return released.length > 0;
  };
  return store.db.isTransaction ? apply() : store.transaction(apply);
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
  autoAnswer?: {
    answer: Answer;
    policyDigest: string;
    resume?: boolean;
  };
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
  const selfOwned = Boolean(master && conversation?.anchor_task_id === input.taskId && master.id === input.nodeId);
  store.db.prepare(
    'INSERT INTO questions(id,task_id,node_id,operation_id,kind,data,owner) VALUES(?,?,?,?,?,?,?)',
  ).run(id, input.taskId, input.nodeId, input.operationId ?? null, input.kind, canonicalJson(input.data), owner);

  if (input.autoAnswer) {
    if (input.kind === 'permission' && input.autoAnswer.answer.type === 'grant') {
      const requested = record(input.data)?.grant;
      if (input.autoAnswer.answer.grant !== requested) {
        throw new Error('Automatic grant must match the requested capability');
      }
      store.db.prepare('INSERT OR IGNORE INTO task_grants VALUES(?,?)').run(input.taskId, input.autoAnswer.answer.grant);
    }
    store.db.prepare("UPDATE questions SET status='resolved',answer=? WHERE id=?")
      .run(canonicalJson(input.autoAnswer.answer), id);
    if (input.autoAnswer.resume) {
      store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=?").run(input.taskId, input.nodeId);
      store.db.prepare("UPDATE activations SET state='pending' WHERE id=(SELECT activation_id FROM nodes WHERE task_id=? AND id=?)")
        .run(input.taskId, input.nodeId);
    }
    store.event(input.taskId, 'question.auto_approved', {
      questionId: id,
      nodeId: input.nodeId,
      operationId: input.operationId ?? null,
      kind: input.kind,
      answer: input.autoAnswer.answer as unknown as Json,
      policyDigest: input.autoAnswer.policyDigest,
    });
  } else if (owner === 'main' && conversation && master) {
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

  if (!input.autoAnswer) {
    store.event(input.taskId, 'question.opened', {
      nodeId: input.nodeId,
      kind: input.kind,
      data: input.data,
      operationId: input.operationId ?? null,
      questionId: id,
      owner,
    });
  }
  return { id, owner };
}
