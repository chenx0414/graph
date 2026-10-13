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
    // Agent execution and input ownership remain with durable checkpoints.
    // This pass only reconciles Graph provider/module dispatch receipts.
    return interruptedOperations.length;
  });
}
