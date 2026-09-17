import { createHash, randomUUID } from 'node:crypto';
import { budgetScopeView, ensureBudgetScope, shareBudgetScope } from './budget-ledger.ts';
import { canonicalJson, type TaskStore } from './store.ts';
import {
  RuntimeError,
  type AgentContextMode,
  type ContextHandoffPackage,
  type ContextFactRef,
  type ContextIndependence,
  type ContextPurpose,
  type ContextRequest,
  type NodeSpec,
  type ResolvedAgentContext,
  type ReviewIndependencePolicy,
} from './types.ts';

interface InstanceContextRow {
  id: string;
  node_id: string;
  model: string | null;
  definition_version: string | null;
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
  model_policy_digest: string | null;
  tool_policy_digest: string | null;
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
  return store.db.prepare(`SELECT i.id,i.node_id,i.model,i.definition_version,i.budget_scope_id,
      s.session_id,s.session_file
    FROM instances i LEFT JOIN node_sessions s ON s.instance_id=i.id
    WHERE i.task_id=? AND i.node_id=?`).get(taskId, nodeId) as InstanceContextRow | undefined;
}

function bindingRow(store: TaskStore, instanceId: string) {
  return store.db.prepare(`SELECT id,mode,source_instance_id,source_session_id,source_session_file,budget_scope_id,
      model_policy_digest,tool_policy_digest FROM agent_context_bindings WHERE instance_id=?`)
    .get(instanceId) as BindingRow | undefined;
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
  const scopeId = ensureBudgetScope(store, taskId, instance.id);
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
  excludedModels?: string[];
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
  const reviewPolicy: ReviewIndependencePolicy | undefined = input.review
    ? {
        freshRequired: true,
        evidenceOnly: true,
        excludedModels: [...new Set(input.excludedModels ?? [])].sort(),
        allowedTools: null,
        reportSchema: { kind: 'independent_review', version: 1 },
      }
    : undefined;
  const policyFields = reviewPolicy ? { reviewPolicy } : {};

  const requestedTranscript = request.requiredFacts?.some(transcriptFact) ?? false;
  if (input.review && requestedTranscript) {
    throw new RuntimeError('context_rejected', 'Independent review cannot inherit implementation transcript or tool calls');
  }
  if (independence !== 'none' && requestedTranscript) {
    throw new RuntimeError('context_rejected', 'Fresh independent context cannot inherit transcript or tool calls');
  }

  // Independent review always starts from a fresh handoff. A prior review
  // session may exist on the node after rework, but it must never become the
  // implementation lineage or the next round's only checkout of the source.
  if (instance.session_id && !input.review) {
    const scopeId = existingBinding?.budget_scope_id ?? ensureBudgetScope(store, input.taskId, instance.id);
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
      constraintsDigest: '',
      budgetScopeId: scopeId,
      ...policyFields,
    };
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
      constraintsDigest: '',
      budgetScopeId: fresh.budgetScopeId,
      ...policyFields,
    };
  }

  const sourceNodeId = request.sourceNode!;
  const sourceSpec = sourceNodeSpec(store, input.taskId, sourceNodeId);
  const source = instanceContextRow(store, input.taskId, sourceNodeId);
  if (!source || !source.session_id || !source.session_file) throw new RuntimeError('context_rejected', `Context source ${sourceNodeId} has no persisted session`);
  const sourceBinding = bindingRow(store, source.id);
  const sourceParent = store.db.prepare('SELECT parent_instance_id FROM instances WHERE id=?').get(source.id) as { parent_instance_id: string | null } | undefined;
  if (sourceParent?.parent_instance_id || sourceBinding?.mode === 'fork') {
    throw new RuntimeError('context_rejected', `Context source ${sourceNodeId} was created by a fork; recursive fork is not supported`);
  }
  if (!request.rebrand && (source.model !== instance.model || source.definition_version !== instance.definition_version)) {
    throw new RuntimeError('context_rejected', `Fork from ${sourceNodeId} changes model or Agent definition; set context.rebrand=true to allow it`);
  }
  const sourceScopeId = ensureBudgetScope(store, input.taskId, source.id);
  shareBudgetScope(store, instance.id, sourceScopeId);
  store.db.prepare('UPDATE instances SET parent_instance_id=? WHERE id=?').run(source.id, instance.id);
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
    constraintsDigest: '',
    budgetScopeId: sourceScopeId,
    ...policyFields,
    ...(request.rebrand ? { rebrand: true } : {}),
    sourceNodeId,
    sourceInstanceId: source.id,
    sourceSessionId: source.session_id,
    sourceSessionFile: source.session_file,
    ...(request.sourceLeafId ? { sourceLeafId: request.sourceLeafId } : {}),
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
    !ref || typeof ref.path !== 'string' || !ref.path.trim() || !/^[a-f0-9]{64}$/.test(ref.digest))) {
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
  const mode: 'fresh' | 'fork' = context.mode === 'fork' ? 'fork' : 'fresh';
  if (!existingBinding) {
    store.db.prepare(`INSERT INTO agent_context_bindings(id,task_id,node_id,instance_id,mode,source_instance_id,
        source_session_id,source_session_file,source_leaf_id,budget_scope_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(context.bindingId, input.taskId, input.nodeId, input.instanceId, mode,
        context.sourceInstanceId ?? null, context.sourceSessionId ?? null, context.sourceSessionFile ?? null,
        context.sourceLeafId ?? null, context.budgetScopeId, Date.now());
  }
  if (mode === 'fork' && !context.rebrand) {
    if (!context.sourceInstanceId) throw new RuntimeError('context_rejected', 'Fork source instance is missing');
    const sourceConstraints = store.db.prepare(`SELECT r.constraints_digest
      FROM agent_context_bindings b
      JOIN context_resolutions r ON r.binding_id=b.id
      WHERE b.instance_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get(context.sourceInstanceId) as { constraints_digest: string } | undefined;
    if (!sourceConstraints?.constraints_digest) {
      throw new RuntimeError('context_rejected', 'Fork source has no frozen constraints digest; set context.rebrand=true to allow it');
    }
    if (sourceConstraints.constraints_digest !== constraintsDigest) {
      throw new RuntimeError('context_rejected', 'Fork source and target constraints differ; set context.rebrand=true to allow it');
    }
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
      context.mode, context.reasonCode, context.sourceInstanceId ?? null, context.bindingId, context.handoffId,
      constraintsDigest, context.reviewPolicy ? canonicalJson(context.reviewPolicy as never) : null, Date.now());
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
  const prior = store.db.prepare('SELECT mode,source_context_digest FROM agent_context_bindings WHERE id=?')
    .get(input.bindingId) as { mode: 'fresh' | 'fork'; source_context_digest: string | null } | undefined;
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
      b.source_context_digest,b.child_context_digest,b.capability_digest,b.model_policy_digest,b.tool_policy_digest,
      b.budget_scope_id,b.created_at,
      r.selected_mode,r.requested_purpose,r.requested_facts,r.independence,r.reason_code,r.operation_id,
      r.constraints_digest,r.review_policy,
      h.digest AS handoff_digest,h.summary AS handoff_summary,
      si.node_id AS source_node_id
    FROM instances i
    LEFT JOIN agent_context_bindings b ON b.instance_id=i.id
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
