import type { AccessPolicy } from './access-policy.ts';
import type { Json } from './types.ts';

/**
 * View names for a Graph definition: protocols, nodes, modules, edges, and subgraph maps.
 * The daemon accepts a definition. This file does not parse or refuse one.
 *
 * Kept separate from the external main `NodeSpec` record in `types.ts`: old DAG fields
 * and context-inheritance settings are retired and are absent from this structure.
 */

/** A JSON-schema-shaped protocol declaration. The target input is the receiving authority (§4). */
export interface ProtocolSpec {
  type: string;
  version?: number;
  required?: string[];
  properties?: Record<string, Json>;
  [key: string]: Json | undefined;
}

export interface ProtocolRef {
  protocol: string;
  /** Explicit version the endpoint promises. Omitted means the protocol's base (v1) declaration. */
  version?: number;
}

export interface NodeInterface {
  /** Named logical inputs, each bound to a protocol. */
  inputs: Record<string, ProtocolRef>;
  /** Named logical outputs, each bound to a protocol. */
  outputs: Record<string, ProtocolRef>;
}

export interface ExecutionSettings {
  /** Configured model connection; selection still enforces review independence. */
  model?: string;
  /** Per-execution limits; omitted fields inherit graph defaults, then 2/1. */
  retry?: { automatic?: number; resubmit?: number };
  /** Cumulative node quota; null requests unlimited within the user's authorization. */
  budget?: { tokens: number | null };
}

export type NodeAccessPolicy = Partial<Omit<AccessPolicy, 'autoApprove' | 'filesystem' | 'piExtensions'>> & {
  mode: AccessPolicy['mode']; autoApprove?: Partial<AccessPolicy['autoApprove']>;
  filesystem?: Partial<AccessPolicy['filesystem']>; piExtensions?: Partial<AccessPolicy['piExtensions']>;
};

export interface NodeDefinition extends NodeInterface, ExecutionSettings {
  /** Every node is an agent bound to a versioned recipe; host commands are operation modules. */
  recipe: string;
  task: string;
  /** Complete task guidance; omitted by historical graphs. Does not grant capabilities. */
  instructions?: string;
  /** Omitted preserves automatic private worktree/project selection. Path is relative to that base. */
  workspace?: { base: 'auto' | 'project' | 'worktree'; path?: string };
  /** Explicit node policy, bounded by the host's authorization; omitted inherits the host. */
  access?: NodeAccessPolicy;
  acceptance?: string[];
  /** Required outputs a submission must enable:true (§4). */
  submission: { required?: string[]; requiredAnyOf?: string[] };
  /**
   * A file this node promises to produce. The kernel publishes it as a task-scope
   * artifact when the node's execution completes, so the promise does not depend on the
   * node remembering a tool call, and a declared file that was never written (or is
   * empty) fails the node instead of passing silently.
   */
  deliverable?: {
    /** Path relative to the node's workspace; it may not escape it. */
    path: string;
    namespace: 'plans' | 'research' | 'reviews' | 'deliverables' | 'summaries';
    name: string;
    title?: string;
    summary?: string;
    /** Published content interpretation, for example graph.review@1. */
    schema?: string;
  };
}

export interface ModuleDefinition {
  type: 'router' | 'command' | 'operation';
  trigger: 'each' | 'once';
  inputs: Record<string, ProtocolRef>;
  outputs: Record<string, ProtocolRef>;
  /** once-modules must name the inputs a rule needs, so a missing field is never read as false (§4). */
  requiredInputs?: string[];
  /** An explicit input which only clears the once latch; held values remain. */
  control?: { reopen: string };
  limits?: { timeoutMs?: number; memoryMb?: number; inputBytes?: number; outputBytes?: number; stateBytes?: number };
  rules?: ModuleRule[];
  /**
   * A command module's main-authored code (§9): an entry file exporting
   * `evaluate({inputs,state,trigger})`, plus the version this instance runs. The
   * code is never imported into the daemon; it runs in the isolated module process.
   */
  code?: { entry: string; version: number };
  /** Trusted host operation; it shares input, latch and delivery semantics with routers. */
  operation?: { action: 'workspace.command'; version: number; command: string; args: string[];
    output: string; timeoutMs?: number; sandbox?: boolean };

}

export interface ModuleRule {
  when: string;
  emit: Record<string, Json>;
}

export interface EdgeDefinition {
  from: string;
  to: string;
  enabled: boolean;
}

export interface GraphIo {
  to: string;
  protocol: string;
  version?: number;
}

export interface GraphOutput {
  from: string;
  protocol: string;
  version?: number;
}

export interface CompletionDeclaration {
  on: string;
  drain?: boolean;
}

/** Final evidence is independent of routing state and node task descriptions. */
export type AcceptanceCriterion = { id: string; description: string } & (
  { kind: 'check'; module: string } | { kind: 'review'; node: string } | { kind: 'human' }
);

export interface GraphDefinition {
  schemaVersion: number;
  name: string;
  protocols: Record<string, ProtocolSpec>;
  nodes: Record<string, NodeDefinition>;
  modules: Record<string, ModuleDefinition>;
  edges: Record<string, EdgeDefinition>;
  inputs: Record<string, GraphIo>;
  outputs: Record<string, GraphOutput>;
  completion?: CompletionDeclaration;
  acceptance?: AcceptanceCriterion[];
  defaults?: ExecutionSettings;
  /** True when a subgraph was expanded: its public io is mapped in, never scheduled separately (§9). */
  subgraphs?: string[];
  templates?: Record<string, { version: number; definition: GraphDefinition }>;
  instances?: Record<string, { template: string; version: number }>;
  subgraphInstances?: Record<string, { template: string; version: number; inputs: Record<string, GraphIo>; outputs: Record<string, GraphOutput> }>;

}
