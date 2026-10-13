import type { KernelStore } from '../core/kernel-store.ts';
import { RuntimeError } from '../core/types.ts';
import type { SendGate } from './controlled-openai.ts';

/** Admit host tools against the running execution; tool usage is distinct from provider usage. */
export function kernelToolGate(kernel: KernelStore, graphId: string, nodeId: string,
  kind: 'tool' | 'retrieval', closing: () => boolean): SendGate {
  return {
    dispatch(id, reservation, send) {
      if (!Number.isSafeInteger(reservation) || reservation < 0) throw new RuntimeError('budget', 'Invalid tool reservation');
      const execution = kernel.db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running'").get(graphId, nodeId) as { id: string } | undefined;
      const task = kernel.store.task(graphId);
      // Capability loading may dispatch before a node's first model attempt.
      // A new node has no usage or pause yet; the execution remains mandatory.
      const row = kernel.db.prepare('SELECT used,paused FROM kernel_node_state WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { used: number; paused: number } | undefined;
      const state = row ?? { used: 0, paused: 0 };
      if (!execution || closing() || task.paused || state.paused || ['stopping', 'stopped', 'completed'].includes(task.phase)) throw new RuntimeError('paused', 'Node tool dispatch is closed');
      const budget = kernel.execution(execution.id)?.tokenBudget;
      const calls = kernel.db.prepare("SELECT state,reserved FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state IN ('inflight','unknown')").all(graphId, nodeId) as { state: string; reserved: number }[];
      if (budget && !budget.unlimited && (state.used >= budget.budget || state.used + reservation + calls.reduce((sum, call) => sum + call.reserved, 0) > budget.budget)) throw new RuntimeError('budget', 'Node budget is exhausted');
      if (calls.some(call => call.state === 'unknown') && !budget?.unlimited) throw new RuntimeError('budget', 'Node usage must be reconciled before tool dispatch');
      kernel.store.event(graphId, `graph.${kind}.started`, { nodeId, executionId: execution.id, invocationId: id });
      return send();
    },
    settle(id, usage) { kernel.store.event(graphId, `graph.${kind}.settled`, { nodeId, invocationId: id, usage }); },
  };
}
