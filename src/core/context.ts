import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, type TaskStore } from './store.ts';
import {
  RuntimeError,
  type AgentContextMode,
  type ContextFactRef,
  type ContextIndependence,
  type ContextPurpose,
  type ContextRequest,
  type NodeSpec,
  type ResolvedAgentContext,
} from './types.ts';

interface InstanceContextRow {
  id: string;
  node_id: string;
  model: string | null;
  definition_version: string | null;
  budget: number;
  used: number;
  unlimited: number;
  budget_scope_id: string | null;
  session_id: string | null;
  session_file: string | null;
}

interface BindingRow {
  id: string;
  mode: 'fresh' | 'fork';
  source_instance_id: string | null;
  source_session_id: string | null;
  source_session_file: string | null;
  budget_scope_id: string;
}

export function digest(value: unknown) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function boundedText(value: unknown, max = 800) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : undefined;
}

function transcriptFact(fact: ContextFactRef) {
  return fact.kind === 'transcript_range' || fact.kind === 'tool_call';
}

const FACT_KINDS = new Set(['artifact', 'decision', 'file', 'transcript_range', 'tool_call']);
const PURPOSES = new Set(['discuss', 'explore', 'implement', 'review', 'verify', 'rework']);
const INDEPENDENCE = new Set(['none', 'fresh', 'model-excluded']);

/** Validate the supervisor-authored request; mode is deliberately absent. */
export function validateContextRequest(context: ContextRequest | undefined) {
  if (context === undefined) return;
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new RuntimeError('invalid_proposal', 'context must be an object');
  if (context.purpose !== undefined && !PURPOSES.has(context.purpose)) throw new RuntimeError('invalid_proposal', 'Unknown context purpose');
  if (context.sourceNode !== undefined && !boundedText(context.sourceNode, 160)) throw new RuntimeError('invalid_proposal', 'context.sourceNode must be a bounded nonempty node id');
  if (context.sourceLeafId !== undefined && !boundedText(context.sourceLeafId, 160)) throw new RuntimeError('invalid_proposal', 'context.sourceLeafId must be bounded');
  if (context.independence !== undefined && !INDEPENDENCE.has(context.independence)) throw new RuntimeError('invalid_proposal', 'Unknown context independence policy');
  if (context.rebrand !== undefined && typeof context.rebrand !== 'boolean') throw new RuntimeError('invalid_proposal', 'context.rebrand must be boolean');
  if (context.reason !== undefined && !boundedText(context.reason, 2_000)) throw new RuntimeError('invalid_proposal', 'context.reason must be bounded');
  if (context.requiredFacts !== undefined) {
    if (!Array.isArray(context.requiredFacts) || context.requiredFacts.length > 20) throw new RuntimeError('invalid_proposal', 'context.requiredFacts must be a bounded list');
    for (const fact of context.requiredFacts) {
      if (!fact || typeof fact !== 'object' || Array.isArray(fact) || !FACT_KINDS.has(fact.kind)) {
        throw new RuntimeError('invalid_proposal', 'Unknown context fact');
      }
      if (fact.ref !== undefined && !boundedText(fact.ref, 1_000)) throw new RuntimeError('invalid_proposal', 'Context fact ref must be bounded');
      if (fact.from !== undefined && !boundedText(fact.from, 160)) throw new RuntimeError('invalid_proposal', 'Context fact from must be bounded');
      if (fact.to !== undefined && !boundedText(fact.to, 160)) throw new RuntimeError('invalid_proposal', 'Context fact to must be bounded');
    }
    if (context.independence && context.independence !== 'none'
      && context.requiredFacts.some(transcriptFact)) {
      throw new RuntimeError('invalid_proposal', 'Independent context cannot include transcript or tool-call facts');
    }
  }
  if (context.requiredFacts?.some(transcriptFact) && !context.sourceNode) {
    throw new RuntimeError('invalid_proposal', 'Transcript inheritance requires context.sourceNode');
  }
}

function instanceContextRow(store: TaskStore, taskId: string, nodeId: string) {
  return store.db.prepare(`SELECT i.id,i.node_id,i.model,i.definition_version,i.budget,i.used,i.unlimited,i.budget_scope_id,
      s.session_id,s.session_file
    FROM instances i LEFT JOIN node_sessions s ON s.instance_id=i.id
    WHERE i.task_id=? AND i.node_id=?`).get(taskId, nodeId) as InstanceContextRow | undefined;
}

function bindingRow(store: TaskStore, instanceId: string) {
  return store.db.prepare('SELECT id,mode,source_instance_id,source_session_id,source_session_file,budget_scope_id FROM agent_context_bindings WHERE instance_id=?')
    .get(instanceId) as BindingRow | undefined;
}

function createBudgetScope(store: TaskStore, taskId: string, instance: InstanceContextRow) {
  const id = randomUUID();
  store.db.prepare(`INSERT INTO budget_scopes(id,task_id,owner_instance_id,limit_tokens,unlimited,used_tokens,created_at)
    VALUES(?,?,?,?,?,?,?)`)
    .run(id, taskId, instance.id, instance.unlimited ? null : instance.budget, instance.unlimited, instance.used, Date.now());
  store.db.prepare('UPDATE instances SET budget_scope_id=? WHERE id=?').run(id, instance.id);
  return id;
}

export function ensureBudgetScope(store: TaskStore, taskId: string, instance: InstanceContextRow) {
  if (instance.budget_scope_id) return instance.budget_scope_id;
  return createBudgetScope(store, taskId, instance);
}

function inferPurpose(spec: NodeSpec, review: boolean): ContextPurpose {
  if (spec.context?.purpose) return spec.context.purpose;
  if (review) return 'review';
  if (spec.role === 'master') return 'discuss';
  return 'implement';
}

function inferIndependence(spec: NodeSpec, review: boolean): ContextIndependence {
  if (review) return 'model-excluded';
  return spec.context?.independence ?? 'none';
}

function sourceNodeSpec(store: TaskStore, taskId: string, sourceNodeId: string) {
  const row = store.db.prepare('SELECT spec,status FROM nodes WHERE task_id=? AND id=?').get(taskId, sourceNodeId) as { spec: string; status: string } | undefined;
  if (!row) throw new RuntimeError('context_rejected', `Context source node ${sourceNodeId} does not exist`);
  const spec = JSON.parse(row.spec) as NodeSpec;
  if (spec.kind !== 'agent') throw new RuntimeError('context_rejected', `Context source ${sourceNodeId} is not an Agent node`);
  if (row.status !== 'succeeded') throw new RuntimeError('context_rejected', `Context source ${sourceNodeId} must finish before it can be forked`);
  return spec;
}

function resolveFresh(store: TaskStore, taskId: string, instance: InstanceContextRow, request: ContextRequest, purpose: ContextPurpose, independence: ContextIndependence, review: boolean) {
  const scopeId = ensureBudgetScope(store, taskId, instance);
  return {
    mode: 'fresh' as const,
    purpose,
    independence,
    reasonCode: review ? 'review_requires_fresh' : independence !== 'none' ? 'independence_requires_fresh' : request.requiredFacts?.length ? 'facts_do_not_require_transcript' : 'default_fresh',
    budgetScopeId: scopeId,
  };
}

/** Resolve context before the operation row is written. The returned ids are
 * persisted in the same transaction as the operation, so retries are idempotent. */
export function resolveAgentContext(store: TaskStore, input: {
  taskId: string;
  nodeId: string;
  spec: NodeSpec;
  review: boolean;
}): ResolvedAgentContext {
  validateContextRequest(input.spec.context);
  const instance = instanceContextRow(store, input.taskId, input.nodeId);
  if (!instance) throw new RuntimeError('invalid_adapter', 'Agent context requires an instance');
  const request = input.spec.context ?? {};
  const requestedFacts = structuredClone(request.requiredFacts ?? []);
  const purpose = inferPurpose(input.spec, input.review);
  const independence = inferIndependence(input.spec, input.review);
  const existingBinding = bindingRow(store, instance.id);
  const resolutionId = randomUUID();
  const handoffId = randomUUID();

  if (instance.session_id) {
    const scopeId = existingBinding?.budget_scope_id ?? ensureBudgetScope(store, input.taskId, instance);
    return {
      mode: 'continue',
      purpose,
      independence,
      requestedFacts,
      reasonCode: 'existing_session',
      bindingId: existingBinding?.id ?? randomUUID(),
      resolutionId,
      handoffId,
      handoffDigest: '',
      budgetScopeId: scopeId,
    };
  }

  const requestedTranscript = request.requiredFacts?.some(transcriptFact) ?? false;
  if (input.review && requestedTranscript) {
    throw new RuntimeError('context_rejected', 'Independent review cannot inherit implementation transcript or tool calls');
  }
  if (independence !== 'none' && requestedTranscript) {
    throw new RuntimeError('context_rejected', 'Fresh independent context cannot inherit transcript or tool calls');
  }

  if (!requestedTranscript) {
    const fresh = resolveFresh(store, input.taskId, instance, request, purpose, independence, input.review);
    return {
      mode: fresh.mode,
      purpose,
      independence,
      requestedFacts,
      reasonCode: fresh.reasonCode,
      bindingId: existingBinding?.id ?? randomUUID(),
      resolutionId,
      handoffId,
      handoffDigest: '',
      budgetScopeId: fresh.budgetScopeId,
    };
  }

  const sourceNodeId = request.sourceNode!;
  const sourceSpec = sourceNodeSpec(store, input.taskId, sourceNodeId);
  const source = instanceContextRow(store, input.taskId, sourceNodeId);
  if (!source || !source.session_id || !source.session_file) throw new RuntimeError('context_rejected', `Context source ${sourceNodeId} has no persisted session`);
  if (!request.rebrand && (source.model !== instance.model || source.definition_version !== instance.definition_version)) {
    throw new RuntimeError('context_rejected', `Fork from ${sourceNodeId} changes model or Agent definition; set context.rebrand=true to allow it`);
  }
  const sourceScopeId = ensureBudgetScope(store, input.taskId, source);
  store.db.prepare('UPDATE instances SET budget_scope_id=?,parent_instance_id=? WHERE id=?').run(sourceScopeId, source.id, instance.id);
  return {
    mode: 'fork',
    purpose,
    independence,
    requestedFacts,
    reasonCode: request.sourceNode ? 'explicit_transcript_facts' : 'transcript_facts',
    bindingId: existingBinding?.id ?? randomUUID(),
    resolutionId,
    handoffId,
    handoffDigest: '',
    budgetScopeId: sourceScopeId,
    ...(request.rebrand ? { rebrand: true } : {}),
    sourceNodeId,
    sourceInstanceId: source.id,
    sourceSessionId: source.session_id,
    sourceSessionFile: source.session_file,
    ...(request.sourceLeafId ? { sourceLeafId: request.sourceLeafId } : {}),
  };
}

export function freezeContextHandoff(store: TaskStore, context: ResolvedAgentContext, input: {
  taskId: string;
  operationId: string;
  nodeId: string;
  instanceId: string;
  summary: string;
  package: unknown;
  capabilityDigest?: string;
}) {
  const packageDigest = digest(input.package);
  const existingBinding = bindingRow(store, input.instanceId);
  const mode: 'fresh' | 'fork' = context.mode === 'fork' ? 'fork' : 'fresh';
  if (!existingBinding) {
    store.db.prepare(`INSERT INTO agent_context_bindings(id,task_id,node_id,instance_id,mode,source_instance_id,
        source_session_id,source_session_file,source_leaf_id,budget_scope_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(context.bindingId, input.taskId, input.nodeId, input.instanceId, mode,
        context.sourceInstanceId ?? null, context.sourceSessionId ?? null, context.sourceSessionFile ?? null,
        context.sourceLeafId ?? null, context.budgetScopeId, Date.now());
  }
  store.db.prepare(`INSERT INTO context_handoffs(id,task_id,operation_id,version,purpose,summary,package,digest,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(context.handoffId, input.taskId, input.operationId, 1, context.purpose, input.summary,
      canonicalJson(input.package as never), packageDigest, Date.now());
  store.db.prepare(`INSERT INTO context_resolutions(id,task_id,node_id,operation_id,requested_purpose,requested_facts,independence,
      selected_mode,reason_code,source_instance_id,binding_id,handoff_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(context.resolutionId, input.taskId, input.nodeId, input.operationId, context.purpose,
      canonicalJson(context.requestedFacts as never), context.independence,
      context.mode, context.reasonCode, context.sourceInstanceId ?? null, context.bindingId, context.handoffId, Date.now());
  if (input.capabilityDigest) {
    store.db.prepare('UPDATE agent_context_bindings SET capability_digest=? WHERE id=?').run(input.capabilityDigest, context.bindingId);
  }
  return { ...context, handoffDigest: packageDigest };
}

export function recordContextSession(store: TaskStore, input: {
  taskId: string;
  nodeId: string;
  operationId: string;
  bindingId: string;
  sessionId?: string;
  capabilityDigest?: string;
  sourceLeafId?: string;
  sourceContextDigest?: string;
  childContextDigest?: string;
}) {
  const prior = store.db.prepare('SELECT mode,source_context_digest FROM agent_context_bindings WHERE id=?')
    .get(input.bindingId) as { mode: 'fresh' | 'fork'; source_context_digest: string | null } | undefined;
  const resolution = store.db.prepare('SELECT selected_mode FROM context_resolutions WHERE operation_id=?')
    .get(input.operationId) as { selected_mode: AgentContextMode } | undefined;
  store.db.prepare(`UPDATE agent_context_bindings SET
      source_leaf_id=COALESCE(?,source_leaf_id),
      source_context_digest=COALESCE(?,source_context_digest),
      child_context_digest=COALESCE(?,child_context_digest),
      capability_digest=COALESCE(?,capability_digest)
    WHERE id=?`)
    .run(input.sourceLeafId ?? null, input.sourceContextDigest ?? null, input.childContextDigest ?? null,
      input.capabilityDigest ?? null, input.bindingId);
  const eventType = input.sourceContextDigest && prior?.mode === 'fork' && !prior.source_context_digest
    ? 'context.branch_created'
    : resolution?.selected_mode === 'continue' || (prior?.mode === 'fork' && prior.source_context_digest)
      ? 'context.branch_resumed'
      : null;
  if (eventType) {
    store.event(input.taskId, eventType, {
      nodeId: input.nodeId,
      operationId: input.operationId,
      bindingId: input.bindingId,
      sessionId: input.sessionId ?? null,
      sourceLeafId: input.sourceLeafId ?? null,
      sourceContextDigest: input.sourceContextDigest ?? null,
      childContextDigest: input.childContextDigest ?? null,
    });
  }
}

export function contextView(store: TaskStore, taskId: string, nodeId: string) {
  const row = store.db.prepare(`SELECT b.mode,b.source_instance_id,b.source_session_id,b.source_session_file,b.source_leaf_id,
      b.source_context_digest,b.child_context_digest,b.capability_digest,b.budget_scope_id,b.created_at,
      s.limit_tokens,s.unlimited,s.used_tokens,
      r.selected_mode,r.requested_purpose,r.requested_facts,r.independence,r.reason_code,r.operation_id,
      h.digest AS handoff_digest,h.summary AS handoff_summary,
      si.node_id AS source_node_id
    FROM instances i
    LEFT JOIN agent_context_bindings b ON b.instance_id=i.id
    LEFT JOIN budget_scopes s ON s.id=b.budget_scope_id
    LEFT JOIN context_resolutions r ON r.id=(SELECT id FROM context_resolutions WHERE binding_id=b.id ORDER BY created_at DESC,rowid DESC LIMIT 1)
    LEFT JOIN context_handoffs h ON h.id=(SELECT id FROM context_handoffs WHERE operation_id=r.operation_id ORDER BY rowid DESC LIMIT 1)
    LEFT JOIN instances si ON si.id=b.source_instance_id
    WHERE i.task_id=? AND i.node_id=?`).get(taskId, nodeId) as {
      mode: 'fresh' | 'fork' | null;
      source_instance_id: string | null;
      source_session_id: string | null;
      source_session_file: string | null;
      source_leaf_id: string | null;
      source_context_digest: string | null;
      child_context_digest: string | null;
      capability_digest: string | null;
      budget_scope_id: string | null;
      created_at: number | null;
      limit_tokens: number | null;
      unlimited: number | null;
      used_tokens: number | null;
      selected_mode: AgentContextMode | null;
      requested_purpose: string | null;
      requested_facts: string | null;
      independence: string | null;
      reason_code: string | null;
      operation_id: string | null;
      handoff_digest: string | null;
      handoff_summary: string | null;
      source_node_id: string | null;
    } | undefined;
  if (!row?.mode) return null;
  return {
    initialMode: row.mode,
    selectedMode: row.selected_mode ?? row.mode,
    purpose: row.requested_purpose,
    requestedFacts: row.requested_facts ? JSON.parse(row.requested_facts) as unknown : [],
    independence: row.independence,
    reasonCode: row.reason_code,
    sourceNodeId: row.source_node_id,
    sourceInstanceId: row.source_instance_id,
    sourceSessionId: row.source_session_id,
    sourceSessionFile: row.source_session_file,
    sourceLeafId: row.source_leaf_id,
    sourceContextDigest: row.source_context_digest,
    childContextDigest: row.child_context_digest,
    capabilityDigest: row.capability_digest,
    handoffDigest: row.handoff_digest,
    handoffSummary: row.handoff_summary,
    budgetScope: row.budget_scope_id ? {
      id: row.budget_scope_id,
      used: row.used_tokens ?? 0,
      limit: row.unlimited ? null : row.limit_tokens,
      unlimited: Boolean(row.unlimited),
    } : null,
  };
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

function tokenTotal(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function budgetSnapshot(store: TaskStore, instanceId: string): BudgetSnapshot {
  const instance = store.db.prepare('SELECT id,budget,used,unlimited,budget_scope_id FROM instances WHERE id=?')
    .get(instanceId) as { id: string; budget: number; used: number; unlimited: number; budget_scope_id: string | null } | undefined;
  if (!instance) throw new RuntimeError('not_found', 'Unknown instance budget');
  const { reserved } = store.db.prepare('SELECT COALESCE(SUM(reserved),0) AS reserved FROM operations WHERE instance_id=?').get(instanceId) as { reserved: number };
  const scope = instance.budget_scope_id
    ? store.db.prepare('SELECT limit_tokens,unlimited,used_tokens FROM budget_scopes WHERE id=?').get(instance.budget_scope_id) as { limit_tokens: number | null; unlimited: number; used_tokens: number } | undefined
    : undefined;
  return {
    instanceId,
    budget: instance.budget,
    used: instance.used,
    unlimited: Boolean(instance.unlimited),
    reserved,
    scopeId: instance.budget_scope_id,
    scopeLimit: scope?.unlimited ? null : scope?.limit_tokens ?? null,
    scopeUsed: scope?.used_tokens ?? 0,
    scopeUnlimited: scope ? Boolean(scope.unlimited) : true,
  };
}

export function scopeInFlightUsage(store: TaskStore, scopeId: string) {
  const rows = store.db.prepare(`SELECT i.usage FROM invocations i
    JOIN operations o ON o.id=i.operation_id
    JOIN instances n ON n.id=i.instance_id
    WHERE n.budget_scope_id=? AND o.state IN ('intent','dispatched','unknown') AND i.usage IS NOT NULL`).all(scopeId) as { usage: string }[];
  return rows.reduce((sum, row) => sum + tokenTotal(JSON.parse(row.usage) as { input: number; output: number; cacheRead: number; cacheWrite: number }), 0);
}

export function scopeReserved(store: TaskStore, scopeId: string) {
  return (store.db.prepare(`SELECT COALESCE(SUM(o.reserved),0) AS reserved FROM operations o
    JOIN instances i ON i.id=o.instance_id WHERE i.budget_scope_id=?`).get(scopeId) as { reserved: number }).reserved;
}

export function assertWithinBudget(store: TaskStore, instanceId: string, reservation = 0) {
  const snapshot = budgetSnapshot(store, instanceId);
  if (!snapshot.unlimited && (snapshot.used + snapshot.reserved + reservation > snapshot.budget
    || (reservation === 0 && snapshot.used + snapshot.reserved >= snapshot.budget))) {
    throw new RuntimeError('budget', 'Token budget exhausted');
  }
  if (snapshot.scopeId && !snapshot.scopeUnlimited) {
    const total = snapshot.scopeUsed + scopeInFlightUsage(store, snapshot.scopeId) + scopeReserved(store, snapshot.scopeId) + reservation;
    if (total > (snapshot.scopeLimit ?? 0) || (reservation === 0 && total >= (snapshot.scopeLimit ?? 0))) {
      throw new RuntimeError('budget', 'Shared context budget exhausted');
    }
  }
}

export function addInstanceUsage(store: TaskStore, instanceId: string, total: number) {
  if (!Number.isSafeInteger(total) || total < 0) throw new RuntimeError('invalid_input', 'Usage total must be a nonnegative integer');
  store.db.prepare('UPDATE instances SET used=used+? WHERE id=?').run(total, instanceId);
  const scope = store.db.prepare('SELECT budget_scope_id FROM instances WHERE id=?').get(instanceId) as { budget_scope_id: string | null } | undefined;
  if (scope?.budget_scope_id) store.db.prepare('UPDATE budget_scopes SET used_tokens=used_tokens+? WHERE id=?').run(total, scope.budget_scope_id);
}

export function setInstanceBudget(store: TaskStore, instanceId: string, tokens: number | null) {
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0)) throw new RuntimeError('invalid_input', 'Budget must be a positive integer or null');
  const row = store.db.prepare('SELECT budget_scope_id FROM instances WHERE id=?').get(instanceId) as { budget_scope_id: string | null } | undefined;
  if (!row) throw new RuntimeError('not_found', 'Unknown instance budget');
  store.db.prepare('UPDATE instances SET budget=?,unlimited=? WHERE id=?').run(tokens ?? 0, tokens === null ? 1 : 0, instanceId);
  if (row.budget_scope_id) {
    store.db.prepare('UPDATE budget_scopes SET limit_tokens=?,unlimited=? WHERE id=?').run(tokens, tokens === null ? 1 : 0, row.budget_scope_id);
  }
}

export function addInstanceBudget(store: TaskStore, instanceId: string, tokens: number) {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) throw new RuntimeError('invalid_input', 'A positive token increment is required');
  const row = store.db.prepare('SELECT budget,unlimited,budget_scope_id FROM instances WHERE id=?')
    .get(instanceId) as { budget: number; unlimited: number; budget_scope_id: string | null } | undefined;
  if (!row) throw new RuntimeError('not_found', 'Unknown instance budget');
  if (row.unlimited) throw new RuntimeError('invalid_answer', 'An unlimited instance has no budget question to add to');
  if (!Number.isSafeInteger(row.budget + tokens)) throw new RuntimeError('invalid_answer', 'Budget exceeds the supported range');
  store.db.prepare('UPDATE instances SET budget=budget+? WHERE id=?').run(tokens, instanceId);
  if (row.budget_scope_id) {
    const scope = store.db.prepare('SELECT limit_tokens,unlimited FROM budget_scopes WHERE id=?').get(row.budget_scope_id) as { limit_tokens: number | null; unlimited: number };
    if (!scope.unlimited) store.db.prepare('UPDATE budget_scopes SET limit_tokens=COALESCE(limit_tokens,0)+? WHERE id=?').run(tokens, row.budget_scope_id);
  }
}
