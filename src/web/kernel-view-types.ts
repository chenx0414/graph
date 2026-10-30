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
