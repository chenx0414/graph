import { randomUUID } from 'node:crypto';
import { canonicalJson, type TaskStore } from '../core/store.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import { estimateCost, type ModelEntry } from '../catalog/models.ts';
import type { TokenUsage } from './call-broker.ts';
import type { SendGate } from './controlled-openai.ts';

function tokens(usage: TokenUsage) { return usage.input + usage.output + usage.cacheRead + usage.cacheWrite; }

function inFlightUsage(store: TaskStore, instanceId: string) {
  const rows = store.db.prepare(`SELECT i.usage FROM invocations i JOIN operations o ON o.id=i.operation_id
    WHERE i.instance_id=? AND o.state IN ('intent','dispatched','unknown') AND i.usage IS NOT NULL`).all(instanceId) as { usage: string }[];
  return rows.reduce((sum, row) => sum + tokens(JSON.parse(row.usage) as TokenUsage), 0);
}

/** Task-store invocation gate: pause, unknown usage, and budget are checked before every provider send. */
export function taskGate(store: TaskStore, operation: { id: string; taskId: string; instanceId: string; nodeId?: string }, model: ModelEntry): SendGate & { total(): TokenUsage | null } {
  let unknown = false;
  const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const nodeId = operation.nodeId ?? (store.db.prepare('SELECT node_id FROM operations WHERE id=?').get(operation.id) as { node_id: string } | undefined)?.node_id;
  return {
    dispatch<T>(id: string, reservation: number, send: () => T): T {
      if (!id) throw new RuntimeError('invalid_input', 'An invocation id is required');
      if (!Number.isSafeInteger(reservation) || reservation < 0) throw new RuntimeError('invalid_input', 'A token reservation is required');
      store.transaction(() => {
        if (store.task(operation.taskId).paused) throw new RuntimeError('paused', 'Instance paused');
        if (nodeId && store.db.prepare("SELECT id FROM questions WHERE task_id=? AND node_id=? AND kind='unknown_usage' AND status='open'").get(operation.taskId, nodeId)) {
          throw new RuntimeError('unknown_usage', 'Instance paused for unknown usage');
        }
        const account = store.db.prepare('SELECT budget,used FROM instances WHERE id=?').get(operation.instanceId) as { budget: number; used: number };
        if (account.used + inFlightUsage(store, operation.instanceId) + reservation > account.budget) {
          throw new RuntimeError('budget', 'Token budget exhausted');
        }
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
        if (!usage) {
          unknown = true;
          if (nodeId && !store.db.prepare("SELECT id FROM questions WHERE operation_id=? AND kind='unknown_usage' AND status='open'").get(operation.id)) {
            store.db.prepare('INSERT INTO questions(id,task_id,node_id,operation_id,kind,data) VALUES(?,?,?,?,?,?)')
              .run(randomUUID(), operation.taskId, nodeId, operation.id, 'unknown_usage', canonicalJson({ reason: 'Agent returned no authoritative usage' }));
          }
        } else {
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
