import type { Json } from './types.ts';
import type { TaskStore } from './store.ts';

/**
 * Why the master of a conversation is being woken.
 *
 * Every one of these is a fact that leaves the graph unable to move on its own
 * while nobody is looking at it: a node stuck on a problem, a graph that has
 * finished, a queued turn to continue after an answer. The master is the only
 * actor holding the conversation's context, so it is the one that has to be told.
 */
export type WakeKind = 'node_blocked' | 'task_completed' | 'answer' | 'waiting' | 'human_check' | 'graph_output' | 'peer_message' | 'task_stopped' | 'acceptance_blocked' | 'graph_ready';

export interface WakeIntent {
  taskId: string;
  kind: WakeKind;
  /**
   * What makes this fact *this* fact.
   *
   * The pair (kind, dedupeKey) is the identity of a wake, so the same fact
   * observed twice collapses into one row while two genuinely different facts
   * of the same kind stay apart. Callers pass the most specific stable key they
   * have - a node and why it stopped, a question id - not a timestamp.
   */
  dedupeKey: string;
  data?: Json;
}

export interface PendingWake {
  id: number;
  taskId: string;
  kind: WakeKind;
  dedupeKey: string;
  data: string | null;
}

/**
 * Record one wake for the conversation's master and make it dispatchable.
 *
 * This is the single delivery path for "the graph needs the master". It exists
 * because the same fact can be observed from several places - a task completing,
 * a node blocking, a question being answered - and each place reaching for the
 * node status itself is how a wake gets delivered twice, or not at all.
 *
 * Idempotence is a property of the table, not of the caller: the primary key is
 * (task_id, node_id, kind, dedupe_key), and the insert is INSERT OR IGNORE, so
 * running this a hundred times for one fact leaves exactly one row and one
 * ready transition. A second fact of the same kind is a second row by design.
 *
 * The recorded intent belongs to the conversation's anchor task, because that is
 * the task whose master node the wake is for; `intent.taskId` is the task the
 * fact happened in, which may be a different graph task in the same conversation.
 *
 * The master is only woken for a conversation it still serves: a chatting,
 * unarchived conversation whose anchor task owns that master node. Anything
 * else (a finished conversation, a graph task with no conversation) records
 * nothing, because there is no master to wake and an intent nobody can consume
 * would keep a dead conversation looking alive.
 */
export function wakeMaster(store: TaskStore, intent: WakeIntent): boolean {
  const apply = () => {
    const row = store.db.prepare(`SELECT c.id AS conversation_id,c.anchor_task_id,c.archived_at,m.id AS master_id
      FROM tasks t
      JOIN conversations c ON c.id=t.conversation_id
      JOIN nodes m ON m.task_id=c.anchor_task_id AND json_extract(m.spec,'$.role')='master'
      JOIN tasks a ON a.id=c.anchor_task_id
      WHERE t.id=?`).get(intent.taskId) as
      { conversation_id: string; anchor_task_id: string; archived_at: number | null; master_id: string } | undefined;
    if (!row || row.archived_at !== null) return false;
    const anchor = store.task(row.anchor_task_id);
    if (anchor.phase !== 'chatting') return false;

    // The intent belongs to the task that owns the master - the conversation's
    // anchor - not to the task the fact happened in. They are the same row to
    // read back, and the wake is delivered by the anchor's turn.
    const anchorTaskId = row.anchor_task_id;
    const inserted = store.db.prepare(`INSERT OR IGNORE INTO wake_intents(task_id,node_id,kind,dedupe_key,data,state)
      VALUES(?,?,?,?,?,'waiting')`)
      .run(anchorTaskId, row.master_id, intent.kind, intent.dedupeKey, intent.data === undefined ? null : JSON.stringify(intent.data));
    // Already known: it is either waiting to be delivered, or was delivered and
    // acted on. Either way this observation adds nothing.
    if (inserted.changes === 0) return false;

    const promoted = store.db.prepare("UPDATE wake_intents SET state='ready' WHERE task_id=? AND node_id=? AND kind=? AND dedupe_key=? AND state='waiting'")
      .run(anchorTaskId, row.master_id, intent.kind, intent.dedupeKey).changes;
    if (promoted === 0) return false;
    // The master may be sitting at 'succeeded' with nothing to do; a ready wake
    // is exactly the reason to give it one more turn.
    store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=? AND status='succeeded'")
      .run(row.anchor_task_id, row.master_id);
    store.event(anchorTaskId, 'wake.ready', {
      kind: intent.kind, dedupeKey: intent.dedupeKey, taskId: intent.taskId, nodeId: row.master_id,
    });
    return true;
  };
  return store.db.isTransaction ? apply() : store.transaction(apply);
}

/** A node stopped and cannot continue until someone acts on why. */
export function wakeForBlockedNode(store: TaskStore, taskId: string, block: { nodeId: string; reason: string; incidentId?: string }) {
  return wakeMaster(store, {
    taskId,
    kind: 'node_blocked',
    // The task, the node and the kind of block are all part of the fact: two tasks
    // in one conversation can both own a node called "build", and "waiting for a
    // permission" is a different thing to act on than "failed to execute".
    dedupeKey: `${taskId}:${block.nodeId}:${block.incidentId ?? block.reason}`,
    data: { ...block, graphId: taskId },
  });
}

/**
 * A human acceptance check opened and the master should look at it before the user does.
 *
 * This is review, not acceptance: the master can send it back through rework so a check
 * that should never have been raised never interrupts the person. The approval itself is
 * recorded on the question by approveHumanCheck, and the person still has to pass it.
 */
export function wakeForHumanCheck(store: TaskStore, taskId: string, data: { nodeId: string; questionId: string } & Json) {
  return wakeMaster(store, { taskId, kind: 'human_check', dedupeKey: data.questionId, data });
}

/** A graph reached its end, so the conversation needs a summary and a handback. */
export function wakeForTaskCompleted(store: TaskStore, taskId: string, data: Json) {
  return wakeMaster(store, { taskId, kind: 'task_completed', dedupeKey: `${taskId}:completed`,
    data: { ...(data && typeof data === 'object' && !Array.isArray(data) ? data : { outcome: data }), graphId: taskId } });
}

/** The user answered something the master has to act on so the graph can move. */
export function wakeForAnswer(store: TaskStore, taskId: string, data: { questionId: string } & Json) {
  return wakeMaster(store, { taskId, kind: 'answer', dedupeKey: data.questionId, data });
}

/** A lane parked itself on a question the master owns; it needs the master's decision. */
export function wakeForWaiting(store: TaskStore, taskId: string, data: { nodeId: string; questionId: string } & Json) {
  return wakeMaster(store, { taskId, kind: 'waiting', dedupeKey: data.questionId, data });
}

/** Wakes that are ready for this node right now, oldest first. */
export function pendingWakes(store: TaskStore, taskId: string, nodeId: string): PendingWake[] {
  return store.db.prepare(`SELECT id,task_id AS taskId,kind,dedupe_key AS dedupeKey,data
    FROM wake_intents WHERE task_id=? AND node_id=? AND state='ready' ORDER BY id`)
    .all(taskId, nodeId) as unknown as PendingWake[];
}

/**
 * Mark every ready wake of this node as delivered by the given operation.
 *
 * Called with the operation that is about to carry them, so a crash between the
 * update and the dispatch leaves them consumable rather than lost: the
 * operation either consumed them or it did not exist.
 */
export function consumeWakes(store: TaskStore, taskId: string, nodeId: string, operationId: string) {
  return store.db.prepare("UPDATE wake_intents SET state='consumed',consumed_operation_id=? WHERE task_id=? AND node_id=? AND state='ready'")
    .run(operationId, taskId, nodeId).changes;
}

/**
 * Put consumed wakes back when the turn they were bound to never dispatched.
 *
 * Preparation and recovery can release an intent without running it. Leaving it
 * consumed would silently drop the reason the master was woken at all.
 */
export function releaseWakes(store: TaskStore, operationId: string) {
  return store.db.prepare("UPDATE wake_intents SET state='ready',consumed_operation_id=NULL WHERE consumed_operation_id=? AND state='consumed'")
    .run(operationId).changes;
}

/**
 * What the master is told about why it is awake.
 *
 * A wake with no explanation would make the master read the whole graph to find out
 * what changed. Naming the fact - and, for a block, what stopped - lets it go straight
 * to the thing that needs a decision. One line per fact, oldest first.
 */
export function renderWakes(wakes: PendingWake[]): string {
  const lines = wakes.map(wake => {
    const data = wake.data ? JSON.parse(wake.data) as Record<string, Json> : {};
    if (wake.kind === 'task_completed') {
      return `- Graph ${String(data.graphId ?? wake.dedupeKey)} finished (phase ${String(data.phase ?? 'completed')}${data.integrationSha ? `, integration ${String(data.integrationSha).slice(0, 12)}` : ''}). Read its outcome and report it to the user; nothing else is waiting on it.`;
    }
    if (wake.kind === 'graph_ready') return `- Graph ${String(data.graphId)} is ready and awaits explicit input. Read graph_inspect revision, select the intended named input and use graph_send with a value satisfying its protocol. Confirmation did not enqueue any task.`;
    if (wake.kind === 'graph_output') {
      return `- Graph ${String(data.graphId)} published output ${String(data.output)} (result ${String(data.resultId)}). Read graph_inspect results for its exact business value.`;
    }
    if (wake.kind === 'acceptance_blocked') return `- Graph ${String(data.graphId)} is waiting for final evidence or Git delivery. Read graph_inspect acceptance and the delivery timeline; preserve the confirmed criteria and exact reviewed commit.`;
    if (wake.kind === 'peer_message') {
      return `- Agent ${String(data.nodeId)} in graph ${String(data.graphId)} sent you a message. Read the pending conversation message and reply if needed.`;
    }
    if (wake.kind === 'task_stopped') return `- Graph ${String(data.graphId)} stopped; its remaining work was cancelled.`;
    if (wake.kind === 'node_blocked') {
      return `- Node ${String(data.nodeId ?? wake.dedupeKey)}${data.graphId ? ` in graph ${String(data.graphId)}` : ''} needs your intervention (${String(data.reason ?? 'blocked')}). Inspect its execution and decide whether to retry, skip, or change configuration; escalate only decisions that require the user.`;
    }
    if (wake.kind === 'answer') {
      return `- The user answered ${String(data.kind ?? 'a question')} on node ${String(data.nodeId ?? '?')}. Act on it so the graph can move on.`;
    }
    if (wake.kind === 'waiting') {
      return `- Node ${String(data.nodeId ?? '?')} is waiting on a decision only you can make.`;
    }
    if (wake.kind === 'human_check') {
      return `- A human acceptance check opened on node ${String(data.nodeId ?? '?')} and the user has not seen it yet. Look at the evidence: if it should not have been raised, send it back for rework; if it looks right, approve it so the user is asked with your review attached. Approving is not acceptance - the user still has to pass it themselves.`;
    }
    return `- Graph event: ${wake.kind} (${wake.dedupeKey}).`;
  });
  return [
    'You were woken by the harness, not by the user: these facts happened while no turn was running.',
    ...lines,
  ].join('\n');
}
