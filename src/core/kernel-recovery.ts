import type { KernelStore } from './kernel-store.ts';

/** Called once, after acquiring the runtime owner lock; never during a live tick. */
export function recoverKernelExecutions(kernel: KernelStore): number {
  return kernel.moduleTransaction(() => {
    kernel.db.prepare("UPDATE kernel_provider_calls SET state='unknown' WHERE state='inflight'").run();
    const rows = kernel.db.prepare("SELECT id,task_id,node_id,submission_id FROM kernel_executions WHERE state='running'").all() as {
      id: string; task_id: string; node_id: string; submission_id: string | null;
    }[];
    for (const row of rows) {
      const reason = row.submission_id ? 'Runtime interrupted after submit; output is retained. Handle remaining work without resending.'
        : 'Runtime interrupted; input and attempt counters retained. Check side effects and reconcile unknown usage before resuming.';
      kernel.db.prepare("UPDATE kernel_executions SET state=?,waiting_slot=0,ended_at=? WHERE id=?")
        .run(row.submission_id ? 'failed' : 'blocked', Date.now(), row.id);
      kernel.db.prepare("UPDATE kernel_queue SET state=?,reason=? WHERE task_id=? AND node_id=? AND state='claimed'")
        .run(row.submission_id ? 'failed' : 'queued', reason, row.task_id, row.node_id);
      kernel.setNodeQueuePaused(row.task_id, row.node_id, true);
      kernel.db.prepare("UPDATE kernel_nodes SET status='blocked' WHERE task_id=? AND node_id=?").run(row.task_id, row.node_id);
      kernel.db.prepare("UPDATE tasks SET phase='blocked' WHERE id=? AND phase NOT IN ('stopping','stopped','completed')").run(row.task_id);
      kernel.store.event(row.task_id, 'graph.execution.interrupted', { executionId: row.id, nodeId: row.node_id, submitted: Boolean(row.submission_id), reason });
    }
    return rows.length;
  });
}
