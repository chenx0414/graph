import { randomUUID } from 'node:crypto';
import type { TaskStore } from './store.ts';
import { unknownUsageIsNonBlocking } from './budget-ledger.ts';

/** External main retains its activation identity and budget locks outside native graphs. */
export function createActivation(store: TaskStore, taskId: string, nodeId: string, graphVersion: number, round = 1) {
  const id = randomUUID();
  store.db.prepare("INSERT INTO activations(id,task_id,node_id,graph_version,round,state,input_versions) VALUES(?,?,?,?,?,'pending','{}')").run(id, taskId, nodeId, graphVersion, round);
  store.db.prepare('UPDATE nodes SET activation_id=? WHERE task_id=? AND id=?').run(id, taskId, nodeId);
  return id;
}

export function hasLockedQuestion(store: TaskStore, taskId: string, nodeId: string) {
  const node = store.db.prepare('SELECT instance_id FROM nodes WHERE task_id=? AND id=?')
    .get(taskId, nodeId) as { instance_id: string | null } | undefined;
  const kinds = unknownUsageIsNonBlocking(store, node?.instance_id)
    ? "kind IN ('budget','reservation_exceeded','permission')"
    : "kind IN ('budget','unknown_usage','reservation_exceeded','permission')";
  return Boolean(store.db.prepare(`SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open' AND ${kinds}`).get(taskId, nodeId));
}
