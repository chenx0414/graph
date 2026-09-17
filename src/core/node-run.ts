import { randomUUID } from 'node:crypto';
import { nodeTimeLedger } from './time-ledger.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, type TaskStore } from './store.ts';
import { RuntimeError, type Json } from './types.ts';
import { contextView } from './context.ts';

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

export interface CapabilityLoadFact {
  id: string;
  version: string;
  kind: string | null;
  loaded: boolean;
  executable: boolean;
  reason: string | null;
  name?: string;
  description?: string;
  path?: string;
  tools?: string[];
}

export function recordCapabilityLoad(store: TaskStore, input: {
  taskId: string;
  nodeId: string;
  instanceId?: string | null;
  operationId?: string | null;
  readOnly: boolean;
  report: CapabilityLoadFact[];
  digest?: string;
  toolPolicyDigest?: string;
  runtimePolicyDigest?: string;
}) {
  store.db.prepare(`INSERT INTO node_capabilities(task_id,node_id,instance_id,operation_id,read_only,loaded,created_at)
    VALUES(?,?,?,?,?,?,?)`)
    .run(input.taskId, input.nodeId, input.instanceId ?? null, input.operationId ?? null, input.readOnly ? 1 : 0, canonicalJson({
      version: 2,
      digest: input.digest ?? null,
      toolPolicyDigest: input.toolPolicyDigest ?? null,
      runtimePolicyDigest: input.runtimePolicyDigest ?? null,
      facts: input.report,
    }), Date.now());
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
    // Backward page: the entries directly before the cursor, oldest-first.
    const rows = store.db.prepare(`SELECT seq,id,role,kind,text,data,operation_id,created_at FROM node_entries
      WHERE task_id=? AND node_id=? AND seq<? ORDER BY seq DESC LIMIT ?`).all(taskId, nodeId, query.before, limit) as Parameters<typeof map>[0];
    return { entries: map(rows.reverse()), entryCount, limit, hasOlder: true, hasNewer: false };
  }
  if (query.after !== undefined) {
    // Forward page from a known cursor.
    const after = Number.isSafeInteger(query.after) && query.after >= 0 ? query.after : 0;
    const rows = store.db.prepare(`SELECT seq,id,role,kind,text,data,operation_id,created_at FROM node_entries
      WHERE task_id=? AND node_id=? AND seq>? ORDER BY seq LIMIT ?`).all(taskId, nodeId, after, limit) as Parameters<typeof map>[0];
    const hasNewer = rows.length === limit && entryCount > 0 && rows[rows.length - 1]!.seq < (store.db.prepare('SELECT MAX(seq) AS seq FROM node_entries WHERE task_id=? AND node_id=?').get(taskId, nodeId) as { seq: number | null }).seq!;
    return { entries: map(rows), entryCount, limit, hasOlder: true, hasNewer };
  }
  // No cursor: the newest page. The initial view must show the live tail; the
  // UI then pages backward with `before` until it reaches the first entry.
  const rows = store.db.prepare(`SELECT seq,id,role,kind,text,data,operation_id,created_at FROM node_entries
    WHERE task_id=? AND node_id=? ORDER BY seq DESC LIMIT ?`).all(taskId, nodeId, limit) as Parameters<typeof map>[0];
  const oldest = rows.length ? rows[rows.length - 1]!.seq : 0;
  const first = (store.db.prepare('SELECT MIN(seq) AS seq FROM node_entries WHERE task_id=? AND node_id=?').get(taskId, nodeId) as { seq: number | null }).seq;
  return { entries: map(rows.reverse()), entryCount, limit, hasOlder: first !== null && oldest > first, hasNewer: false };
}

/** Read-only node detail: definition identity, session reference, entries and
 * per-operation timing where credential waiting is separated from run time. */
export function nodeRun(store: TaskStore, taskId: string, nodeId: string, query: { after?: number; before?: number; limit?: number } = {}) {
  const task = store.task(taskId);
  const node = store.db.prepare('SELECT id,spec,instance_id,status,activation_id,output_version,stall_count FROM nodes WHERE task_id=? AND id=?').get(taskId, nodeId) as
    { id: string; spec: string; instance_id: string | null; status: string; activation_id: string; output_version: number; stall_count: number } | undefined;
  if (!node) throw new RuntimeError('not_found', `Unknown node ${nodeId}`);
  const spec = JSON.parse(node.spec) as { kind: string; action: string; definitionVersion?: string; role?: string; input?: Json };
  // Capability view: definition binding plus the actual load fact recorded for
  // this node. No record means "not recorded", never a guessed true.
  const capabilities = (() => {
    if (!spec.definitionVersion) return { facts: [], digest: null };
    const match = /^(.*)@(\d+)$/.exec(spec.definitionVersion);
    if (!match) return { facts: [], digest: null };
    const definition = store.db.prepare('SELECT spec FROM definitions WHERE id=? AND version=?').get(match[1] ?? '', Number(match[2] ?? 0)) as { spec: string } | undefined;
    if (!definition) return { facts: [], digest: null };
    const parsed = JSON.parse(definition.spec) as {
      capabilities?: { id: string; version: string }[];
      prompts?: { agent?: { id: string; version: string }; tool?: { id: string; version: string } };
    };
    const factRow = store.db.prepare('SELECT loaded,read_only FROM node_capabilities WHERE task_id=? AND node_id=? ORDER BY seq DESC LIMIT 1').get(taskId, nodeId) as { loaded: string; read_only: number } | undefined;
    const taskPhase = store.task(taskId).phase;
    const facts = new Map<string, CapabilityLoadFact>();
    let capabilityDigest: string | null = null;
    if (factRow) {
      const loaded = JSON.parse(factRow.loaded) as CapabilityLoadFact[] | { digest?: string | null; facts?: CapabilityLoadFact[] };
      const loadedFacts = Array.isArray(loaded) ? loaded : loaded.facts ?? [];
      capabilityDigest = Array.isArray(loaded) ? null : loaded.digest ?? null;
      for (const fact of loadedFacts) facts.set(`${fact.id}@${fact.version}`, fact);
    }
    const bindings = [
      ...(parsed.capabilities ?? []),
      ...(parsed.prompts?.agent ? [parsed.prompts.agent] : []),
      ...(parsed.prompts?.tool ? [parsed.prompts.tool] : []),
    ];
    return { facts: bindings.map(bound => {
      const catalogRecord = store.db.prepare('SELECT kind,source FROM capabilities WHERE id=? AND version=?').get(bound.id, bound.version) as { kind: string; source: string } | undefined;
      const fact = facts.get(`${bound.id}@${bound.version}`);
      // Authoritative current-state derivation for the one case the loading
      // code skips by contract: a remote MCP is never loaded in read-only
      // discussion. This is not a guess from catalog status.
      const remote = catalogRecord?.kind === 'mcp' && (() => {
        try {
          const manifest = JSON.parse(readFileSync(join(catalogRecord.source, 'capability.json'), 'utf8')) as { command?: unknown };
          return typeof manifest.command !== 'string';
        } catch { return false; }
      })();
      if (!fact && !factRow && remote && spec.role === 'master' && (taskPhase === 'chatting' || taskPhase === 'discussing')) {
        return {
          id: bound.id, version: bound.version, kind: 'mcp', bound: true as const,
          loaded: false, executable: false, state: '禁用', reason: '只读讨论模式不加载远程能力',
        };
      }
      if (!fact) {
        return {
          id: bound.id, version: bound.version, kind: catalogRecord?.kind ?? null,
          bound: true as const, loaded: null, executable: null,
          state: factRow ? '未加载' : '未记录',
          reason: factRow ? '本次运行未加载该能力' : '该节点没有能力加载记录（历史或尚未运行）',
        };
      }
      return {
        id: fact.id, version: fact.version, kind: fact.kind, bound: true as const,
        loaded: fact.loaded, executable: fact.executable,
        state: fact.loaded ? (fact.executable ? '可执行' : '已加载') : '禁用',
        reason: fact.reason,
      };
    }), digest: capabilityDigest };
  })();
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
  const invocations = (store.db.prepare(`SELECT i.id,i.model,i.usage,i.cost,i.purpose FROM invocations i JOIN operations o ON o.id=i.operation_id
    WHERE o.task_id=? AND o.node_id=? ORDER BY i.rowid`).all(taskId, nodeId) as { id: string; model: string; usage: string | null; cost: string | null; purpose: string }[])
    .map(row => ({ id: row.id, model: row.model, purpose: row.purpose, usage: row.usage ? JSON.parse(row.usage) as Json : null, cost: row.cost ? JSON.parse(row.cost) as Json : null }));
  const questions = (store.db.prepare("SELECT id,kind,status,data FROM questions WHERE task_id=? AND node_id=? ORDER BY rowid").all(taskId, nodeId) as { id: string; kind: string; status: string; data: string }[])
    .map(row => ({ id: row.id, kind: row.kind, status: row.status, data: JSON.parse(row.data) as Json }));
  const evidence = (store.db.prepare('SELECT acceptance_id,valid,commit_sha FROM evidence WHERE task_id=? AND node_id=? ORDER BY rowid').all(taskId, nodeId) as { acceptance_id: string; valid: number; commit_sha: string | null }[])
    .map(row => ({ acceptanceId: row.acceptance_id, valid: Boolean(row.valid), commitSha: row.commit_sha }));
  const page = listNodeEntries(store, taskId, nodeId, query);
  // Time segments come from authoritative state timestamps, never from the
  // message span. "Still running" is a property of the current lifecycle:
  // a terminal node is never in progress because of a historical attempt.
  const nodeTerminal = ['succeeded', 'skipped', 'retired', 'failed'].includes(node.status);
  const active = operations.filter(operation => operation.workerActive || ['dispatched', 'running'].includes(operation.state));
  const inProgress = !nodeTerminal && active.length > 0;
  const settled = operations.filter(operation => operation.dispatchedAt !== null && operation.settledAt !== null);
  const ledger = nodeTimeLedger(store, taskId, nodeId);
  const timing = {
    totalMs: settled.length ? Math.max(0, Math.max(...settled.map(operation => operation.settledAt!)) - Math.min(...settled.map(operation => operation.dispatchedAt!))) : null,
    runMs: settled.length ? settled.reduce((sum, operation) => sum + (operation.runMs ?? 0), 0) : null,
    waitingMs: operations.reduce((sum, operation) => sum + operation.waitingMs, 0),
    // Recorded pause / user-wait segments; a historical node without ledger
    // facts stays "未记录" instead of being inferred from message times.
    pauseMs: ledger.pauseMs ?? null,
    userWaitMs: ledger.userWaitMs ?? null,
    inProgress,
  };
  return {
    taskId, nodeId,
    context: contextView(store, taskId, nodeId),
    capabilities: capabilities.facts,
    capabilityDigest: capabilities.digest,
    node: { id: node.id, kind: spec.kind, action: spec.action, role: spec.role ?? null, status: node.status, activationId: node.activation_id, outputVersion: node.output_version, stallCount: node.stall_count, ...(spec.definitionVersion ? { definitionVersion: spec.definitionVersion } : {}), ...(spec.input !== undefined ? { input: spec.input } : {}) },
    instance: instance ? {
      id: instance.id, model: instance.model, definitionVersion: instance.definition_version, used: instance.used,
      budget: instance.unlimited ? null : instance.budget, unlimited: Boolean(instance.unlimited), modelsUsed: JSON.parse(instance.models_used) as string[],
    } : null,
    session: session ? { sessionId: session.session_id, sessionFile: session.session_file } : null,
    operations, invocations, questions, evidence,
    timing,
    entries: page.entries, entryCount: page.entryCount, hasOlder: page.hasOlder, hasNewer: page.hasNewer,
    phase: store.task(taskId).phase,
  };
}
