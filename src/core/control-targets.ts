import type { TaskStore } from './store.ts';

/**
 * The operation a steering message must reach: steering targets the turn that is
 * actually running on a node, never a node name, so an idle node refuses instead
 * of silently queueing text nobody will read.
 */
export function activeOperationForNode(store: TaskStore, taskId: string, nodeId: string): { id: string } | undefined {
  return store.db.prepare(`SELECT id FROM operations
    WHERE task_id=? AND node_id=? AND state='dispatched' AND worker_active=1
    ORDER BY rowid DESC LIMIT 1`).get(taskId, nodeId) as { id: string } | undefined;
}
