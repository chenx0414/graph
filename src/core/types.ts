import type { GraphDefinition } from './interface-spec.ts';

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
export type AgentContextMode = 'continue' | 'fresh';
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
  sourceLeafId?: string;
}
/** Internal record for main; graph declarations use NodeDefinition. */
export interface NodeSpec {
  id: string;
  kind: 'agent' | 'program';
  action: string;
  input?: Json;
  definitionVersion?: string;
  model?: string;
  role?: 'master' | 'worker';
}
interface ProposalScope {
  requirementVersion: number;
  summary: string;
  acceptance: { id: string; description: string; checkNode: string }[];
  /** Main-authored decisions/constraints frozen with this draft version. */
  decisions?: string[];
}
/** A declarative graph draft. Main belongs outside its definition. */
export interface NativeProposal extends ProposalScope {
  definition: GraphDefinition;
}
export interface Receipt { taskId: string; cursor: number }
export interface ProposalReceipt extends Receipt { proposalVersion: number; draftRevision: number }
export interface TaskUpdate { cursor: number; taskId: string; type: string; data: Json; timestamp: number }
export interface TaskWatch extends AsyncIterableIterator<TaskUpdate> { return(): Promise<IteratorResult<TaskUpdate>> }

export type { TokenUsage } from './token-usage.ts';
import type { TokenUsage } from './token-usage.ts';
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
    /**
     * Why the harness woke this node, beyond any user message. Present only on a turn
     * that is carrying a wake; the master reads it instead of re-deriving what changed.
     */
    wakes?: { kind: string; dedupeKey: string; taskId: string; data: string | null }[];
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
    outputSchema?: { kind: 'agent_result'; version: number };
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
  question?: { prompt: string; grant?: string; data?: Json };
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
  /** Deliver a steering message into an already dispatched operation. Returns the
   * turn ordinal the injected message was given, so the transcript can keep it at
   * the place it interrupted instead of at the top of the turn. */
  steer?(operation: Operation, text: string): Promise<{ ordinal?: number } | void>;
  /** Abort active model/tool work now. Text, when present, becomes the next
   * prompt in the same session and the operation continues until it settles. */
  interrupt?(operation: Operation, text?: string): Promise<{ ordinal?: number } | void>;
  /** Soft-stop the turn an operation is running: finish the in-flight tool call,
   * then end the turn before the next model request, keeping the session. No-op
   * when the operation has no live session. */
  stop?(operation: Operation): Promise<void>;
  reconcile?(operation: Operation): Promise<Reconciliation>;
  /** Durable adapter evidence that no session/send began; absence of a receipt alone is insufficient. */
  canReplayBeforeSend?(operation: Operation): boolean;
}

export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'RuntimeError'; this.code = code; }
}
