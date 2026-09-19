import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
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

function hasTranscriptFacts(spec: NodeSpec) {
  return spec.context?.requiredFacts?.some(fact => fact.kind === 'transcript_range' || fact.kind === 'tool_call') ?? false;
}

function independentReviewReceiver(spec: NodeSpec) {
  return spec.context?.purpose === 'review' || spec.context?.purpose === 'verify'
    || (spec.context?.independence !== undefined && spec.context.independence !== 'none')
    || /review|verify|jury|critic/i.test(spec.action)
    || spec.definitionVersion?.startsWith('reviewer@') === true;
}

function freshPredecessorPoliciesApply(spec: NodeSpec) {
  return spec.kind === 'agent'
    && !spec.context?.sourceNode
    && !hasTranscriptFacts(spec)
    && (spec.dependsOn?.length ?? 0) > 0;
}

function implementationReceiver(spec: NodeSpec) {
  return spec.context?.purpose === 'implement' || spec.context?.purpose === 'rework'
    || /work|implement|rework/i.test(spec.action);
}

export function defaultPredecessorHandoffMode(spec: NodeSpec, source?: NodeSpec): PredecessorHandoffMode | undefined {
  if (independentReviewReceiver(spec)) return 'evidence_only';
  if (!source || source.kind !== 'agent' || source.role === 'master') return 'evidence_only';
  return implementationReceiver(spec) ? 'result_handoff' : undefined;
}

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
    const artifactId = change.artifactId === undefined ? undefined : text(change.artifactId, 200);
    const artifactVersion = change.version === undefined
      ? undefined
      : typeof change.version === 'number' ? change.version : null;
    const uri = change.uri === undefined ? undefined : text(change.uri, 500);
    if ((path === undefined) !== (change.path === undefined) || (artifactDigest === undefined) !== (change.digest === undefined)) return undefined;
    if (path && !isAbsolute(path)) return undefined;
    if (artifactDigest && !/^[a-f0-9]{64}$/.test(artifactDigest)) return undefined;
    if ((artifactId === undefined) !== (artifactVersion === undefined)) return undefined;
    if (artifactId && !uri) return undefined;
    if (artifactVersion === null || (artifactVersion !== undefined && (!Number.isSafeInteger(artifactVersion) || artifactVersion < 1))) return undefined;
    if (change.kind === 'file' && (!path || !artifactDigest)) return undefined;
    if (change.kind === 'artifact' && !((path && artifactDigest) || (artifactId && artifactVersion))) return undefined;
    changes.push({
      kind: change.kind as ResultHandoffDraft['changes'][number]['kind'],
      ...(path ? { path } : {}),
      ...(artifactDigest ? { digest: artifactDigest } : {}),
      ...(artifactId ? { artifactId } : {}),
      ...(artifactVersion !== undefined ? { version: artifactVersion } : {}),
      ...(uri ? { uri } : {}),
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

/** Resolve a work-copy-relative path, refusing anything that escapes the workspace. */
function withinWorkspace(workspace: string, path: string) {
  const root = resolve(workspace);
  const target = resolve(root, path);
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? target : undefined;
}

/**
 * Digest the file the worker actually left in its work copy. The host reads the
 * bytes itself, so a handoff never depends on a model-reported digest.
 */
function workspaceDigest(workspace: string | undefined, path: string) {
  if (!workspace) return undefined;
  const target = withinWorkspace(workspace, path);
  if (!target) return undefined;
  try {
    return createHash('sha256').update(readFileSync(target)).digest('hex');
  } catch {
    return undefined;
  }
}

export interface ResultHandoffRecoveryContext {
  workspace?: string;
  /**
   * Recorded identity for an artifact the worker named loosely, such as the
   * logical `namespace/name` instead of the id the publish call returned.
   */
  rebindArtifact?(change: { artifactId?: unknown; version?: unknown; uri?: unknown }): {
    artifactId: string; version: number; digest?: string;
  } | undefined;
}

/** Read a version the worker wrote as either a number or a numeric string. */
function versionNumber(value: unknown) {
  const version = typeof value === 'number' ? value
    : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined;
  return version !== undefined && Number.isSafeInteger(version) && version > 0 ? version : undefined;
}

/**
 * Rebuild an admissible draft from a submission the worker wrote against its own
 * work copy: relative file paths are resolved inside the operation workspace,
 * their digests recomputed from the bytes on disk, and loose artifact references
 * bound to the recorded version. Anything that cannot be tied to real workspace
 * or recorded artifact content still fails closed.
 */
export function recoverResultHandoffDraft(value: Json | undefined, context: ResultHandoffRecoveryContext) {
  const direct = normalizeDraft(value);
  if (direct || !value || typeof value !== 'object' || Array.isArray(value)) return direct;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.changes)) return undefined;
  const changes = raw.changes.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const change = { ...(item as Record<string, unknown>) };
    if (typeof change.path === 'string' && context.workspace) {
      const target = withinWorkspace(context.workspace, change.path);
      if (target) {
        change.path = target;
        const actual = workspaceDigest(context.workspace, target);
        if (actual) change.digest = actual;
      }
    }
    const bound = context.rebindArtifact?.(change);
    if (bound) {
      change.artifactId = bound.artifactId;
      change.version = bound.version;
      if (bound.digest) change.digest = bound.digest;
    }
    return change;
  });
  return normalizeDraft({ ...raw, changes });
}

export function validatePredecessorPolicies(proposal: Proposal, plan: GraphPlan, nodes: Map<string, NodeSpec>) {
  const invalid = (reason: string): never => { throw new RuntimeError('invalid_proposal', reason); };
  for (const node of proposal.nodes) {
    const { policies, orphaned, missing } = predecessorPoliciesForNode(node, nodes);
    if (orphaned.length) invalid(`Unknown predecessor handoff source ${orphaned[0]!.source}`);
    if (missing.length) invalid(`Fresh predecessor edge ${missing[0]} requires an explicit handoff policy`);
    if (!policies.length) continue;
    if (node.kind !== 'agent') invalid('Only Agent nodes may declare predecessor handoff policies');
    if (hasTranscriptFacts(node)) {
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
        }
      }
      if (independentReviewReceiver(node) && policy.mode !== 'evidence_only') {
        invalid('Independent review and verification require evidence_only predecessor handoff');
      }
    }
  }
}

export function predecessorPoliciesForNode(spec: NodeSpec, sourceNodes?: Map<string, NodeSpec>) {
  const explicit = new Map((spec.context?.predecessors ?? []).map(policy => [policy.source, policy]));
  if (!freshPredecessorPoliciesApply(spec)) {
    return { policies: [], orphaned: [...explicit.values()], missing: [] };
  }
  const policies: PredecessorHandoffPolicy[] = [];
  const missing: string[] = [];
  for (const source of spec.dependsOn ?? []) {
    const policy = explicit.get(source);
    if (policy) policies.push(policy);
    else {
      const mode = defaultPredecessorHandoffMode(spec, sourceNodes?.get(source));
      if (mode) policies.push({ source, mode });
      else missing.push(source);
    }
    explicit.delete(source);
  }
  return { policies, orphaned: [...explicit.values()], missing };
}

export function predecessorPolicyDigest(policies: PredecessorHandoffPolicy[]) {
  return digest(policies);
}

function resultSourcesByNode(proposal: Proposal, plan: GraphPlan) {
  const sources = new Set<string>();
  for (const node of proposal.nodes) {
    for (const policy of predecessorPoliciesForNode(node, plan.nodes).policies) {
      if (policy.mode !== 'result_handoff') continue;
      for (const leaf of plan.leaves(policy.source)) sources.add(leaf);
    }
  }
  return sources;
}

function resultPoliciesForSource(proposal: Proposal, nodeId: string, plan: GraphPlan) {
  const policies: PredecessorHandoffPolicy[] = [];
  for (const node of proposal.nodes) {
    for (const policy of predecessorPoliciesForNode(node, plan.nodes).policies) {
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

export function resultHandoffDependents(proposal: Proposal, sourceNodeId: string) {
  const plan = new GraphPlan(proposal);
  return proposal.nodes
    .filter(node => predecessorPoliciesForNode(node, plan.nodes).policies.some(policy =>
      policy.mode === 'result_handoff' && plan.leaves(policy.source).includes(sourceNodeId)))
    .map(node => node.id);
}

export function outputSchemaForNode(proposal: Proposal, nodeId: string) {
  return requiresResultHandoff(proposal, nodeId) ? DEFAULT_RESULT_SCHEMA : { kind: 'agent_result', version: 1 } as const;
}

function evidenceProjection(store: TaskStore, source: {
  nodeId: string;
  operationId: string;
  activationId: string;
  outputVersion: number;
  artifacts: { path: string; digest: string; artifactId?: string; version?: number; uri?: string }[];
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
      artifactRefs: source.artifacts.map(artifact => ({
        path: artifact.path,
        digest: artifact.digest,
        ...(artifact.artifactId ? { artifactId: artifact.artifactId } : {}),
        ...(artifact.version !== undefined ? { version: artifact.version } : {}),
        ...(artifact.uri ? { uri: artifact.uri } : {}),
      })),
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
  const { policies, orphaned, missing } = predecessorPoliciesForNode(spec, graph.plan.nodes);
  if (orphaned.length) throw new RuntimeError('invalid_adapter', `Unknown predecessor handoff source ${orphaned[0]!.source}`);
  if (missing.length) throw new RuntimeError('invalid_adapter', `Missing predecessor handoff policy for ${missing[0]}`);
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

export function resultHandoffFailure(result: OperationResult) {
  if (result.outcome !== 'failed' || !result.output || typeof result.output !== 'object' || Array.isArray(result.output)) return undefined;
  const error = (result.output as Record<string, unknown>).error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const details = error as Record<string, unknown>;
  if (details.code !== 'result_handoff_invalid') return undefined;
  return { reason: typeof details.reason === 'string' ? details.reason : 'Result handoff validation failed' };
}

export interface ResultHandoffRepair {
  operationId: string;
  reason: string;
  submitted: Json;
}

/**
 * The latest settled attempt on this activation, when its only remaining defect
 * is the handoff its worker submitted. That work is already on disk, so a retry
 * must reconcile the submission instead of running the task briefing again.
 */
export function resultHandoffRepair(store: TaskStore, input: { taskId: string; nodeId: string; activationId: string }): ResultHandoffRepair | undefined {
  const row = store.db.prepare(`SELECT id,result FROM operations
    WHERE task_id=? AND node_id=? AND activation_id=? AND result IS NOT NULL
    ORDER BY rowid DESC LIMIT 1`).get(input.taskId, input.nodeId, input.activationId) as { id: string; result: string } | undefined;
  if (!row) return undefined;
  const result = JSON.parse(row.result) as OperationResult;
  const failure = resultHandoffFailure(result);
  if (!failure) return undefined;
  const output = result.output as Record<string, unknown>;
  return { operationId: row.id, reason: failure.reason, submitted: (output.previousOutput ?? null) as Json };
}

/**
 * A retry after landed work carries the failure and the previous submission,
 * never the original task briefing, and asks for the submission to be repaired
 * instead of the implementation to be redone.
 */
export function renderResultHandoffRepair(repair: ResultHandoffRepair) {
  const submitted = JSON.stringify(repair.submitted, null, 2);
  return [
    `Retry after a failed handoff on operation ${repair.operationId}.`,
    `Failure: ${repair.reason}`,
    'The previous attempt already did the work in this work copy. Reconcile the submission instead of redoing the implementation:',
    '- Do not rewrite, re-create or re-explore files the previous attempt already produced.',
    '- Resubmit the same work through submit_result, corrected to the required schema.',
    '- If the work is genuinely incomplete, report outcome "partial" or "blocked" with the remaining gap instead of starting over.',
    'Previous submission (repair this, do not discard it):',
    submitted.length > 12_000 ? `${submitted.slice(0, 12_000)}\n…truncated` : submitted,
  ].join('\n');
}

function submittedDraft(result: OperationResult) {
  const direct = normalizeDraft(result.resultHandoff);
  if (direct) return direct;
  if (!result.output || typeof result.output !== 'object' || Array.isArray(result.output)) return undefined;
  return normalizeDraft((result.output as Record<string, unknown>).resultHandoff);
}

/**
 * Every place an unnormalised handoff can hide. Adapters normalise a valid
 * submission into result.resultHandoff; when normalisation rejects it, the
 * untouched submission is still in the operation output, either nested under
 * "resultHandoff" or as the output itself.
 */
function recoveryCandidates(result: OperationResult): Json[] {
  const candidates: Json[] = [];
  if (result.resultHandoff !== undefined) candidates.push(result.resultHandoff as unknown as Json);
  if (result.output && typeof result.output === 'object' && !Array.isArray(result.output)) {
    const nested = (result.output as Record<string, unknown>).resultHandoff;
    if (nested !== undefined) candidates.push(nested as Json);
  }
  if (result.output !== undefined) candidates.push(result.output);
  return candidates;
}

/** The namespace/name a worker may write instead of the published artifact id. */
function logicalArtifactRef(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const marker = '/artifacts/';
  const at = value.indexOf(marker);
  const parts = (at >= 0 ? value.slice(at + marker.length) : value).replace(/@[0-9]+$/, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  try {
    return { namespace: decodeURIComponent(parts[0]), name: decodeURIComponent(parts[1]) };
  } catch {
    return undefined;
  }
}

/**
 * What the host recorded for an artifact this worker published. Accepts the id
 * the publish call returned, or the logical reference the worker wrote instead,
 * and always answers with the recorded identity and digest.
 */
function recordedArtifact(store: TaskStore, taskId: string, change: { artifactId?: unknown; version?: unknown; uri?: unknown }) {
  const version = versionNumber(change.version);
  if (version === undefined) return undefined;
  const columns = 'artifact_id,version,digest';
  if (typeof change.artifactId === 'string') {
    const direct = store.db.prepare(`SELECT ${columns} FROM artifacts WHERE task_id=? AND artifact_id=? AND version=?`)
      .get(taskId, change.artifactId, version) as { artifact_id: string; version: number; digest: string } | undefined;
    if (direct) return { artifactId: direct.artifact_id, version: Number(direct.version), digest: direct.digest };
  }
  const logical = logicalArtifactRef(change.uri) ?? logicalArtifactRef(change.artifactId);
  if (!logical) return undefined;
  const row = store.db.prepare(`SELECT ${columns} FROM artifacts
    WHERE task_id=? AND namespace=? AND name=? AND version=? AND state='published'`)
    .get(taskId, logical.namespace, logical.name, version) as { artifact_id: string; version: number; digest: string } | undefined;
  return row ? { artifactId: row.artifact_id, version: Number(row.version), digest: row.digest } : undefined;
}

export function settleResultHandoff(
  store: TaskStore,
  operation: Operation,
  proposal: Proposal,
  result: OperationResult,
) {
  if (!requiresResultHandoff(proposal, operation.nodeId) || result.outcome !== 'completed') return result;
  const recovery: ResultHandoffRecoveryContext = {
    ...(operation.workspace ? { workspace: operation.workspace } : {}),
    rebindArtifact: change => recordedArtifact(store, operation.taskId, change),
  };
  const draft = submittedDraft(result)
    ?? recoveryCandidates(result).reduce<ResultHandoffDraft | undefined>(
      (found, candidate) => found ?? recoverResultHandoffDraft(candidate, recovery), undefined);
  if (!draft) return failedHandoffResult(result, 'A downstream edge requires a valid result_handoff@1 submission');
  const summaryLimit = resultSummaryLimit(proposal, operation.nodeId);
  if (draft.workSummary.length > summaryLimit) {
    return failedHandoffResult(result, `Result handoff workSummary exceeds the downstream limit of ${summaryLimit} characters`);
  }
  const artifacts = new Set((result.artifacts ?? []).map(artifact => `${artifact.path}\u0000${artifact.digest}`));
  const invalidArtifact = draft.changes.find(change =>
    change.path && change.digest && !artifacts.has(`${change.path}\u0000${change.digest}`)
      && workspaceDigest(operation.workspace, change.path) !== change.digest);
  if (invalidArtifact) {
    return failedHandoffResult(result, `Result handoff artifact reference does not match the operation result: ${invalidArtifact.path}`);
  }
  const invalidSharedArtifact = draft.changes.find(change => {
    if (!change.artifactId || change.version === undefined) return false;
    return !store.db.prepare('SELECT 1 FROM artifacts WHERE artifact_id=? AND version=?')
      .get(change.artifactId, change.version);
  });
  if (invalidSharedArtifact) {
    return failedHandoffResult(result, `Result handoff shared artifact does not exist: ${invalidSharedArtifact.artifactId}@${invalidSharedArtifact.version}`);
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
      lines.push(`  Artifacts: ${projection.artifactRefs.map(item =>
        `${item.uri ?? item.path} (${item.digest})`).join('; ')}`);
    }
    if (projection.evidenceRefs.length) {
      lines.push(`  Evidence: ${projection.evidenceRefs.map(item => `${item.acceptanceId}: ${item.path} (${item.digest})`).join('; ')}`);
    }
  }
  return lines.join('\n');
}
