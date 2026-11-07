import type { Json } from '../core/types.ts';

export type CapabilityKind = 'skill' | 'mcp' | 'extension' | 'pi-extension' | 'prompt';
export type CapabilityOrigin = 'library' | 'agent' | 'global' | 'project';

export interface CapabilityRecord {
  id: string;
  kind: CapabilityKind;
  source: string;
  version: string;
  snapshot: Json;
  status: 'available' | 'invalid';
  name?: string;
  description?: string;
  role?: 'agent' | 'tool';
  error?: string;
  owner?: string;
  note?: string;
  origin?: CapabilityOrigin;
  packageSource?: string;
  base?: boolean;
  duplicates?: { id: string; version: string; source: string }[];
}

export type AgentCombinationResourceRole = 'identity' | 'tool' | 'skill' | 'mcp' | 'pi-extension' | 'extension';
export type AgentCombinationMode = 'main' | 'subagent';

export interface AgentCombinationResource {
  resourceId: string;
  version?: string;
  role: AgentCombinationResourceRole;
  required: boolean;
}

export interface AgentCombination {
  id: string;
  name: string;
  description: string;
  mode?: AgentCombinationMode;
  review: boolean;
  tags: string[];
  systemPrompt?: string;
  resources: AgentCombinationResource[];
}

export interface AgentCombinationView extends AgentCombination {
  status: 'valid' | 'invalid';
  issues: string[];
  resolved: {
    resourceId: string;
    version: string;
    role: AgentCombinationResourceRole;
    required: boolean;
    kind: CapabilityRecord['kind'];
    name: string;
  }[];
}

export interface SavedAgentCombination {
  combination: AgentCombinationView;
  definition?: {
    combination: AgentCombinationView;
    definitionId: string;
    definitionVersion: string;
    version: number;
  };
  compileError?: string;
}
