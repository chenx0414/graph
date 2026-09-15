import { randomUUID } from 'node:crypto';
import { canonicalJson, type TaskStore } from './store.ts';
import { RuntimeError, type Json } from './types.ts';

export interface NodeEntryInput {
  taskId: string;
  nodeId: string;
  instanceId?: string | null;
  activationId?: string | null;
  operationId?: string | null;
  role: 'user' | 'assistant' | 'tool' | 'system';
  kind: string;
  text: string;
  data?: Json;
}

/** Append one display entry from a real Pi session event. The task event stream
 * also receives it so node details can update without a refetch race. */
export function appendNodeEntry(store: TaskStore, input: NodeEntryInput) {
  const id = randomUUID();
  store.transaction(() => {
    store.db.prepare(`INSERT INTO node_entries(id,task_id,node_id,instance_id,activation_id,operation_id,role,kind,text,data,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.taskId, input.nodeId, input.instanceId ?? null, input.activationId ?? null, input.operationId ?? null,
        input.role, input.kind, input.text, input.data === undefined ? null : canonicalJson(input.data), Date.now());
  });
  const row = store.db.prepare('SELECT seq FROM node_entries WHERE id=?').get(id) as { seq: number };
  store.event(input.taskId, 'node.entry', { nodeId: input.nodeId, seq: row.seq, role: input.role, kind: input.kind, text: input.text });
  return row.seq;
}

export function recordNodeSession(store: TaskStore, instanceId: string, sessionId: string, sessionFile: string | null) {
  store.db.prepare('INSERT OR REPLACE INTO node_sessions VALUES(?,?,?,?)').run(instanceId, sessionId, sessionFile, Date.now());
}

/** Stable forward/backward pagination over a single node's entries. */
export function listNodeEntries(store: TaskStore, taskId: string, nodeId: string, query: { after?: number; before?: number; limit?: number } = {}) {
  const limit = Number.isSafeInteger(query.limit) && (query.limit ?? 0) > 0 ? Math.min(query.limit!, 500) : 100;
  const entryCount = (store.db.prepare('SELECT COUNT(*) AS count FROM node_entries WHERE task_id=? AND node_id=?').get(taskId, nodeId) as { count: number }).count;
  const map = (rows: { seq: number; id: string; role: string; kind: string; text: string; data: string | null; operation_id: string | null; created_at: number }[]) => rows.map(row => ({
    seq: row.seq, id: row.id, role: row.role, kind: row.kind, text: row.text,
    data: row.data ? JSON.parse(row.data) as Json : null, operationId: row.operation_id, createdAt: row.created_at,
  }));
  if (query.before !== undefined) {
    const rows = store.db.prepare(`SELECT seq,id,role,kind,text,data,operation_id,created_at FROM node_entries
      WHERE task_id=? AND node_id=? AND seq<? ORDER BY seq DESC LIMIT ?`).all(taskId, nodeId, query.before, limit) as Parameters<typeof map>[0];
    return { entries: map(rows.reverse()), entryCount, limit };
  }
  const after = Number.isSafeInteger(query.after) && (query.after ?? 0) >= 0 ? query.after! : 0;
  const rows = store.db.prepare(`SELECT seq,id,role,kind,text,data,operation_id,created_at FROM node_entries
    WHERE task_id=? AND node_id=? AND seq>? ORDER BY seq LIMIT ?`).all(taskId, nodeId, after, limit) as Parameters<typeof map>[0];
  return { entries: map(rows), entryCount, limit };
}

/** Read-only node detail: definition identity, session reference, entries and
 * per-operation timing where credential waiting is separated from run time. */
export function nodeRun(store: TaskStore, taskId: string, nodeId: string, query: { after?: number; before?: number; limit?: number } = {}) {
  const task = store.task(taskId);
  const node = store.db.prepare('SELECT id,spec,instance_id,status,activation_id,output_version,stall_count FROM nodes WHERE task_id=? AND id=?').get(taskId, nodeId) as
    { id: string; spec: string; instance_id: string | null; status: string; activation_id: string; output_version: number; stall_count: number } | undefined;
  if (!node) throw new RuntimeError('not_found', `Unknown node ${nodeId}`);
  const spec = JSON.parse(node.spec) as { kind: string; action: string; definitionVersion?: string; role?: string; input?: Json };
  const instance = node.instance_id
    ? store.db.prepare('SELECT id,model,definition_version,used,budget,unlimited,models_used FROM instances WHERE id=?').get(node.instance_id) as
      { id: string; model: string | null; definition_version: string | null; used: number; budget: number; unlimited: number; models_used: string } | undefined
    : undefined;
  const session = node.instance_id
    ? store.db.prepare('SELECT session_id,session_file FROM node_sessions WHERE instance_id=?').get(node.instance_id) as { session_id: string; session_file: string | null } | undefined
    : undefined;
  const operations = (store.db.prepare(`SELECT id,state,reserved,worker_active,waiting_slot,result,usage,dispatched_at,settled_at,waiting_ms,activation_id
    FROM operations WHERE task_id=? AND node_id=? ORDER BY rowid`).all(taskId, nodeId) as {
      id: string; state: string; reserved: number; worker_active: number; waiting_slot: number; result: string | null; usage: string | null;
      dispatched_at: number | null; settled_at: number | null; waiting_ms: number; activation_id: string | null;
    }[]).map(row => {
    const waitingMs = row.waiting_ms ?? 0;
    const runMs = row.dispatched_at !== null && row.settled_at !== null ? Math.max(0, row.settled_at - row.dispatched_at - (row.waiting_slot ? Date.now() - (row.dispatched_at ?? 0) : waitingMs)) : null;
    return {
      id: row.id, state: row.state, activationId: row.activation_id, workerActive: Boolean(row.worker_active),
      waitingSlot: Boolean(row.waiting_slot), reserved: row.reserved, waitingMs,
      runMs, dispatchedAt: row.dispatched_at, settledAt: row.settled_at,
      result: row.result ? JSON.parse(row.result) as Json : null, usage: row.usage ? JSON.parse(row.usage) as Json : null,
    };
  });
  const invocations = (store.db.prepare(`SELECT i.id,i.model,i.usage,i.cost FROM invocations i JOIN operations o ON o.id=i.operation_id
    WHERE o.task_id=? AND o.node_id=? ORDER BY i.rowid`).all(taskId, nodeId) as { id: string; model: string; usage: string | null; cost: string | null }[])
    .map(row => ({ id: row.id, model: row.model, usage: row.usage ? JSON.parse(row.usage) as Json : null, cost: row.cost ? JSON.parse(row.cost) as Json : null }));
  const questions = (store.db.prepare("SELECT id,kind,status,data FROM questions WHERE task_id=? AND node_id=? ORDER BY rowid").all(taskId, nodeId) as { id: string; kind: string; status: string; data: string }[])
    .map(row => ({ id: row.id, kind: row.kind, status: row.status, data: JSON.parse(row.data) as Json }));
  const evidence = (store.db.prepare('SELECT acceptance_id,valid,commit_sha FROM evidence WHERE task_id=? AND node_id=? ORDER BY rowid').all(taskId, nodeId) as { acceptance_id: string; valid: number; commit_sha: string | null }[])
    .map(row => ({ acceptanceId: row.acceptance_id, valid: Boolean(row.valid), commitSha: row.commit_sha }));
  const page = listNodeEntries(store, taskId, nodeId, query);
  return {
    taskId, nodeId,
    node: { id: node.id, kind: spec.kind, action: spec.action, role: spec.role ?? null, status: node.status, activationId: node.activation_id, outputVersion: node.output_version, stallCount: node.stall_count, ...(spec.definitionVersion ? { definitionVersion: spec.definitionVersion } : {}), ...(spec.input !== undefined ? { input: spec.input } : {}) },
    instance: instance ? {
      id: instance.id, model: instance.model, definitionVersion: instance.definition_version, used: instance.used,
      budget: instance.unlimited ? null : instance.budget, unlimited: Boolean(instance.unlimited), modelsUsed: JSON.parse(instance.models_used) as string[],
    } : null,
    session: session ? { sessionId: session.session_id, sessionFile: session.session_file } : null,
    operations, invocations, questions, evidence,
    entries: page.entries, entryCount: page.entryCount,
    phase: store.task(taskId).phase,
  };
}
