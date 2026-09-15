/**
 * Pause / user-wait ledger (C02, schema v19).
 *
 * The counters mirror the credential-slot pattern already used on operations
 * (`waiting_since` / `waiting_ms`): a boundary opens a `*_since` stamp and the
 * matching boundary accumulates the elapsed milliseconds. History that has no
 * recorded boundary stays NULL so the projection can honestly say
 * "未记录" instead of inventing a duration from message timestamps.
 */
import type { TaskStore } from './store.ts';

/** Terminal nodes never open a new pause/wait segment. */
const TERMINAL = "('succeeded','skipped','retired','failed')";

export function openPause(store: TaskStore, taskId: string, now = Date.now()) {
  store.db.prepare(`UPDATE nodes SET pause_since=? WHERE task_id=? AND pause_since IS NULL AND status NOT IN ${TERMINAL}`).run(now, taskId);
}

export function closePause(store: TaskStore, taskId: string, now = Date.now()) {
  store.db.prepare(`UPDATE nodes SET pause_ms=COALESCE(pause_ms,0)+(?-pause_since), pause_since=NULL
    WHERE task_id=? AND pause_since IS NOT NULL AND ? >= pause_since`).run(now, taskId, now);
}

export function openUserWait(store: TaskStore, taskId: string, nodeId: string, now = Date.now()) {
  store.db.prepare('UPDATE nodes SET user_wait_since=? WHERE task_id=? AND id=? AND user_wait_since IS NULL').run(now, taskId, nodeId);
}

export function closeUserWait(store: TaskStore, taskId: string, nodeId: string, now = Date.now()) {
  store.db.prepare(`UPDATE nodes SET user_wait_ms=COALESCE(user_wait_ms,0)+(?-user_wait_since), user_wait_since=NULL
    WHERE task_id=? AND id=? AND user_wait_since IS NOT NULL AND ? >= user_wait_since`).run(now, taskId, nodeId, now);
}

/** Close the wait segment belonging to one operation; used when a question is
 * resolved through an operation-scoped update. */
export function closeUserWaitForOperation(store: TaskStore, operationId: string, now = Date.now()) {
  const operation = store.db.prepare('SELECT task_id,node_id FROM operations WHERE id=?').get(operationId) as { task_id: string; node_id: string } | undefined;
  if (operation) closeUserWait(store, operation.task_id, operation.node_id, now);
}

export interface NodeTimeLedger {
  /** Undefined means "never recorded" (historical rows); a number is a real total. */
  pauseMs: number | undefined;
  userWaitMs: number | undefined;
}

/** Ledger view for one node including a still-open segment. A terminal node
 * reports only the accumulated value: an open stamp is not extended forever. */
export function nodeTimeLedger(store: TaskStore, taskId: string, nodeId: string, now = Date.now()): NodeTimeLedger {
  const row = store.db.prepare('SELECT status,pause_ms,pause_since,user_wait_ms,user_wait_since FROM nodes WHERE task_id=? AND id=?')
    .get(taskId, nodeId) as { status: string; pause_ms: number | null; pause_since: number | null; user_wait_ms: number | null; user_wait_since: number | null } | undefined;
  if (!row) return { pauseMs: undefined, userWaitMs: undefined };
  const terminal = ['succeeded', 'skipped', 'retired', 'failed'].includes(row.status);
  const live = (since: number | null) => (since !== null && !terminal ? Math.max(0, now - since) : 0);
  const pauseRecorded = row.pause_ms !== null || row.pause_since !== null;
  const userRecorded = row.user_wait_ms !== null || row.user_wait_since !== null;
  return {
    pauseMs: pauseRecorded ? (row.pause_ms ?? 0) + live(row.pause_since) : undefined,
    userWaitMs: userRecorded ? (row.user_wait_ms ?? 0) + live(row.user_wait_since) : undefined,
  };
}
