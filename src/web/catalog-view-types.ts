import type { Json } from '../core/types.ts';

/** What the console reads out of the capability library and saved recipes.
 *
 * The library itself is the daemon's: these are the shapes the browser agrees
 * on, declared here so the console does not depend on a TypeScript
 * implementation of the library it never runs.
 */
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
  /** The Agent recipe this entry belongs to, for skills placed in its own folder. */
  owner?: string;
  /** A fact worth showing next to the entry, such as an excluded skill. */
  note?: string;
  /** Where the entry came from; a record without one is a capability-library entry. */
  origin?: CapabilityOrigin;
  /** The declared Pi extension package source, when the SDK resolves it instead of a vendored copy. */
  packageSource?: string;
  /** Every Agent definition receives this capability without binding it. */
  base?: boolean;
  /** Same-name entries the library view folds into this one. */
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
  /** Main Agent recipes are compiled into the definition used by the master role. */
  mode?: AgentCombinationMode;
  review: boolean;
  tags: string[];
  /** Versioned identity and domain instructions edited with this recipe. */
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

/** Result of saving a recipe: the document, and the definition it compiled into. */
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
