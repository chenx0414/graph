import type { TaskStore } from './store.ts';

export interface PauseContinuation { requestId: string; operationId: string }

/**
 * Durable "continue the turn I just soft-stopped" intent, recorded in the very
 * transaction that marks the task paused. It mirrors the RSI reload wake-up:
 * `waiting` (pause requested) -> `ready` (resume requested) -> `consumed` (the
 * continuation turn actually ran). Only a live master turn is remembered; an
 * idle task has no unfinished turn to continue.
 */
export function awaitPauseContinuation(store: TaskStore, requestId: string, taskId: string, operationId: string): boolean {
  const master = store.db.prepare(`SELECT o.node_id FROM operations o
    JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
    WHERE o.id=? AND o.task_id=? AND json_extract(n.spec,'$.role')='master'`).get(operationId, taskId) as { node_id: string } | undefined;
  if (!master) return false;
  // At most one live intent per master node: a repeated pause supersedes the
  // previous waiting row instead of queuing a second resume.
  store.db.prepare("DELETE FROM pause_continuations WHERE task_id=? AND node_id=? AND state='waiting'").run(taskId, master.node_id);
  store.db.prepare(`INSERT INTO pause_continuations(request_id,operation_id,task_id,node_id,state) VALUES(?,?,?,?,'waiting')`)
    .run(requestId, operationId, taskId, master.node_id);
  return true;
}

/** Resume turns every waiting intent into a dispatchable wake-up and puts the
 * master node back on the ready queue. Idempotent: only `waiting` rows move. */
export function resumePauseContinuations(store: TaskStore, taskId: string) {
  const rows = store.db.prepare("SELECT request_id AS requestId,node_id AS nodeId FROM pause_continuations WHERE task_id=? AND state='waiting' ORDER BY rowid")
    .all(taskId) as { requestId: string; nodeId: string }[];
  for (const row of rows) {
    store.db.prepare("UPDATE pause_continuations SET state='ready' WHERE request_id=? AND state='waiting'").run(row.requestId);
    store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id=? AND status='succeeded'").run(taskId, row.nodeId);
    store.event(taskId, 'pause.continuation_ready', { requestId: row.requestId, nodeId: row.nodeId });
  }
  return rows;
}

export function pendingPauseContinuation(store: TaskStore, taskId: string, nodeId: string): PauseContinuation | undefined {
  return store.db.prepare(`SELECT request_id AS requestId,operation_id AS operationId
    FROM pause_continuations WHERE task_id=? AND node_id=? AND state='ready' ORDER BY rowid LIMIT 1`)
    .get(taskId, nodeId) as PauseContinuation | undefined;
}

/** Bind every ready intent of the node to the operation that continues it, so
 * the wake-up is consumed exactly once. No-op when the dispatch was not a
 * resumed pause (for example a fresh queued message). */
export function consumePauseContinuation(store: TaskStore, taskId: string, nodeId: string, operationId: string): boolean {
  const changed = store.db.prepare("UPDATE pause_continuations SET state='consumed',resumed_operation_id=? WHERE task_id=? AND node_id=? AND state='ready'")
    .run(operationId, taskId, nodeId);
  if (changed.changes > 0) store.event(taskId, 'pause.continuation_claimed', { operationId, nodeId });
  return changed.changes > 0;
}
