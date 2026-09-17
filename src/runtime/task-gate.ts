import { randomUUID } from 'node:crypto';
import { canonicalJson, type TaskStore } from '../core/store.ts';
import { assertWithinBudget } from '../core/budget-ledger.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import { estimateCost, type ModelEntry } from '../catalog/models.ts';
import { openUserWait } from '../core/time-ledger.ts';
import type { TokenUsage } from './call-broker.ts';
import type { SendGate } from './controlled-openai.ts';

/** What one provider send is for. Pi compaction and branch summaries are real
 * billed requests and must be attributable separately from normal turns. */
export type InvocationPurpose = 'completion' | 'compaction' | 'branch_summary';

export const INVOCATION_PURPOSES: readonly InvocationPurpose[] = ['completion', 'compaction', 'branch_summary'];

/** Task-store invocation gate: pause, unknown usage, and budget are checked before every provider send. */
export function taskGate(store: TaskStore, operation: { id: string; taskId: string; instanceId: string; nodeId?: string }, model: ModelEntry): SendGate & { total(): TokenUsage | null; setPurpose(purpose: InvocationPurpose): void; check(reservation?: number): void } {
  let unknown = false;
  let purpose: InvocationPurpose = 'completion';
  const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const nodeId = operation.nodeId ?? (store.db.prepare('SELECT node_id FROM operations WHERE id=?').get(operation.id) as { node_id: string } | undefined)?.node_id;
  return {
    check(reservation = 0) {
      if (!Number.isSafeInteger(reservation) || reservation < 0) throw new RuntimeError('invalid_input', 'A token reservation is required');
      if (store.task(operation.taskId).paused) throw new RuntimeError('paused', 'Instance paused');
      if (nodeId && store.db.prepare("SELECT id FROM questions WHERE task_id=? AND node_id=? AND kind='unknown_usage' AND status='open'").get(operation.taskId, nodeId)) {
        throw new RuntimeError('unknown_usage', 'Instance paused for unknown usage');
      }
      assertWithinBudget(store, operation.instanceId, reservation);
    },
    dispatch<T>(id: string, reservation: number, send: () => T): T {
      if (!id) throw new RuntimeError('invalid_input', 'An invocation id is required');
      this.check(reservation);
      store.transaction(() => {
        if (store.db.prepare('SELECT id FROM invocations WHERE id=?').get(id)) throw new RuntimeError('invalid_input', 'Invocation already dispatched');
        // Freeze the underlying upstream identity, not just the mutable
        // connection id: review independence reads this history later.
        store.db.prepare('INSERT INTO invocations(id,operation_id,instance_id,model,purpose) VALUES(?,?,?,?,?)').run(id, operation.id, operation.instanceId, model.modelId ?? model.id, purpose);
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
        const cost = usage ? estimateCost(usage, model.cost, model.pricing) : { unknown: true };
        store.db.prepare('UPDATE invocations SET usage=?,cost=? WHERE id=?').run(usage ? canonicalJson(usage) : null, canonicalJson(cost), id);
        if (!usage) {
          unknown = true;
          if (nodeId && !store.db.prepare("SELECT id FROM questions WHERE operation_id=? AND kind='unknown_usage' AND status='open'").get(operation.id)) {
            const questionId = randomUUID();
            const data = { reason: 'Agent returned no authoritative usage' };
            store.db.prepare('INSERT INTO questions(id,task_id,node_id,operation_id,kind,data) VALUES(?,?,?,?,?,?)')
              .run(questionId, operation.taskId, nodeId, operation.id, 'unknown_usage', canonicalJson(data));
            openUserWait(store, operation.taskId, nodeId);
            // The stream must see the question even though no node status changed.
            store.event(operation.taskId, 'question.opened', { nodeId, kind: 'unknown_usage', data, operationId: operation.id });
          }
        } else {
          total.input += usage.input; total.output += usage.output; total.cacheRead += usage.cacheRead; total.cacheWrite += usage.cacheWrite;
        }
      });
    },
    setPurpose(next: InvocationPurpose) {
      if (!INVOCATION_PURPOSES.includes(next)) throw new RuntimeError('invalid_input', `Unknown invocation purpose ${next}`);
      purpose = next;
    },
    total() { return unknown ? null : total; },
  };
}

export function invocationRows(store: TaskStore, taskId: string) {
  const rows = store.db.prepare('SELECT i.id,i.operation_id,i.instance_id,i.model,i.usage,i.cost FROM invocations i JOIN operations o ON o.id=i.operation_id WHERE o.task_id=? ORDER BY i.rowid').all(taskId) as { id: string; operation_id: string; instance_id: string; model: string; usage: string | null; cost: string | null }[];
  return rows.map(row => ({ id: row.id, operationId: row.operation_id, instanceId: row.instance_id, model: row.model, usage: row.usage ? JSON.parse(row.usage) as TokenUsage : null, cost: row.cost ? JSON.parse(row.cost) as Json : null }));
}
