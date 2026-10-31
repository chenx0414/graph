import type { Json } from '../core/types.ts';
import type { GraphDefinition, NodeDefinition } from '../core/interface-spec.ts';

/** What the console reads out of a node's declared configuration. */
export interface NodeConfigurationSnapshot {
  revision: number;
  definition: NodeDefinition;
  defaults: GraphDefinition['defaults'];
}

export interface NodeConfigurations {
  current: NodeConfigurationSnapshot | null;
  next: NodeConfigurationSnapshot | null;
  pending: boolean;
}

export interface InputExplanation {
  name: string;
  protocol: string;
  delivered: boolean;
  /** True exactly when nothing was ever delivered to this input. */
  missing: boolean;
  value: Json;
  valueTruncated: boolean; valueBytes: number; valuePreview: string | null;
  source: string | null;
  updatedAt: number | null;
}

export interface TransitionExplanation {
  cursor: number; payloadTruncated: boolean; payloadBytes: number; payloadPreview: string | null;
  id: string;
  inputName: string;
  inputValue: Json;
  stateBefore: Json;
  stateAfter: Json;
  /** The verdict text, or null when this record judged nothing (e.g. a reopen). */
  verdict: string | null;
  outputs: Record<string, Json>;
  ruleVersion: number;
  reason: string;
  createdAt: number;
}

export interface ModuleExplanation {
  moduleId: string;
  type: string;
  /** `each` judges on every update; `once` latches after it fires. */
  trigger: string;
  /** Whether a `once` module has fired and is now latched. */
  triggered: boolean;
  state: Json;
  stateTruncated: boolean; stateBytes: number; statePreview: string | null;
  latestTransition: number | null; nextAfter: number | null;
  ruleVersion: number;
  inputs: InputExplanation[];
  transitions: TransitionExplanation[];
}

/** One published artifact, as the console lists and renders it. */
export type ArtifactScope = 'task' | 'project';
export type ArtifactTrust = 'unverified' | 'reviewed' | 'accepted';
export type ArtifactState = 'published' | 'retired';

export interface ArtifactProducer {
  nodeId: string;
  instanceId: string;
  operationId: string;
  activationId: string;
  outputVersion?: number;
}

export interface ArtifactRecord {
  artifactId: string;
  version: number;
  scope: ArtifactScope;
  ownerId: string;
  taskId: string;
  projectId: string | null;
  namespace: string;
  name: string;
  logicalKey: string;
  digest: string;
  objectPath: string;
  size: number;
  mediaType: string;
  schemaKind: string | null;
  schemaVersion: number | null;
  title: string | null;
  summary: string | null;
  tags: string[];
  producer: ArtifactProducer | null;
  visibility: string;
  trust: ArtifactTrust;
  state: ArtifactState;
  supersedes: { artifactId: string; version: number } | null;
  metadata: Record<string, unknown>;
  uri: string;
  createdAt: number;
  retiredAt: number | null;
}
