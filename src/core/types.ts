import type { VerifierConfig } from './verification.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ProjectConfig { id: string; root: string; grants?: string[] }
export type ContextPurpose = 'discuss' | 'explore' | 'implement' | 'review' | 'verify' | 'rework';
export type ContextIndependence = 'none' | 'fresh' | 'model-excluded';
export type ContextFactKind = 'artifact' | 'decision' | 'file' | 'transcript_range' | 'tool_call';
export interface ContextFactRef {
  kind: ContextFactKind;
  ref?: string;
  from?: string;
  to?: string;
}
export type PredecessorHandoffMode = 'evidence_only' | 'result_handoff';
export interface PredecessorHandoffPolicy {
  /** A direct dependency entry on the receiving Agent node. */
  source: string;
  mode: PredecessorHandoffMode;
  /** Required result schema for result_handoff; defaults to result_handoff@1. */
  resultSchema?: { kind: string; version: number };
  /** Upper bound applied to the model-visible predecessor summary. */
  maxSummaryChars?: number;
}
export interface ContextRequest {
  purpose?: ContextPurpose;
  /** Another Agent node in the same graph whose transcript may be required. */
  sourceNode?: string;
  /** Optional immutable entry id; omitted means the source's current leaf. */
  sourceLeafId?: string;
  requiredFacts?: ContextFactRef[];
  /** Incoming edge policy for Fresh context assembly. Omitted edges use result_handoff except for independent review/verification, which use evidence_only. */
  predecessors?: PredecessorHandoffPolicy[];
  independence?: ContextIndependence;
  /** Explicitly allow a fork to use a different model, definition or capability bundle. */
  rebrand?: boolean;
  reason?: string;
}
export type AgentContextMode = 'continue' | 'fresh' | 'fork';
export interface ResultHandoffDraft {
  schemaVersion: 1;
  objective: string;
  outcome: 'completed' | 'partial' | 'blocked';
  workSummary: string;
  changes: {
    kind: 'file' | 'artifact' | 'external';
    path?: string;
    digest?: string;
    artifactId?: string;
    version?: number;
    uri?: string;
    summary: string;
  }[];
  decisions: {
    decision: string;
    rationale: string;
    evidenceRefs: string[];
  }[];
  verification: {
    summary: string;
    result: 'pass' | 'fail' | 'unknown';
    evidenceRefs: string[];
  }[];
  knownLimits: string[];
  openQuestions: string[];
  nextActions: string[];
}
export interface ResultHandoff extends ResultHandoffDraft {
  source: {
    nodeId: string;
    instanceId: string;
    operationId: string;
    activationId: string;
    outputVersion: number;
    operationResultDigest: string;
  };
}
export interface PredecessorHandoffProjection {
  sourceNodeId: string;
  sourceInstanceId: string | null;
  sourceOperationId: string;
  sourceActivationId: string;
  outputVersion: number;
  mode: PredecessorHandoffMode;
  artifactRefs: { path: string; digest: string; artifactId?: string; version?: number; uri?: string }[];
  evidenceRefs: { acceptanceId: string; summary: string; path: string; digest: string }[];
  resultHandoff?: ResultHandoff;
  resultHandoffDigest?: string;
  resultHandoffSchema?: { kind: string; version: number };
  resultHandoffBytes?: number;
}
export interface ReviewIndependencePolicy {
  freshRequired: true;
  evidenceOnly: true;
  excludedModels: string[];
  allowedTools: string[] | null;
  reportSchema: { kind: string; version: number };
}
export interface ContextHandoffPackage {
  mode: AgentContextMode;
  purpose: ContextPurpose;
  independence: ContextIndependence;
  requestedFacts: ContextFactRef[];
  reasonCode: string;
  sourceNodeId: string | null;
  sourceInstanceId: string | null;
  sourceSessionId: string | null;
  sourceLeafId: string | null;
  summary: string;
  decisions: string[];
  acceptance: { id: string; description: string; checkNode: string }[];
  artifactRefs: { path: string; digest: string; artifactId?: string; version?: number; uri?: string }[];
  predecessorPolicies: PredecessorHandoffPolicy[];
  predecessorHandoffs: PredecessorHandoffProjection[];
  outputSchema: { kind: string; version: number };
  briefing: string;
}
export interface ResolvedAgentContext {
  mode: AgentContextMode;
  purpose: ContextPurpose;
  independence: ContextIndependence;
  requestedFacts: ContextFactRef[];
  reasonCode: string;
  bindingId: string;
  resolutionId: string;
  handoffId: string;
  handoffDigest: string;
  constraintsDigest: string;
  budgetScopeId: string;
  modelPolicyDigest?: string;
  toolPolicyDigest?: string;
  reviewPolicy?: ReviewIndependencePolicy;
  sourceNodeId?: string;
  sourceInstanceId?: string;
  sourceSessionId?: string;
  sourceSessionFile?: string;
  sourceLeafId?: string;
  rebrand?: boolean;
}
export interface NodeSpec {
  id: string;
  kind: 'agent' | 'program';
  action: string;
  dependsOn?: string[];
  input?: Json;
  definitionVersion?: string;
  model?: string;
  role?: 'master' | 'worker';
  container?: string;
  routes?: string[];
  when?: { node: string; case: string };
  optional?: boolean;
  verifier?: VerifierConfig;
  replaces?: string;
  context?: ContextRequest;
}
export interface ContainerSpec { id: string; parent?: string; dependsOn?: string[]; when?: { node: string; case: string }; outputs: string[] }
export interface LoopSpec { from: string; to: string }
export interface Proposal {
  requirementVersion: number;
  summary: string;
  acceptance: { id: string; description: string; checkNode: string }[];
  nodes: NodeSpec[];
  containers?: ContainerSpec[];
  loops?: LoopSpec[];
  /** Master-authored decisions/constraints frozen with this draft version. */
  decisions?: string[];
}
export interface Receipt { taskId: string; cursor: number }
export interface ProposalReceipt extends Receipt { proposalVersion: number }
export interface TaskUpdate { cursor: number; taskId: string; type: string; data: Json; timestamp: number }
export interface TaskWatch extends AsyncIterableIterator<TaskUpdate> { return(): Promise<IteratorResult<TaskUpdate>> }

export type { TokenUsage } from '../runtime/call-broker.ts';
import type { TokenUsage } from '../runtime/call-broker.ts';
import type { ResolvedAccessPolicy } from './access-policy.ts';
export interface ArtifactReference {
  path: string;
  digest: string;
  artifactId?: string;
  version?: number;
  uri?: string;
}
export interface EvidenceInput { acceptanceId: string; summary: string; artifact: ArtifactReference }
export interface ArtifactInput extends ArtifactReference { id: string }
export interface ArtifactVersion extends ArtifactInput { nodeId: string; operationId: string; activationId: string }
export interface DependencySource {
  nodeId: string;
  instanceId: string | null;
  operationId: string;
  activationId: string;
  outputVersion: number;
  artifacts: ArtifactVersion[];
}
export interface Operation {
  id: string; taskId: string; nodeId: string; instanceId: string | null; generation: number;
  attempt: number; kind: NodeSpec['kind']; action: string; input: Json; dependencies: Record<string, Json>;
  proposalVersion: number; requirementVersion: number;
  context: {
    previousOutput: Json;
    rsiContinuation?: { requestId: string; operationId: string; commit: string };
    answers: { questionId: string; value: Json }[];
    messages?: {
      id?: string;
      text: string;
      requirementVersion: number;
      attachments?: AttachmentInput[];
      command?: 'compact';
    }[];
    briefing?: string;
    agentContext?: ResolvedAgentContext;
    /** Structured result this operation must submit, so tools can validate in-turn. */
    outputSchema?: { kind: 'agent_result' | 'result_handoff' | 'independent_review'; version: number };
  };
  grants: string[];
  /** Effective access policy frozen when this operation was admitted. */
  accessPolicy?: ResolvedAccessPolicy;
  activationId: string; graphVersion: number;
  dependencySources: Record<string, DependencySource[]>;
  inputVersions: Record<string, { activationId: string; outputVersion: number }[]>;
  workspace?: string;
}
/** A user-supplied attachment. Text files carry their body in `text`; image
 * files carry base64 bytes in `data` and an image mime in `type`, with `text`
 * left empty. The base64 payload is never written to disk and never returned
 * by the conversation view. */
export interface AttachmentInput { name: string; type: string; size: number; text: string; data?: string }
export interface OperationResult {
  outcome: 'completed' | 'continue' | 'waiting' | 'failed' | 'skipped'; output: Json; usage?: TokenUsage | null; evidence?: EvidenceInput[];
  /** Structured work-result handoff submitted by an Agent when a downstream edge requires it. */
  resultHandoff?: ResultHandoffDraft;
  question?: { prompt: string; grant?: string; data?: Json };
  route?: string;
  artifacts?: ArtifactInput[];
}
export type Answer = { type: 'add_budget'; tokens: number } | { type: 'respond'; value: Json } | { type: 'retry' } | { type: 'grant'; grant: string } | { type: 'acknowledge' }
  | { type: 'reject'; reason?: string }
  | { type: 'usage'; usage: TokenUsage; proof: string }
  | { type: 'reconcile_usage'; proof: string };
export type Reconciliation =
  | { state: 'completed'; result: OperationResult; quiescent: true; proof: string }
  | { state: 'unknown'; quiescent: boolean; proof: string }
  | { state: 'not_started'; quiescent: true; proof: string };
/** Trusted host adapter: prepare has no external effects; its callback sends one actual operation. */
export interface ActionAdapter {
  kind: NodeSpec['kind']; reserveTokens?: number; grant?: string;
  prepare(operation: Operation): Promise<() => Promise<OperationResult>>;
  /** Deliver a steering message into an already dispatched operation. */
  steer?(operation: Operation, text: string): Promise<void>;
  reconcile?(operation: Operation): Promise<Reconciliation>;
  /** Durable adapter evidence that no session/send began; absence of a receipt alone is insufficient. */
  canReplayBeforeSend?(operation: Operation): boolean;
}

export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'RuntimeError'; this.code = code; }
}
