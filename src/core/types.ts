export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ProjectConfig { id: string; root: string; grants?: string[] }
export interface NodeSpec {
  id: string;
  kind: 'agent' | 'program';
  action: string;
  dependsOn?: string[];
  input?: Json;
  definitionVersion?: string;
  model?: string;
  role?: 'master' | 'worker';
}
export interface Proposal {
  requirementVersion: number;
  summary: string;
  acceptance: { id: string; description: string; checkNode: string }[];
  nodes: NodeSpec[];
}
export interface Receipt { taskId: string; cursor: number }
export interface ProposalReceipt extends Receipt { proposalVersion: number }
export interface TaskUpdate { cursor: number; taskId: string; type: string; data: Json; timestamp: number }
export interface TaskWatch extends AsyncIterableIterator<TaskUpdate> { return(): Promise<IteratorResult<TaskUpdate>> }

export type { TokenUsage } from '../runtime/call-broker.ts';
import type { TokenUsage } from '../runtime/call-broker.ts';
export interface EvidenceInput { acceptanceId: string; summary: string; artifact: { path: string; digest: string } }
export interface Operation {
  id: string; taskId: string; nodeId: string; instanceId: string | null; generation: number;
  attempt: number; kind: NodeSpec['kind']; action: string; input: Json; dependencies: Record<string, Json>;
  proposalVersion: number; requirementVersion: number;
  context: { previousOutput: Json; answers: { questionId: string; value: Json }[] };
  grants: string[];
}
export interface OperationResult {
  outcome: 'completed' | 'continue' | 'waiting'; output: Json; usage?: TokenUsage | null; evidence?: EvidenceInput[];
  question?: { prompt: string };
}
export type Answer = { type: 'add_budget'; tokens: number } | { type: 'respond'; value: Json } | { type: 'retry' } | { type: 'grant'; grant: string } | { type: 'acknowledge' }
  | { type: 'usage'; usage: TokenUsage; proof: string };
export type Reconciliation =
  | { state: 'completed'; result: OperationResult; quiescent: true; proof: string }
  | { state: 'unknown'; quiescent: boolean; proof: string }
  | { state: 'not_started'; quiescent: true; proof: string };
/** Trusted host adapter: prepare has no external effects; its callback sends one actual operation. */
export interface ActionAdapter {
  kind: NodeSpec['kind']; reserveTokens?: number; grant?: string;
  prepare(operation: Operation): Promise<() => Promise<OperationResult>>;
  reconcile?(operation: Operation): Promise<Reconciliation>;
}

export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'RuntimeError'; this.code = code; }
}
