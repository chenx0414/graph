import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './context.ts';
import { GraphPlan, type GraphState } from './graph.ts';
import { canonicalJson, type TaskStore } from './store.ts';
import {
  RuntimeError,
  type Json,
  type NodeSpec,
  type Operation,
  type OperationResult,
  type PredecessorHandoffMode,
  type PredecessorHandoffPolicy,
  type PredecessorHandoffProjection,
  type Proposal,
  type ResultHandoff,
  type ResultHandoffDraft,
} from './types.ts';

const DEFAULT_RESULT_SCHEMA = { kind: 'result_handoff', version: 1 } as const;
const DEFAULT_MAX_SUMMARY_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 4_000;

function operationResultDigest(result: OperationResult) {
  return digest({
    outcome: result.outcome,
    output: result.output,
    evidence: result.evidence ?? [],
    artifacts: result.artifacts ?? [],
    route: result.route ?? null,
  });
}

function text(value: unknown, max: number) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : undefined;
}

function stringList(value: unknown, maxItems = 50, maxLength = 500): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const items = value.map(item => text(item, maxLength));
  return items.every((item): item is string => item !== undefined) ? items : undefined;
}

function evidenceRefs(value: unknown): string[] | undefined {
  return stringList(value, 20, 300);
}

function normalizeDraft(value: unknown): ResultHandoffDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return undefined;
  const objective = text(raw.objective, 500);
  const workSummary = text(raw.workSummary, MAX_SUMMARY_CHARS);
  if (!objective || !workSummary) return undefined;
  if (raw.outcome !== 'completed' && raw.outcome !== 'partial' && raw.outcome !== 'blocked') return undefined;

  if (!Array.isArray(raw.changes) || raw.changes.length > 100) return undefined;
  const changes: ResultHandoffDraft['changes'] = [];
  for (const item of raw.changes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const change = item as Record<string, unknown>;
    const summary = text(change.summary, 500);
    if (!summary || !['file', 'artifact', 'external'].includes(String(change.kind))) return undefined;
    const path = change.path === undefined ? undefined : text(change.path, 2_000);
    const artifactDigest = change.digest === undefined ? undefined : text(change.digest, 64);
    if ((path === undefined) !== (change.path === undefined) || (artifactDigest === undefined) !== (change.digest === undefined)) return undefined;
    if (path && !isAbsolute(path)) return undefined;
    if (artifactDigest && !/^[a-f0-9]{64}$/.test(artifactDigest)) return undefined;
    if ((change.kind === 'file' || change.kind === 'artifact') && !path) return undefined;
    if (change.kind === 'artifact' && (!path || !artifactDigest)) return undefined;
    changes.push({
      kind: change.kind as ResultHandoffDraft['changes'][number]['kind'],
      ...(path ? { path } : {}),
      ...(artifactDigest ? { digest: artifactDigest } : {}),
      summary,
    });
  }

  if (!Array.isArray(raw.decisions) || raw.decisions.length > 50) return undefined;
  const decisions: ResultHandoffDraft['decisions'] = [];
  for (const item of raw.decisions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const decision = item as Record<string, unknown>;
    const decisionText = text(decision.decision, 800);
    const rationale = text(decision.rationale, 1_000);
    const refs = evidenceRefs(decision.evidenceRefs ?? []);
    if (!decisionText || !rationale || !refs) return undefined;
    decisions.push({ decision: decisionText, rationale, evidenceRefs: refs });
  }

  if (!Array.isArray(raw.verification) || raw.verification.length > 50) return undefined;
  const verification: ResultHandoffDraft['verification'] = [];
  for (const item of raw.verification) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const check = item as Record<string, unknown>;
    const summary = text(check.summary, 800);
    const refs = evidenceRefs(check.evidenceRefs ?? []);
    if (!summary || !refs || !['pass', 'fail', 'unknown'].includes(String(check.result))) return undefined;
    verification.push({ summary, result: check.result as 'pass' | 'fail' | 'unknown', evidenceRefs: refs });
  }

  const knownLimits = stringList(raw.knownLimits ?? []);
  const openQuestions = stringList(raw.openQuestions ?? []);
  const nextActions = stringList(raw.nextActions ?? []);
  if (!knownLimits || !openQuestions || !nextActions) return undefined;
  return {
    schemaVersion: 1,
    objective,
    outcome: raw.outcome,
    workSummary,
    changes,
    decisions,
    verification,
    knownLimits,
    openQuestions,
    nextActions,
  };
}

export function resultHandoffFromSubmission(value: Json | undefined) {
  return normalizeDraft(value);
}

export function validatePredecessorPolicies(proposal: Proposal, plan: GraphPlan, nodes: Map<string, NodeSpec>) {
  const invalid = (reason: string): never => { throw new RuntimeError('invalid_proposal', reason); };
  for (const node of proposal.nodes) {
    const policies = node.context?.predecessors ?? [];
    if (!policies.length) continue;
    if (node.kind !== 'agent') invalid('Only Agent nodes may declare predecessor handoff policies');
    if (node.context?.requiredFacts?.some(fact => fact.kind === 'transcript_range' || fact.kind === 'tool_call')) {
      invalid('Fork facts cannot be combined with Fresh predecessor handoff policies');
    }
    const sources = new Set<string>();
    for (const policy of policies) {
      if (sources.has(policy.source)) invalid(`Duplicate predecessor handoff policy for ${policy.source}`);
      sources.add(policy.source);
      if (!(node.dependsOn ?? []).includes(policy.source)) invalid(`Predecessor ${policy.source} must be a direct dependency of ${node.id}`);
      if (policy.mode === 'result_handoff') {
        for (const leaf of plan.leaves(policy.source)) {
          const source = nodes.get(leaf);
          if (!source) throw new RuntimeError('invalid_proposal', `Result handoff source ${policy.source} must contain only Agent nodes`);
          if (source.kind !== 'agent') invalid(`Result handoff source ${policy.source} must contain only Agent nodes`);
          if (source.context?.purpose === 'review' || source.context?.purpose === 'verify'
            || source.context?.independence && source.context.independence !== 'none') {
            invalid(`Result handoff source ${policy.source} cannot be an independent review or verification node`);
          }
        }
      }
      if ((node.context?.purpose === 'review' || node.context?.purpose === 'verify'
        || node.context?.independence && node.context.independence !== 'none')
        && policy.mode !== 'evidence_only') {
        invalid('Independent review and verification require evidence_only predecessor handoff');
      }
    }
  }
}

export function predecessorPoliciesForNode(spec: NodeSpec) {
  const explicit = new Map((spec.context?.predecessors ?? []).map(policy => [policy.source, policy]));
  const policies: PredecessorHandoffPolicy[] = [];
  for (const source of spec.dependsOn ?? []) {
    policies.push(explicit.get(source) ?? { source, mode: 'evidence_only' });
    explicit.delete(source);
  }
  return { policies, orphaned: [...explicit.values()] };
}

export function predecessorPolicyDigest(policies: PredecessorHandoffPolicy[]) {
  return digest(policies);
}

function resultSourcesByNode(proposal: Proposal, plan: GraphPlan) {
  const sources = new Set<string>();
  for (const node of proposal.nodes) {
    for (const policy of node.context?.predecessors ?? []) {
      if (policy.mode !== 'result_handoff') continue;
      for (const leaf of plan.leaves(policy.source)) sources.add(leaf);
    }
  }
  return sources;
}

function resultPoliciesForSource(proposal: Proposal, nodeId: string, plan: GraphPlan) {
  const policies: PredecessorHandoffPolicy[] = [];
  for (const node of proposal.nodes) {
    for (const policy of node.context?.predecessors ?? []) {
      if (policy.mode !== 'result_handoff') continue;
      if (plan.leaves(policy.source).includes(nodeId)) policies.push(policy);
    }
  }
  return policies;
}

export function requiresResultHandoff(proposal: Proposal, nodeId: string) {
  return resultSourcesByNode(proposal, new GraphPlan(proposal)).has(nodeId);
}

export function resultSummaryLimit(proposal: Proposal, nodeId: string) {
  const policies = resultPoliciesForSource(proposal, nodeId, new GraphPlan(proposal));
  return policies.length
    ? Math.min(...policies.map(policy => policy.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS))
    : DEFAULT_MAX_SUMMARY_CHARS;
}

export function outputSchemaForNode(proposal: Proposal, nodeId: string) {
  return requiresResultHandoff(proposal, nodeId) ? DEFAULT_RESULT_SCHEMA : { kind: 'agent_result', version: 1 } as const;
}

function evidenceProjection(store: TaskStore, source: {
  nodeId: string;
  operationId: string;
  activationId: string;
  outputVersion: number;
  artifacts: { path: string; digest: string }[];
}): { artifactRefs: { path: string; digest: string }[]; evidenceRefs: PredecessorHandoffProjection['evidenceRefs'] } {
  const rows = store.db.prepare('SELECT data FROM evidence WHERE operation_id=? ORDER BY rowid').all(source.operationId) as { data: string }[];
  const evidenceRefs = rows.flatMap(row => {
    const data = JSON.parse(row.data) as {
      acceptanceId?: string;
      summary?: string;
      artifact?: { path?: string; digest?: string };
    };
    if (!data.acceptanceId || !data.summary || !data.artifact?.path || !data.artifact.digest) return [];
    return [{
      acceptanceId: data.acceptanceId,
      summary: data.summary,
      path: data.artifact.path,
      digest: data.artifact.digest,
    }];
  });
  return {
    artifactRefs: source.artifacts.map(artifact => ({ path: artifact.path, digest: artifact.digest })),
    evidenceRefs,
  };
}

function readResultHandoff(store: TaskStore, source: {
  nodeId: string;
  instanceId: string | null;
  operationId: string;
  activationId: string;
  outputVersion: number;
}, policy: PredecessorHandoffPolicy) {
  const row = store.db.prepare(`SELECT body,digest,schema_kind,schema_version,instance_id FROM result_handoffs
    WHERE node_id=? AND operation_id=? AND activation_id=? AND output_version=?`)
    .get(source.nodeId, source.operationId, source.activationId, source.outputVersion) as {
      body: string;
      digest: string;
      schema_kind: string;
      schema_version: number;
      instance_id: string;
    } | undefined;
  if (!row) throw new RuntimeError('context_rejected', `Result handoff is missing for ${source.nodeId}`);
  const expected = policy.resultSchema ?? DEFAULT_RESULT_SCHEMA;
  if (row.schema_kind !== expected.kind || row.schema_version !== expected.version) {
    throw new RuntimeError('context_rejected', `Result handoff schema mismatch for ${source.nodeId}`);
  }
  const body = JSON.parse(row.body) as ResultHandoff;
  if (digest(body) !== row.digest) throw new RuntimeError('context_rejected', `Result handoff digest mismatch for ${source.nodeId}`);
  if (row.instance_id !== body.source.instanceId || (source.instanceId !== null && source.instanceId !== body.source.instanceId)) {
    throw new RuntimeError('context_rejected', `Result handoff instance mismatch for ${source.nodeId}`);
  }
  const operationRow = store.db.prepare('SELECT result FROM operations WHERE id=?').get(source.operationId) as { result: string | null } | undefined;
  if (!operationRow?.result) throw new RuntimeError('context_rejected', `Result handoff operation result is missing for ${source.nodeId}`);
  const operationResult = JSON.parse(operationRow.result) as OperationResult;
  if (body.source.operationResultDigest !== operationResultDigest(operationResult)) {
    throw new RuntimeError('context_rejected', `Result handoff operation result mismatch for ${source.nodeId}`);
  }
  if (body.source.nodeId !== source.nodeId || body.source.operationId !== source.operationId
    || body.source.activationId !== source.activationId || body.source.outputVersion !== source.outputVersion) {
    throw new RuntimeError('context_rejected', `Result handoff source mismatch for ${source.nodeId}`);
  }
  return {
    body,
    digest: row.digest,
    schema: { kind: row.schema_kind, version: row.schema_version },
    bytes: Buffer.byteLength(row.body, 'utf8'),
  };
}

export function buildPredecessorHandoffs(store: TaskStore, graph: GraphState, spec: NodeSpec) {
  const { policies, orphaned } = predecessorPoliciesForNode(spec);
  if (orphaned.length) throw new RuntimeError('invalid_adapter', `Unknown predecessor handoff source ${orphaned[0]!.source}`);
  const sourceMap = graph.sources(spec.id);
  const projections: PredecessorHandoffProjection[] = [];
  for (const policy of policies) {
    const sources = sourceMap[policy.source] ?? [];
    if (policy.mode === 'result_handoff' && !sources.length) {
      throw new RuntimeError('context_rejected', `Result handoff source ${policy.source} has no completed provenance`);
    }
    for (const source of sources) {
      const evidence = evidenceProjection(store, source);
      if (policy.mode === 'evidence_only') {
        projections.push({
          sourceNodeId: source.nodeId,
          sourceInstanceId: source.instanceId,
          sourceOperationId: source.operationId,
          sourceActivationId: source.activationId,
          outputVersion: source.outputVersion,
          mode: policy.mode,
          ...evidence,
        });
      } else {
        const resultHandoff = readResultHandoff(store, source, policy);
        projections.push({
          sourceNodeId: source.nodeId,
          sourceInstanceId: resultHandoff.body.source.instanceId,
          sourceOperationId: source.operationId,
          sourceActivationId: source.activationId,
          outputVersion: source.outputVersion,
          mode: policy.mode,
          ...evidence,
          resultHandoff: resultHandoff.body,
          resultHandoffDigest: resultHandoff.digest,
          resultHandoffSchema: resultHandoff.schema,
          resultHandoffBytes: resultHandoff.bytes,
        });
      }
    }
  }
  return { policies, projections };
}

function failedHandoffResult(result: OperationResult, reason: string): OperationResult {
  const { resultHandoff: _discarded, ...rest } = result;
  return {
    ...rest,
    outcome: 'failed',
    output: { error: { code: 'result_handoff_invalid', reason }, previousOutput: result.output },
  };
}

export function settleResultHandoff(
  store: TaskStore,
  operation: Operation,
  proposal: Proposal,
  result: OperationResult,
) {
  if (!requiresResultHandoff(proposal, operation.nodeId) || result.outcome !== 'completed') return result;
  const draft = normalizeDraft(result.resultHandoff);
  if (!draft) return failedHandoffResult(result, 'A downstream edge requires a valid result_handoff@1 submission');
  const summaryLimit = resultSummaryLimit(proposal, operation.nodeId);
  if (draft.workSummary.length > summaryLimit) {
    return failedHandoffResult(result, `Result handoff workSummary exceeds the downstream limit of ${summaryLimit} characters`);
  }
  const artifacts = new Set((result.artifacts ?? []).map(artifact => `${artifact.path}\u0000${artifact.digest}`));
  const invalidArtifact = draft.changes.find(change =>
    change.path && change.digest && !artifacts.has(`${change.path}\u0000${change.digest}`));
  if (invalidArtifact) {
    return failedHandoffResult(result, `Result handoff artifact reference does not match the operation result: ${invalidArtifact.path}`);
  }
  const node = store.db.prepare('SELECT instance_id,activation_id,output_version FROM nodes WHERE task_id=? AND id=?')
    .get(operation.taskId, operation.nodeId) as { instance_id: string | null; activation_id: string; output_version: number };
  if (!node.instance_id || node.activation_id !== operation.activationId) {
    return failedHandoffResult(result, 'Result handoff source identity is not available');
  }
  const handoff: ResultHandoff = {
    ...draft,
    source: {
      nodeId: operation.nodeId,
      instanceId: node.instance_id,
      operationId: operation.id,
      activationId: operation.activationId,
      outputVersion: node.output_version + 1,
      operationResultDigest: operationResultDigest(result),
    },
  };
  const handoffDigest = digest(handoff);
  store.db.prepare(`INSERT INTO result_handoffs(
    id,task_id,node_id,instance_id,operation_id,activation_id,output_version,
    schema_kind,schema_version,body,digest,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    randomUUID(),
    operation.taskId,
    operation.nodeId,
    node.instance_id,
    operation.id,
    operation.activationId,
    handoff.source.outputVersion,
    DEFAULT_RESULT_SCHEMA.kind,
    DEFAULT_RESULT_SCHEMA.version,
    canonicalJson(handoff as never),
    handoffDigest,
    Date.now(),
  );
  store.event(operation.taskId, 'context.result_handoff_frozen', {
    nodeId: operation.nodeId,
    operationId: operation.id,
    activationId: operation.activationId,
    outputVersion: handoff.source.outputVersion,
    digest: handoffDigest,
  });
  return result;
}

export function renderPredecessorHandoffs(projections: PredecessorHandoffProjection[]) {
  if (!projections.length) return '';
  const lines = ['Predecessor handoffs:'];
  for (const projection of projections) {
    lines.push(`- ${projection.sourceNodeId} (${projection.mode}, operation ${projection.sourceOperationId}, output v${projection.outputVersion})`);
    if (projection.resultHandoff) {
      const handoff = projection.resultHandoff;
      lines.push(`  Work summary: ${handoff.workSummary}`);
      lines.push(`  Objective: ${handoff.objective}`);
      lines.push(`  Outcome: ${handoff.outcome}`);
      if (handoff.changes.length) lines.push(`  Changes: ${handoff.changes.map(item => item.summary).join('; ')}`);
      if (handoff.decisions.length) lines.push(`  Decisions: ${handoff.decisions.map(item => item.decision).join('; ')}`);
      if (handoff.verification.length) {
        lines.push(`  Verification: ${handoff.verification.map(item => `${item.result}: ${item.summary}`).join('; ')}`);
      }
      if (handoff.knownLimits.length) lines.push(`  Known limits: ${handoff.knownLimits.join('; ')}`);
      if (handoff.openQuestions.length) lines.push(`  Open questions: ${handoff.openQuestions.join('; ')}`);
      if (handoff.nextActions.length) lines.push(`  Next actions: ${handoff.nextActions.join('; ')}`);
    }
    if (projection.artifactRefs.length) {
      lines.push(`  Artifacts: ${projection.artifactRefs.map(item => `${item.path} (${item.digest})`).join('; ')}`);
    }
    if (projection.evidenceRefs.length) {
      lines.push(`  Evidence: ${projection.evidenceRefs.map(item => `${item.acceptanceId}: ${item.path} (${item.digest})`).join('; ')}`);
    }
  }
  return lines.join('\n');
}
