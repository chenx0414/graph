import { modelIdentity, type ModelEntry } from '../catalog/models.ts';
import type { KernelStore } from '../core/kernel-store.ts';
import { RuntimeError } from '../core/types.ts';
import type { SendGate } from './controlled-openai.ts';
import { tokenUsageTotal, type TokenUsage } from './call-broker.ts';

/** Provider sends are admitted and charged by the host, independently of Pi turn boundaries. */
export function kernelProviderGate(kernel: KernelStore, graphId: string, nodeId: string,
  limit?: { budget: number; unlimited: boolean }, model?: ModelEntry, recipe?: { definition: string; review: boolean }): SendGate {
  return {
    dispatch(id, reservation, send) {
      if (!Number.isSafeInteger(reservation) || reservation < 0) throw new RuntimeError('budget', 'Invalid provider reservation');
      kernel.store.transaction(() => {
        const execution = kernel.db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1").get(graphId, nodeId) as { id: string } | undefined;
        if (!execution) throw new RuntimeError('invalid_adapter', 'Provider send has no active execution');
        const frozenLimit = kernel.execution(execution.id)?.tokenBudget ?? limit;
        const state = kernel.db.prepare('SELECT used,paused FROM kernel_node_state WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { used: number; paused: number };
        const task = kernel.store.task(graphId);
        if (state.paused || task.paused || ['stopping', 'stopped', 'completed'].includes(task.phase)) throw new RuntimeError('paused', 'Provider send is paused');
        const calls = kernel.db.prepare("SELECT state,reserved FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state IN ('inflight','unknown')").all(graphId, nodeId) as { state: string; reserved: number }[];
        if (frozenLimit?.unlimited !== true && calls.some(call => call.state === 'unknown')) throw new RuntimeError('budget', 'Reconcile unknown provider usage before another send');
        const reserved = calls.reduce((total, call) => total + call.reserved, 0);
        if (frozenLimit && !frozenLimit.unlimited && state.used + reserved + reservation > frozenLimit.budget) throw new RuntimeError('budget', `Token budget exhausted for node ${nodeId}`);
        kernel.db.prepare('INSERT INTO kernel_provider_calls(id,task_id,node_id,execution_id,reserved,state,created_at,model) VALUES(?,?,?,?,?,?,?,?)')
          .run(id, graphId, nodeId, execution.id, reservation, 'inflight', Date.now(), model ? JSON.stringify({ id: model.id, identity: modelIdentity(model), provider: model.provider, api: model.api, baseUrl: model.baseUrl, ...(recipe ? { recipe } : {}) }) : null);
      });
      return send();
    },
    settle(id, usage: TokenUsage | null) {
      kernel.store.transaction(() => {
        const call = kernel.db.prepare('SELECT state FROM kernel_provider_calls WHERE id=? AND task_id=? AND node_id=?').get(id, graphId, nodeId) as { state: string } | undefined;
        if (!call || call.state !== 'inflight') throw new RuntimeError('invalid_adapter', 'Provider call is absent or already settled');
        if (usage && Object.values({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }).some(value => !Number.isSafeInteger(value) || value < 0)) throw new RuntimeError('invalid_adapter', 'Invalid provider usage');
        kernel.db.prepare('UPDATE kernel_provider_calls SET state=?,usage=?,settled_at=? WHERE id=?')
          .run(usage ? 'settled' : 'unknown', usage ? JSON.stringify(usage) : null, Date.now(), id);
        if (usage) kernel.db.prepare('UPDATE kernel_node_state SET used=used+? WHERE task_id=? AND node_id=?').run(tokenUsageTotal(usage), graphId, nodeId);
        kernel.store.event(graphId, 'graph.provider.settled', { nodeId, callId: id, usage });
      });
    },
  };
}


/** Main-agent reconciliation is explicit and idempotent; it never resumes a node. */
export function reconcileKernelUsage(kernel: KernelStore, graphId: string, callId: string, usage: TokenUsage) {
  const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) throw new RuntimeError('invalid_input', 'Reconciliation requires non-negative token counts');
  return kernel.store.transaction(() => {
    const call = kernel.db.prepare('SELECT node_id,state,usage FROM kernel_provider_calls WHERE task_id=? AND id=?').get(graphId, callId) as { node_id: string; state: string; usage: string | null } | undefined;
    if (!call) throw new RuntimeError('invalid_input', 'Unknown provider call');
    if (call.state === 'reconciled') {
      if (call.usage !== JSON.stringify(usage)) throw new RuntimeError('invalid_input', 'Provider usage was already reconciled differently');
      return { replayed: true, nodeId: call.node_id };
    }
    if (call.state !== 'unknown') throw new RuntimeError('invalid_input', 'Only unknown usage can be reconciled');
    kernel.db.prepare("UPDATE kernel_provider_calls SET state='reconciled',usage=?,settled_at=? WHERE id=?").run(JSON.stringify(usage), Date.now(), callId);
    kernel.db.prepare('UPDATE kernel_node_state SET used=used+? WHERE task_id=? AND node_id=?').run(tokenUsageTotal(usage), graphId, call.node_id);
    const pending = kernel.db.prepare("SELECT 1 FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state IN ('inflight','unknown') LIMIT 1").get(graphId, call.node_id);
    const running = kernel.db.prepare("SELECT 1 FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' LIMIT 1").get(graphId, call.node_id);
    if (!pending && !running) {
      kernel.db.prepare('UPDATE kernel_node_state SET reserved=0 WHERE task_id=? AND node_id=?').run(graphId, call.node_id);
      kernel.db.prepare("UPDATE kernel_executions SET token_reservation=0 WHERE task_id=? AND node_id=? AND state!='running'").run(graphId, call.node_id);
    }
    kernel.store.event(graphId, 'graph.provider.reconciled', { nodeId: call.node_id, callId, usage });
    return { replayed: false, nodeId: call.node_id };
  });
}
