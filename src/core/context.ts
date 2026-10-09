import { createHash, randomUUID } from 'node:crypto';
import { budgetScopeView, ensureBudgetScope } from './budget-ledger.ts';
import { canonicalJson, type TaskStore } from './store.ts';
import {
  RuntimeError,
  type AgentContextMode,
  type ContextHandoffPackage,
  type NodeSpec,
  type ResolvedAgentContext,
} from './types.ts';

interface InstanceContextRow {
  id: string;
  budget_scope_id: string | null;
  session_id: string | null;
}

interface BindingRow {
  id: string;
  budget_scope_id: string;
}

export function digest(value: unknown) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function instanceContextRow(store: TaskStore, taskId: string, nodeId: string) {
  return store.db.prepare(`SELECT i.id,i.budget_scope_id,s.session_id
    FROM instances i LEFT JOIN node_sessions s ON s.instance_id=i.id
    WHERE i.task_id=? AND i.node_id=?`).get(taskId, nodeId) as InstanceContextRow | undefined;
}

function bindingRow(store: TaskStore, instanceId: string) {
  return store.db.prepare(`SELECT id,budget_scope_id FROM agent_context_bindings WHERE instance_id=?`)
    .get(instanceId) as BindingRow | undefined;
}

/** Only the external main uses this operation ledger. Native graph nodes
 * retain their own resident session and receive explicit interface deliveries. */
export function resolveAgentContext(store: TaskStore, input: {
  taskId: string;
  nodeId: string;
  spec: NodeSpec;
}): ResolvedAgentContext {
  if (input.spec.role !== 'master' || Reflect.get(input.spec, 'context') !== undefined) {
    throw new RuntimeError('context_rejected', 'Legacy graph context is retired; graph nodes receive explicit interface deliveries');
  }
  const instance = instanceContextRow(store, input.taskId, input.nodeId);
  if (!instance) throw new RuntimeError('invalid_adapter', 'Main context requires an instance');
  const existing = bindingRow(store, instance.id);
  return {
    mode: instance.session_id ? 'continue' : 'fresh',
    purpose: 'discuss', independence: 'none', requestedFacts: [],
    reasonCode: instance.session_id ? 'existing_session' : 'default_fresh',
    bindingId: existing?.id ?? randomUUID(), resolutionId: randomUUID(), handoffId: randomUUID(),
    handoffDigest: '', constraintsDigest: '',
    budgetScopeId: existing?.budget_scope_id ?? ensureBudgetScope(store, input.taskId, instance.id),
  };
}

function validateHandoffPackage(context: ResolvedAgentContext, handoff: ContextHandoffPackage) {
  if (handoff.mode !== context.mode || handoff.purpose !== context.purpose || handoff.independence !== context.independence) {
    throw new RuntimeError('context_rejected', 'Context handoff does not match the resolved context mode');
  }
  if (!handoff.summary.trim() || !handoff.briefing.trim()) {
    throw new RuntimeError('context_rejected', 'Context handoff requires a summary and briefing');
  }
  if (!Array.isArray(handoff.decisions) || handoff.decisions.some(item => typeof item !== 'string')) {
    throw new RuntimeError('context_rejected', 'Context handoff requires a decisions array');
  }
  if (!Array.isArray(handoff.acceptance) || (context.purpose !== 'discuss' && handoff.acceptance.length === 0)) {
    throw new RuntimeError('context_rejected', 'Context handoff requires the frozen acceptance contract');
  }
  if (!Array.isArray(handoff.artifactRefs) || handoff.artifactRefs.some(ref =>
    !ref || typeof ref.path !== 'string' || !ref.path.trim() || !/^[a-f0-9]{64}$/.test(ref.digest)
    || ((ref.artifactId === undefined) !== (ref.version === undefined))
    || (ref.artifactId !== undefined && (!ref.artifactId.trim() || typeof ref.version !== 'number' || !Number.isSafeInteger(ref.version) || ref.version < 1)))) {
    throw new RuntimeError('context_rejected', 'Context handoff requires artifact references with exact digests');
  }
  if (!handoff.outputSchema || typeof handoff.outputSchema.kind !== 'string' || !handoff.outputSchema.kind.trim()
    || !Number.isSafeInteger(handoff.outputSchema.version) || handoff.outputSchema.version < 1) {
    throw new RuntimeError('context_rejected', 'Context handoff requires an output schema');
  }
}

export function handoffConstraintsDigest(handoff: ContextHandoffPackage) {
  return digest({
    acceptance: handoff.acceptance,
    decisions: handoff.decisions,
    outputSchema: handoff.outputSchema,
  });
}

export function freezeContextHandoff(store: TaskStore, context: ResolvedAgentContext, input: {
  taskId: string;
  operationId: string;
  nodeId: string;
  instanceId: string;
  package: ContextHandoffPackage;
  capabilityDigest?: string;
}) {
  validateHandoffPackage(context, input.package);
  const packageDigest = digest(input.package);
  const constraintsDigest = handoffConstraintsDigest(input.package);
  const existingBinding = bindingRow(store, input.instanceId);
  if (context.mode !== 'fresh' && context.mode !== 'continue') throw new RuntimeError('context_rejected', 'Transcript inheritance is retired');
  const mode = 'fresh';
  if (!existingBinding) {
    store.db.prepare(`INSERT INTO agent_context_bindings(id,task_id,node_id,instance_id,mode,source_instance_id,
        source_session_id,source_session_file,source_leaf_id,budget_scope_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(context.bindingId, input.taskId, input.nodeId, input.instanceId, mode,
        null, null, null,
        context.sourceLeafId ?? null, context.budgetScopeId, Date.now());
  }
  const { version } = store.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM context_handoffs WHERE task_id=?')
    .get(input.taskId) as { version: number };
  store.db.prepare(`INSERT INTO context_handoffs(id,task_id,operation_id,version,purpose,summary,package,digest,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(context.handoffId, input.taskId, input.operationId, version, context.purpose, input.package.summary,
      canonicalJson(input.package as never), packageDigest, Date.now());
  store.db.prepare(`INSERT INTO context_resolutions(id,task_id,node_id,operation_id,requested_purpose,requested_facts,independence,
      selected_mode,reason_code,source_instance_id,binding_id,handoff_id,constraints_digest,review_policy,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(context.resolutionId, input.taskId, input.nodeId, input.operationId, context.purpose,
      canonicalJson(context.requestedFacts as never), context.independence,
      context.mode, context.reasonCode, null, context.bindingId, context.handoffId,
      constraintsDigest, context.reviewPolicy ? canonicalJson(context.reviewPolicy as never) : null,
      Date.now());
  if (input.capabilityDigest) {
    store.db.prepare('UPDATE agent_context_bindings SET capability_digest=? WHERE id=?').run(input.capabilityDigest, context.bindingId);
  }
  return { ...context, handoffDigest: packageDigest, constraintsDigest };
}

export function recordContextSession(store: TaskStore, input: {
  taskId: string;
  nodeId: string;
  operationId: string;
  bindingId: string;
  sessionId?: string;
  capabilityDigest?: string;
  modelPolicyDigest?: string;
  toolPolicyDigest?: string;
  sourceLeafId?: string;
  sourceContextDigest?: string;
  childContextDigest?: string;
}) {
  const resolution = store.db.prepare('SELECT selected_mode FROM context_resolutions WHERE operation_id=?')
    .get(input.operationId) as { selected_mode: AgentContextMode } | undefined;
  store.db.prepare(`UPDATE agent_context_bindings SET
      source_leaf_id=COALESCE(?,source_leaf_id),
      source_context_digest=COALESCE(?,source_context_digest),
      child_context_digest=COALESCE(?,child_context_digest),
      capability_digest=COALESCE(?,capability_digest),
      model_policy_digest=COALESCE(?,model_policy_digest),
      tool_policy_digest=COALESCE(?,tool_policy_digest)
    WHERE id=?`)
    .run(input.sourceLeafId ?? null, input.sourceContextDigest ?? null, input.childContextDigest ?? null,
      input.capabilityDigest ?? null, input.modelPolicyDigest ?? null, input.toolPolicyDigest ?? null, input.bindingId);
  const eventType = resolution?.selected_mode === 'continue' ? 'context.branch_resumed' : null;
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
      b.source_context_digest,b.child_context_digest,b.capability_digest,b.model_policy_digest,b.tool_policy_digest,
      b.budget_scope_id,b.created_at,
      r.selected_mode,r.requested_purpose,r.requested_facts,r.independence,r.reason_code,r.operation_id,
      r.constraints_digest,r.review_policy,
      h.digest AS handoff_digest,h.summary AS handoff_summary,h.package AS handoff_package,
      si.node_id AS source_node_id
    FROM instances i
    LEFT JOIN agent_context_bindings b ON b.instance_id=i.id
    LEFT JOIN context_resolutions r ON r.id=(SELECT id FROM context_resolutions WHERE binding_id=b.id ORDER BY created_at DESC,rowid DESC LIMIT 1)
    LEFT JOIN context_handoffs h ON h.id=(SELECT id FROM context_handoffs WHERE operation_id=r.operation_id ORDER BY rowid DESC LIMIT 1)
    LEFT JOIN instances si ON si.id=b.source_instance_id
    WHERE i.task_id=? AND i.node_id=?`).get(taskId, nodeId) as {
      mode: 'fresh' | null;
      source_instance_id: string | null;
      source_session_id: string | null;
      source_session_file: string | null;
      source_leaf_id: string | null;
      source_context_digest: string | null;
      child_context_digest: string | null;
      capability_digest: string | null;
      model_policy_digest: string | null;
      tool_policy_digest: string | null;
      budget_scope_id: string | null;
      created_at: number | null;
      selected_mode: AgentContextMode | null;
      requested_purpose: string | null;
      requested_facts: string | null;
      independence: string | null;
      reason_code: string | null;
      operation_id: string | null;
      constraints_digest: string | null;
      review_policy: string | null;
      handoff_digest: string | null;
      handoff_summary: string | null;
      handoff_package: string | null;
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
    modelPolicyDigest: row.model_policy_digest,
    toolPolicyDigest: row.tool_policy_digest,
    constraintsDigest: row.constraints_digest,
    reviewPolicy: row.review_policy ? JSON.parse(row.review_policy) as unknown : null,
    handoffDigest: row.handoff_digest,
    handoffSummary: row.handoff_summary,
    budgetScope: row.budget_scope_id ? budgetScopeView(store, row.budget_scope_id) : null,
  };
}
