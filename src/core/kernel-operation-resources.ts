import type { KernelStore } from './kernel-store.ts';
import { hasProcessQuiescence, type ProcessQuiescenceReceipt } from './process-quiescence.ts';

/** Releasing resources says nothing about whether an interrupted operation succeeded. */
export function reconcileOperationResources(kernel: KernelStore, operationId?: string): void {
  kernel.moduleTransaction(() => {
    const rows = kernel.db.prepare(`SELECT id,task_id,resource_receipt FROM kernel_module_operations
      WHERE worker_active=1 AND resource_receipt IS NOT NULL AND state IN ('dispatched','uncertain','failed')
      ${operationId === undefined ? '' : 'AND id=?'}`).all(...(operationId === undefined ? [] : [operationId])) as
      { id: string; task_id: string; resource_receipt: string }[];
    for (const row of rows) {
      let receipt: ProcessQuiescenceReceipt;
      try { receipt = JSON.parse(row.resource_receipt); } catch { continue; }
      if (!receipt || typeof receipt.path !== 'string' || typeof receipt.nonce !== 'string' || !hasProcessQuiescence(receipt)) continue;
      const changed = kernel.db.prepare('UPDATE kernel_module_operations SET worker_active=0 WHERE id=? AND worker_active=1').run(row.id);
      if (changed.changes) kernel.store.event(row.task_id, 'graph.operation.resources_released', { operationId: row.id, source: 'supervisor' });
    }
  });
}
