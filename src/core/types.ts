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
export interface ContextRequest {
  purpose?: ContextPurpose;
  /** Another Agent node in the same graph whose transcript may be required. */
  sourceNode?: string;
  /** Optional immutable entry id; omitted means the source's current leaf. */
  sourceLeafId?: string;
  requiredFacts?: ContextFactRef[];
  independence?: ContextIndependence;
  /** Explicitly allow a fork to use a different model, definition or capability bundle. */
  rebrand?: boolean;
  reason?: string;
}
export type AgentContextMode = 'continue' | 'fresh' | 'fork';
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
  budgetScopeId: string;
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
export interface EvidenceInput { acceptanceId: string; summary: string; artifact: { path: string; digest: string } }
export interface ArtifactInput { id: string; path: string; digest: string }
export interface ArtifactVersion extends ArtifactInput { nodeId: string; operationId: string; activationId: string }
export interface DependencySource { nodeId: string; operationId: string; activationId: string; outputVersion: number; artifacts: ArtifactVersion[] }
export interface Operation {
  id: string; taskId: string; nodeId: string; instanceId: string | null; generation: number;
  attempt: number; kind: NodeSpec['kind']; action: string; input: Json; dependencies: Record<string, Json>;
  proposalVersion: number; requirementVersion: number;
  context: {
    previousOutput: Json;
    answers: { questionId: string; value: Json }[];
    messages?: { id?: string; text: string; requirementVersion: number; attachments?: AttachmentInput[] }[];
    briefing?: string;
    agentContext?: ResolvedAgentContext;
  };
  grants: string[];
  activationId: string; graphVersion: number;
  dependencySources: Record<string, DependencySource[]>;
  inputVersions: Record<string, { activationId: string; outputVersion: number }[]>;
  workspace?: string;
}
export interface AttachmentInput { name: string; type: string; size: number; text: string }
export interface OperationResult {
  outcome: 'completed' | 'continue' | 'waiting' | 'failed' | 'skipped'; output: Json; usage?: TokenUsage | null; evidence?: EvidenceInput[];
  question?: { prompt: string; grant?: string; data?: Json };
  route?: string;
  artifacts?: ArtifactInput[];
}
export type Answer = { type: 'add_budget'; tokens: number } | { type: 'respond'; value: Json } | { type: 'retry' } | { type: 'grant'; grant: string } | { type: 'acknowledge' }
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
}

export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'RuntimeError'; this.code = code; }
}
