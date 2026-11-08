import type { Json } from './types.ts';


export interface ProtocolSpec {
  type: string;
  version?: number;
  required?: string[];
  properties?: Record<string, Json>;
  [key: string]: Json | undefined;
}

export interface ProtocolRef {
  protocol: string;
  version?: number;
}

export interface NodeInterface {
  inputs: Record<string, ProtocolRef>;
  outputs: Record<string, ProtocolRef>;
}

export interface ExecutionSettings {
  model?: string;
  retry?: { automatic?: number; resubmit?: number };
  budget?: { tokens: number | null };
}

export interface NodeDefinition extends NodeInterface, ExecutionSettings {
  recipe: string;
  task: string;
  instructions?: string;
  workspace?: { base: 'auto' | 'project' | 'worktree'; path?: string };
  acceptance?: string[];
  submission: { required?: string[]; requiredAnyOf?: string[] };
  deliverable?: {
    path: string;
    namespace: 'plans' | 'research' | 'reviews' | 'deliverables' | 'summaries';
    name: string;
    title?: string;
    summary?: string;
    schema?: string;
  };
}

export interface ModuleDefinition {
  type: 'router' | 'command' | 'operation';
  trigger: 'each' | 'once';
  inputs: Record<string, ProtocolRef>;
  outputs: Record<string, ProtocolRef>;
  requiredInputs?: string[];
  control?: { reopen: string };
  limits?: { timeoutMs?: number; memoryMb?: number; inputBytes?: number; outputBytes?: number; stateBytes?: number };
  rules?: ModuleRule[];
  code?: { entry: string; version: number };
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
  subgraphs?: string[];
  templates?: Record<string, { version: number; definition: GraphDefinition }>;
  instances?: Record<string, { template: string; version: number }>;
  subgraphInstances?: Record<string, { template: string; version: number; inputs: Record<string, GraphIo>; outputs: Record<string, GraphOutput> }>;

}
