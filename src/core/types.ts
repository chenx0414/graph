import type { GraphDefinition } from './interface-spec.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

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
  decisions?: string[];
}
export interface NativeProposal extends ProposalScope {
  definition: GraphDefinition;
}
export interface Receipt { taskId: string; cursor: number }
export interface TaskUpdate { cursor: number; taskId: string; type: string; data: Json; timestamp: number }
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
    outputSchema?: { kind: 'agent_result'; version: number };
  };
  grants: string[];
  accessPolicy?: ResolvedAccessPolicy;
  activationId: string; graphVersion: number;
  dependencySources: Record<string, DependencySource[]>;
  inputVersions: Record<string, { activationId: string; outputVersion: number }[]>;
  workspace?: string;
}
export interface AttachmentInput { name: string; type: string; size: number; text: string; data?: string }
export interface OperationResult {
  outcome: 'completed' | 'continue' | 'waiting' | 'failed' | 'skipped'; output: Json; usage?: TokenUsage | null; evidence?: EvidenceInput[];
  question?: { prompt: string; grant?: string; data?: Json };
  artifacts?: ArtifactInput[];
}
export type Answer = { type: 'respond'; value: Json } | { type: 'retry' } | { type: 'grant'; grant: string } | { type: 'acknowledge' }
  | { type: 'reject'; reason?: string }
  | { type: 'usage'; usage: TokenUsage; proof: string }
  | { type: 'reconcile_usage'; proof: string };
export type Reconciliation =
  | { state: 'completed'; result: OperationResult; quiescent: true; proof: string }
  | { state: 'unknown'; quiescent: boolean; proof: string }
  | { state: 'not_started'; quiescent: true; proof: string };
export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'RuntimeError'; this.code = code; }
}
