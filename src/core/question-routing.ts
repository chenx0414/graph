import { randomUUID } from 'node:crypto';
import { wakeForBlockedNode, wakeForHumanCheck } from './wake-ledger.ts';
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
  // A node stuck for three rounds or returned for rework may need a decision only the user can
  // make. Escalating hands the decision over with the main Agent's own explanation attached
  // instead of looping on a retry that cannot change the outcome.
  rework: { owner: 'main', answers: ['respond', 'retry'], escalate: true },
  stalled: { owner: 'main', answers: ['respond', 'retry'], escalate: true },
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
  // A master question of its own is the user's decision to make: it routes to the inbox
  // instead of becoming an internal problem nobody outside the runtime can answer.
  if (kind === 'waiting' && (body?.requestType === 'model_access' || body?.requestType === 'noncompliance_decision'
    || body?.requestType === 'user_decision')) return 'user';
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
    // Record the same durable, deduplicated intent every other wake uses, so a problem
    // that is observed again does not become a second turn. A problem on the master's
    // own node is parked instead: waking the master about itself would hit the identical
    // failure again, which is what "parked" has always meant here.
    if (!selfOwned) {
      wakeForBlockedNode(store, input.taskId, { nodeId: input.nodeId, reason: input.kind });
    }
    store.event(conversation.anchor_task_id, selfOwned ? 'problem.parked' : 'problem.routed', routing);
  } else {
    openUserWait(store, input.taskId, input.nodeId);
    // A node that stopped because only a person can unblock it is still a fact the
    // conversation's master should hear about once: it is the actor holding the
    // context to say what this means and what happens next. The wake is idempotent,
    // so observing the same block again does not queue a second turn.
    //
    // A question the master raised itself must not wake that same master: it would start a
    // turn whose only content is the question it just asked.
    if (!selfOwned) {
      if (input.kind === 'human_check') {
        // Review-before-the-user: the master looks at the evidence first, so a check that
        // should never have been raised can be sent back through rework instead of
        // interrupting the person. Approving here is deliberately not acceptance - see
        // approveHumanCheck - because acceptance stays the person's own decision.
        wakeForHumanCheck(store, input.taskId, { nodeId: input.nodeId, questionId: id });
      } else {
        wakeForBlockedNode(store, input.taskId, { nodeId: input.nodeId, reason: input.kind });
      }
    }
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

/**
 * The evidence a human acceptance check is resting on, or null when the question is not
 * an open human check. This is what the master reads before deciding whether the person
 * should be asked at all.
 */
export function humanCheckPreReview(store: TaskStore, questionId: string) {
  const row = store.db.prepare('SELECT id,task_id,node_id,kind,status,data FROM questions WHERE id=?').get(questionId) as
    { id: string; task_id: string; node_id: string; kind: string; status: string; data: string } | undefined;
  if (!row || row.kind !== 'human_check') return null;
  const data = JSON.parse(row.data) as Record<string, Json>;
  return {
    questionId: row.id,
    taskId: row.task_id,
    nodeId: row.node_id,
    status: row.status,
    activationId: typeof data.activationId === 'string' ? data.activationId : null,
    commitSha: typeof data.commitSha === 'string' ? data.commitSha : null,
    approved: isPreApproved(data),
  };
}

function isPreApproved(data: Record<string, Json>): boolean {
  const review = data.preReview;
  return Boolean(review && typeof review === 'object' && !Array.isArray(review) && (review as Record<string, Json>).approved === true);
}

/**
 * Open human checks in one conversation that are waiting for the master's look.
 *
 * Scoped by conversation, not by a task id, because the check belongs to whichever graph
 * task raised it - a different task from the conversation's anchor. Taking a task id here
 * invited exactly one mistake: passing the anchor and silently getting nothing back.
 *
 * A check that has already been approved is not listed: the master reviewed it, and
 * listing it again is how the same check gets reviewed twice.
 */
export function pendingHumanChecks(store: TaskStore, conversationId: string) {
  const rows = store.db.prepare(`SELECT q.id,q.task_id,q.node_id,q.data FROM questions q
    JOIN tasks t ON t.id=q.task_id
    WHERE t.conversation_id=? AND q.kind='human_check' AND q.status='open' ORDER BY q.rowid`)
    .all(conversationId) as { id: string; task_id: string; node_id: string; data: string }[];
  return rows
    .filter(row => !isPreApproved(JSON.parse(row.data) as Record<string, Json>))
    .map(row => ({ questionId: row.id, taskId: row.task_id, nodeId: row.node_id }));
}

/**
 * Record the master's approval of a human check.
 *
 * Approving is **not** acceptance. The check stays open and stays the user's to answer,
 * because acceptance is the person's own judgement and a machine that signs for them
 * makes "human acceptance" a name for something it is not. What changes is that the
 * master's look is now a durable, visible fact, so an unapproved check is one nobody has
 * examined rather than one nobody mentioned.
 *
 * Idempotent: approving an already-approved check writes nothing and returns false, so a
 * retried command cannot manufacture a second approval.
 */
export function approveHumanCheck(store: TaskStore, questionId: string, note: string): boolean {
  const apply = () => {
    const row = store.db.prepare("SELECT task_id,node_id,data FROM questions WHERE id=? AND kind='human_check' AND status='open'")
      .get(questionId) as { task_id: string; node_id: string; data: string } | undefined;
    if (!row) return false;
    const data = JSON.parse(row.data) as Record<string, Json>;
    if (isPreApproved(data)) return false;
    store.db.prepare('UPDATE questions SET data=? WHERE id=?')
      .run(canonicalJson({ ...data, preReview: { approved: true, note } }), questionId);
    store.event(row.task_id, 'human.prereview_approved', { questionId, nodeId: row.node_id, note });
    return true;
  };
  return store.db.isTransaction ? apply() : store.transaction(apply);
}
