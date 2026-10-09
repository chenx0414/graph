import { reconcileOperationResources } from './kernel-operation-resources.ts';
import { wakeForBlockedNode } from './wake-ledger.ts';
import type { KernelStore } from './kernel-store.ts';

/** Called once, after acquiring the runtime owner lock; never during a live tick. */
export function recoverKernelExecutions(kernel: KernelStore): number {
  return kernel.moduleTransaction(() => {
    reconcileOperationResources(kernel);
    // A prepared operation never crossed its send boundary; only its unused lease is safe to release.
    kernel.db.prepare("UPDATE kernel_module_operations SET worker_active=0 WHERE state='prepared'").run();
    kernel.db.prepare("UPDATE kernel_provider_calls SET state='unknown' WHERE state='inflight'").run();
    const interruptedOperations = kernel.db.prepare("SELECT id,task_id,module_id,delivery_id FROM kernel_module_operations WHERE state='dispatched'").all() as { id: string; task_id: string; module_id: string; delivery_id: string }[];
    for (const operation of interruptedOperations) {
      kernel.db.prepare("UPDATE kernel_module_operations SET state='uncertain',error='Runtime interrupted after dispatch' WHERE id=?").run(operation.id);
      kernel.setNodeQueuePaused(operation.task_id, operation.module_id, true);
      kernel.db.prepare("UPDATE tasks SET phase='blocked' WHERE id=? AND phase NOT IN ('stopping','stopped','completed')").run(operation.task_id);
      wakeForBlockedNode(kernel.store, operation.task_id, { nodeId: operation.module_id, incidentId: operation.id, reason: 'Host operation interrupted after dispatch; inspect side effects before resuming' });
      kernel.store.event(operation.task_id, 'graph.operation.interrupted', { operationId: operation.id, moduleId: operation.module_id, deliveryId: operation.delivery_id });
    }
    const rows = kernel.db.prepare("SELECT id,task_id,node_id,submission_id,token_reservation FROM kernel_executions WHERE state='running'").all() as {
      id: string; task_id: string; node_id: string; submission_id: string | null; token_reservation: number;
    }[];
    for (const row of rows) {
      // Calls are journaled before sending. With no unresolved call, this turn's
      // unused hold is safe to release; a resumed turn will reserve afresh.
      const unresolvedCall = kernel.db.prepare("SELECT 1 FROM kernel_provider_calls WHERE execution_id=? AND state IN ('inflight','unknown') LIMIT 1").get(row.id);
      if (row.token_reservation > 0 && !unresolvedCall) {
        kernel.db.prepare('UPDATE kernel_node_state SET reserved=MAX(0,reserved-?) WHERE task_id=? AND node_id=?')
          .run(row.token_reservation, row.task_id, row.node_id);
        kernel.db.prepare('UPDATE kernel_executions SET token_reservation=0 WHERE id=?').run(row.id);
      }
      const reason = row.submission_id ? 'Runtime interrupted after submit; output is retained. Handle remaining work without resending.'
        : 'Runtime interrupted; input and attempt counters retained. Check side effects and reconcile unknown usage before resuming.';
      // The process died without a closing boundary. Do not charge owner downtime
      // as work or pretend the execution's full duration was measured.
      kernel.db.prepare("UPDATE kernel_executions SET state=?,waiting_slot=0,ended_at=?,run_ms=NULL,waiting_ms=NULL,run_since=NULL,waiting_since=NULL WHERE id=?")
        .run(row.submission_id ? 'failed' : 'blocked', Date.now(), row.id);
      kernel.db.prepare("UPDATE kernel_queue SET state=?,reason=? WHERE task_id=? AND node_id=? AND state='claimed'")
        .run(row.submission_id ? 'failed' : 'queued', reason, row.task_id, row.node_id);
      kernel.setNodeQueuePaused(row.task_id, row.node_id, true);
      kernel.db.prepare("UPDATE kernel_nodes SET status='blocked' WHERE task_id=? AND node_id=?").run(row.task_id, row.node_id);
      kernel.db.prepare("UPDATE tasks SET phase='blocked' WHERE id=? AND phase NOT IN ('stopping','stopped','completed')").run(row.task_id);
      kernel.store.event(row.task_id, 'graph.execution.interrupted', { executionId: row.id, nodeId: row.node_id, submitted: Boolean(row.submission_id), reason });
    }
    return rows.length + interruptedOperations.length;
  });
}
