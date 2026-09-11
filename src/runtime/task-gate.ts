import { canonicalJson, type TaskStore } from '../core/store.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import { estimateCost, type ModelEntry } from '../catalog/models.ts';
import type { TokenUsage } from './call-broker.ts';
import type { SendGate } from './controlled-openai.ts';

/** Task-store invocation gate: pause check and unique invocation records, no second budget ledger. */
export function taskGate(store: TaskStore, operation: { id: string; taskId: string; instanceId: string }, model: ModelEntry): SendGate & { total(): TokenUsage | null } {
  let unknown = false;
  const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    dispatch<T>(id: string, _reservation: number, send: () => T): T {
      if (!id) throw new RuntimeError('invalid_input', 'An invocation id is required');
      if (store.task(operation.taskId).paused) throw new RuntimeError('paused', 'Instance paused');
      store.transaction(() => {
        if (store.db.prepare('SELECT id FROM invocations WHERE id=?').get(id)) throw new RuntimeError('invalid_input', 'Invocation already dispatched');
        store.db.prepare('INSERT INTO invocations(id,operation_id,instance_id,model) VALUES(?,?,?,?)').run(id, operation.id, operation.instanceId, model.id);
      });
      try { return send(); }
      catch (error) { this.settle(id, null); throw error; }
    },
    settle(id: string, usage: TokenUsage | null) {
      store.transaction(() => {
        const row = store.db.prepare('SELECT usage FROM invocations WHERE id=?').get(id) as { usage: string | null } | undefined;
        if (!row) throw new RuntimeError('not_found', 'Unknown invocation');
        if (row.usage !== null) {
          if (row.usage !== canonicalJson(usage)) throw new RuntimeError('result_conflict', 'Conflicting usage evidence');
          return;
        }
        const cost = usage ? estimateCost(usage, model.cost) : { unknown: true };
        store.db.prepare('UPDATE invocations SET usage=?,cost=? WHERE id=?').run(usage ? canonicalJson(usage) : null, canonicalJson(cost), id);
        if (!usage) unknown = true;
        else {
          total.input += usage.input; total.output += usage.output; total.cacheRead += usage.cacheRead; total.cacheWrite += usage.cacheWrite;
        }
      });
    },
    total() { return unknown ? null : total; },
  };
}

export function invocationRows(store: TaskStore, taskId: string) {
  const rows = store.db.prepare('SELECT i.id,i.operation_id,i.instance_id,i.model,i.usage,i.cost FROM invocations i JOIN operations o ON o.id=i.operation_id WHERE o.task_id=? ORDER BY i.rowid').all(taskId) as { id: string; operation_id: string; instance_id: string; model: string; usage: string | null; cost: string | null }[];
  return rows.map(row => ({ id: row.id, operationId: row.operation_id, instanceId: row.instance_id, model: row.model, usage: row.usage ? JSON.parse(row.usage) as TokenUsage : null, cost: row.cost ? JSON.parse(row.cost) as Json : null }));
}
