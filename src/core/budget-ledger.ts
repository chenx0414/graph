import { randomUUID } from 'node:crypto';
import type { TaskStore } from './store.ts';
import { RuntimeError, type TokenUsage } from './types.ts';

interface InstanceBudgetRow {
  id: string;
  budget: number;
  used: number;
  unlimited: number;
  budget_scope_id: string | null;
}

export interface BudgetSnapshot {
  instanceId: string;
  budget: number;
  used: number;
  unlimited: boolean;
  reserved: number;
  scopeId: string | null;
  scopeLimit: number | null;
  scopeUsed: number;
  scopeUnlimited: boolean;
}

export interface BudgetScopeView {
  id: string;
  rootTaskId: string | null;
  ownerInstanceId: string | null;
  members: number;
  used: number;
  limit: number | null;
  unlimited: boolean;
}

function tokenTotal(usage: TokenUsage) {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function instanceBudget(store: TaskStore, instanceId: string) {
  const row = store.db.prepare('SELECT id,budget,used,unlimited,budget_scope_id FROM instances WHERE id=?')
    .get(instanceId) as InstanceBudgetRow | undefined;
  if (!row) throw new RuntimeError('not_found', 'Unknown instance budget');
  return row;
}

/** Establish the durable scope shared by an instance and all allowed forks. */
export function ensureBudgetScope(store: TaskStore, taskId: string, instanceId: string) {
  const instance = instanceBudget(store, instanceId);
  if (instance.budget_scope_id) return instance.budget_scope_id;
  const id = randomUUID();
  store.db.prepare(`INSERT INTO budget_scopes(
    id,task_id,root_task_id,owner_instance_id,limit_tokens,unlimited,used_tokens,created_at
  ) VALUES(?,?,?,?,?,?,?,?)`).run(
    id,
    taskId,
    taskId,
    instance.id,
    instance.unlimited ? null : instance.budget,
    instance.unlimited,
    instance.used,
    Date.now(),
  );
  store.db.prepare('UPDATE instances SET budget_scope_id=? WHERE id=?').run(id, instance.id);
  return id;
}

export function budgetScopeView(store: TaskStore, scopeId: string): BudgetScopeView | null {
  const row = store.db.prepare(`SELECT s.id,s.root_task_id,s.owner_instance_id,s.limit_tokens,s.unlimited,s.used_tokens,
      (SELECT COUNT(*) FROM instances member WHERE member.budget_scope_id=s.id) AS members
    FROM budget_scopes s WHERE s.id=?`).get(scopeId) as {
      id: string;
      root_task_id: string | null;
      owner_instance_id: string | null;
      limit_tokens: number | null;
      unlimited: number;
      used_tokens: number;
      members: number;
    } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    rootTaskId: row.root_task_id,
    ownerInstanceId: row.owner_instance_id,
    members: row.members,
    used: row.used_tokens,
    limit: row.unlimited ? null : row.limit_tokens,
    unlimited: Boolean(row.unlimited),
  };
}

export function shareBudgetScope(store: TaskStore, instanceId: string, scopeId: string) {
  instanceBudget(store, instanceId);
  const scope = store.db.prepare('SELECT limit_tokens,unlimited FROM budget_scopes WHERE id=?')
    .get(scopeId) as { limit_tokens: number | null; unlimited: number } | undefined;
  if (!scope) {
    throw new RuntimeError('not_found', 'Unknown budget scope');
  }
  store.db.prepare('UPDATE instances SET budget_scope_id=?,budget=?,unlimited=? WHERE id=?')
    .run(scopeId, scope.limit_tokens ?? 0, scope.unlimited, instanceId);
}

export function budgetSnapshot(store: TaskStore, instanceId: string): BudgetSnapshot {
  const instance = instanceBudget(store, instanceId);
  const { reserved } = store.db.prepare('SELECT COALESCE(SUM(reserved),0) AS reserved FROM operations WHERE instance_id=?')
    .get(instanceId) as { reserved: number };
  const scope = instance.budget_scope_id ? budgetScopeView(store, instance.budget_scope_id) : null;
  return {
    instanceId,
    budget: instance.budget,
    used: instance.used,
    unlimited: Boolean(instance.unlimited),
    reserved,
    scopeId: instance.budget_scope_id,
    scopeLimit: scope?.limit ?? null,
    scopeUsed: scope?.used ?? 0,
    scopeUnlimited: scope ? scope.unlimited : true,
  };
}

/** Only an unlimited main Agent may continue when the provider omits usage.
 * Workers and finite-budget instances keep fail-closed accounting because
 * their graph contract still depends on authoritative usage. */
export function masterUnknownUsageIsNonBlocking(
  store: TaskStore,
  instanceId: string | null | undefined,
  taskId: string,
  nodeId: string | null | undefined,
) {
  if (!instanceId || !nodeId) return false;
  const row = store.db.prepare(`SELECT i.unlimited,n.spec
    FROM instances i JOIN nodes n ON n.task_id=? AND n.id=?
    WHERE i.id=?`).get(taskId, nodeId, instanceId) as { unlimited: number; spec: string } | undefined;
  if (!row?.unlimited) return false;
  try {
    return (JSON.parse(row.spec) as { role?: string }).role === 'master';
  } catch {
    return false;
  }
}

function scopeInFlightUsage(store: TaskStore, scopeId: string) {
  const rows = store.db.prepare(`SELECT i.usage FROM invocations i
    JOIN operations o ON o.id=i.operation_id
    JOIN instances n ON n.id=i.instance_id
    WHERE n.budget_scope_id=? AND o.state IN ('intent','dispatched','unknown') AND i.usage IS NOT NULL`)
    .all(scopeId) as { usage: string }[];
  return rows.reduce((sum, row) => sum + tokenTotal(JSON.parse(row.usage) as TokenUsage), 0);
}

function scopeReserved(store: TaskStore, scopeId: string) {
  return (store.db.prepare(`SELECT COALESCE(SUM(o.reserved),0) AS reserved FROM operations o
    JOIN instances i ON i.id=o.instance_id WHERE i.budget_scope_id=?`).get(scopeId) as { reserved: number }).reserved;
}

export function assertWithinBudget(store: TaskStore, instanceId: string, reservation = 0) {
  const snapshot = budgetSnapshot(store, instanceId);
  if (snapshot.scopeId) {
    if (snapshot.scopeUnlimited) return;
    const total = snapshot.scopeUsed
      + scopeInFlightUsage(store, snapshot.scopeId)
      + scopeReserved(store, snapshot.scopeId)
      + reservation;
    if (total > (snapshot.scopeLimit ?? 0) || (reservation === 0 && total >= (snapshot.scopeLimit ?? 0))) {
      throw new RuntimeError('budget', 'Shared context budget exhausted');
    }
    return;
  }
  if (!snapshot.unlimited && (snapshot.used + snapshot.reserved + reservation > snapshot.budget
    || (reservation === 0 && snapshot.used + snapshot.reserved >= snapshot.budget))) {
    throw new RuntimeError('budget', 'Token budget exhausted');
  }
}

/** Reservation is an operation transition owned by the ledger. */
export function reserveOperation(store: TaskStore, operationId: string, amount: number) {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RuntimeError('invalid_adapter', 'A bounded token reservation is required');
  }
  const result = store.db.prepare("UPDATE operations SET reserved=? WHERE id=? AND state='intent' AND reserved=0")
    .run(amount, operationId);
  if (result.changes !== 1) throw new RuntimeError('invalid_operation', 'Operation reservation is no longer available');
}

export function releaseOperationReservation(store: TaskStore, operationId: string) {
  store.db.prepare('UPDATE operations SET reserved=0 WHERE id=?').run(operationId);
}

export function commitUsage(store: TaskStore, instanceId: string, total: number) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RuntimeError('invalid_input', 'Usage total must be a nonnegative integer');
  }
  const instance = instanceBudget(store, instanceId);
  if (total > 0) {
    store.db.prepare('UPDATE instances SET used=used+? WHERE id=?').run(total, instanceId);
    if (instance.budget_scope_id) {
      store.db.prepare('UPDATE budget_scopes SET used_tokens=used_tokens+? WHERE id=?')
        .run(total, instance.budget_scope_id);
    }
  }
}

export function modelsUsed(store: TaskStore, instanceId: string) {
  const row = store.db.prepare('SELECT models_used FROM instances WHERE id=?').get(instanceId) as { models_used: string } | undefined;
  if (!row) throw new RuntimeError('not_found', 'Unknown instance');
  return JSON.parse(row.models_used) as string[];
}

export function recordModelUse(store: TaskStore, instanceId: string, model: string | null | undefined) {
  if (!model) return;
  const used = modelsUsed(store, instanceId);
  if (used.includes(model)) return;
  store.db.prepare('UPDATE instances SET models_used=? WHERE id=?').run(JSON.stringify([...used, model]), instanceId);
}

export function recordCurrentModelUse(store: TaskStore, instanceId: string | null) {
  if (!instanceId) return;
  const row = store.db.prepare('SELECT model FROM instances WHERE id=?').get(instanceId) as { model: string | null } | undefined;
  if (row) recordModelUse(store, instanceId, row.model);
}

export function setBudget(store: TaskStore, instanceId: string, tokens: number | null) {
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0)) {
    throw new RuntimeError('invalid_input', 'Budget must be a positive integer or null');
  }
  const row = instanceBudget(store, instanceId);
  if (row.budget_scope_id) {
    const scope = store.db.prepare(`SELECT s.owner_instance_id,
        (SELECT COUNT(*) FROM instances member WHERE member.budget_scope_id=s.id) AS members
      FROM budget_scopes s WHERE s.id=?`).get(row.budget_scope_id) as {
        owner_instance_id: string | null;
        members: number;
      } | undefined;
    if (scope && scope.members > 1 && scope.owner_instance_id !== instanceId) {
      throw new RuntimeError('shared_budget_owner_required', 'Only the shared budget owner can change the scope cap');
    }
  }
  store.db.prepare('UPDATE instances SET budget=?,unlimited=? WHERE id=?')
    .run(tokens ?? 0, tokens === null ? 1 : 0, instanceId);
  if (row.budget_scope_id) {
    store.db.prepare('UPDATE budget_scopes SET limit_tokens=?,unlimited=? WHERE id=?')
      .run(tokens, tokens === null ? 1 : 0, row.budget_scope_id);
    store.db.prepare('UPDATE instances SET budget=?,unlimited=? WHERE budget_scope_id=?')
      .run(tokens ?? 0, tokens === null ? 1 : 0, row.budget_scope_id);
  }
}

export function addBudget(store: TaskStore, instanceId: string, tokens: number) {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    throw new RuntimeError('invalid_input', 'A positive token increment is required');
  }
  const row = instanceBudget(store, instanceId);
  if (row.unlimited) throw new RuntimeError('invalid_answer', 'An unlimited instance has no budget question to add to');
  if (!Number.isSafeInteger(row.budget + tokens)) {
    throw new RuntimeError('invalid_answer', 'Budget exceeds the supported range');
  }
  store.db.prepare('UPDATE instances SET budget=budget+? WHERE id=?').run(tokens, instanceId);
  if (row.budget_scope_id) {
    const scope = store.db.prepare('SELECT limit_tokens,unlimited FROM budget_scopes WHERE id=?')
      .get(row.budget_scope_id) as { limit_tokens: number | null; unlimited: number };
    if (!scope.unlimited) {
      store.db.prepare('UPDATE budget_scopes SET limit_tokens=COALESCE(limit_tokens,0)+? WHERE id=?')
        .run(tokens, row.budget_scope_id);
      store.db.prepare('UPDATE instances SET budget=COALESCE((SELECT limit_tokens FROM budget_scopes WHERE id=?),0) WHERE budget_scope_id=?')
        .run(row.budget_scope_id, row.budget_scope_id);
    }
  }
}
