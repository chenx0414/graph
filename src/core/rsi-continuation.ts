import type { TaskStore } from './store.ts';
import type { Operation } from './types.ts';

export interface RsiContinuation { requestId: string; operationId: string; commit: string }

/** Called in the transaction that records the RSI receipt. */
export function awaitRsiReload(store: TaskStore, requestId: string, operationId: string, commit: string) {
  store.db.prepare(`INSERT OR IGNORE INTO rsi_continuations(request_id,operation_id,task_id,node_id,commit_sha,state)
    SELECT ?,o.id,o.task_id,o.node_id,?,'waiting' FROM operations o JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
    WHERE o.id=? AND json_extract(n.spec,'$.role')='master'`).run(requestId, commit, operationId);
}

/** Confirmation and the durable wake-up are committed together. */
export function confirmRsiContinuation(store: TaskStore, requestId: string) {
  const row = store.db.prepare(`SELECT r.task_id,r.node_id,t.phase,c.archived_at
    FROM rsi_continuations r JOIN tasks t ON t.id=r.task_id JOIN conversations c ON c.anchor_task_id=t.id
    WHERE r.request_id=? AND r.state='waiting'`).get(requestId) as { task_id: string; node_id: string; phase: string; archived_at: number | null } | undefined;
  if (!row) return;
  const eligible = row.phase === 'chatting' && row.archived_at === null;
  store.db.prepare('UPDATE rsi_continuations SET state=? WHERE request_id=?').run(eligible ? 'ready' : 'cancelled', requestId);
  if (!eligible) return;
  store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=? AND status='succeeded'").run(row.task_id, row.node_id);
  store.event(row.task_id, 'rsi.continuation_ready', { requestId, nodeId: row.node_id });
}

export function pendingRsiContinuation(store: TaskStore, taskId: string, nodeId: string): RsiContinuation | undefined {
  return store.db.prepare(`SELECT request_id AS requestId,operation_id AS operationId,commit_sha AS "commit"
    FROM rsi_continuations WHERE task_id=? AND node_id=? AND state='ready' ORDER BY rowid LIMIT 1`)
    .get(taskId, nodeId) as RsiContinuation | undefined;
}

/** Bind the wake-up to the same durable operation that consumes queued messages. */
export function consumeRsiContinuation(store: TaskStore, operation: Operation) {
  const continuation = operation.context.rsiContinuation;
  if (!continuation) return;
  store.db.prepare("UPDATE rsi_continuations SET state='consumed',resumed_operation_id=? WHERE request_id=? AND state='ready'")
    .run(operation.id, continuation.requestId);
  store.event(operation.taskId, 'rsi.continuation_claimed', { requestId: continuation.requestId, operationId: operation.id });
}

/** Preparation/recovery may release an intent without dispatching it. */
export function releaseRsiContinuation(store: TaskStore, operationId: string) {
  store.db.prepare("UPDATE rsi_continuations SET state='ready',resumed_operation_id=NULL WHERE resumed_operation_id=? AND state='consumed'").run(operationId);
}
