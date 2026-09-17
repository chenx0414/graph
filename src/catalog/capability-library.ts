import { RuntimeError, type Json } from '../core/types.ts';
import {
  compileAgentCombinationDefinition,
  parseAgentCombinations,
  readAgentCombinations,
  validateAgentCombination,
  writeAgentCombinations,
  type AgentCombination,
  type AgentCombinationView,
} from './agent-combinations.ts';
import { scanCapabilities } from './file-capabilities.ts';
import type { ModelGrade } from './models.ts';

export type CapabilityKind = 'skill' | 'mcp' | 'extension' | 'pi-extension' | 'prompt';

export interface CapabilityBinding {
  id: string;
  version: string;
}

export interface DefinitionSpec {
  recommendedGrade: ModelGrade;
  capabilities?: CapabilityBinding[];
  /** Optional prompt capabilities kept separate from executable capabilities. */
  prompts?: {
    agent?: CapabilityBinding;
    tool?: CapabilityBinding;
  };
  review?: boolean;
  snapshot?: Json;
}

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
}

export interface CapabilitySearchInput {
  query?: string;
  kind?: CapabilityKind;
  role?: 'agent' | 'tool';
  limit?: number;
  offset?: number;
}

export interface CapabilitySearchResult {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  items: CapabilityRecord[];
}

export interface AgentCombinationSearchInput {
  query?: string;
  grade?: ModelGrade;
  limit?: number;
}

interface CapabilityLibraryOptions {
  capabilityRoot?: string;
  recipesPath?: string;
}

/** The filesystem-backed capability library and its Agent recipes. */
export class CapabilityLibrary {
  private readonly capabilityRoot?: string;
  private readonly recipesPath?: string;
  private capabilitiesCache: CapabilityRecord[] = [];
  private recipes: AgentCombination[] = [];
  private recipesError: string | undefined;

  constructor(options: CapabilityLibraryOptions = {}) {
    if (options.capabilityRoot) this.capabilityRoot = options.capabilityRoot;
    if (options.recipesPath) this.recipesPath = options.recipesPath;
  }

  async refreshCapabilities() {
    this.capabilitiesCache = this.capabilityRoot ? await scanCapabilities(this.capabilityRoot) : [];
    return this.capabilities();
  }

  async refresh() {
    await this.refreshCapabilities();
    if (this.recipesPath) {
      try {
        this.recipes = (await readAgentCombinations(this.recipesPath)).combinations;
        this.recipesError = undefined;
      } catch (error) {
        this.recipes = [];
        this.recipesError = error instanceof Error ? error.message : String(error);
      }
    }
    return { capabilities: this.capabilities(), agentCombinations: this.agentCombinations() };
  }

  capabilityRootPath() { return this.capabilityRoot; }
  agentCombinationFilePath() { return this.recipesPath; }
  agentCombinationError() { return this.recipesError; }

  capabilities(): CapabilityRecord[] {
    return this.capabilitiesCache.map(item => ({ ...item }));
  }

  capability(id: string, version?: string): CapabilityRecord | undefined {
    return version
      ? this.capabilitiesCache.find(item => item.id === id && item.version === version)
      : [...this.capabilitiesCache].reverse().find(item => item.id === id);
  }

  search(input: CapabilitySearchInput = {}): CapabilitySearchResult {
    const query = input.query?.trim().toLowerCase() ?? '';
    const terms = query.split(/\s+/).filter(Boolean);
    const limit = Number.isSafeInteger(input.limit) && input.limit! > 0 ? Math.min(input.limit!, 50) : 20;
    const offset = Number.isSafeInteger(input.offset) && input.offset! > 0 ? input.offset! : 0;
    const matches = this.capabilitiesCache.filter(record => {
      if (input.kind && record.kind !== input.kind) return false;
      if (input.role && record.role !== input.role) return false;
      if (!terms.length) return true;
      const haystack = [
        record.id,
        record.kind,
        record.version,
        record.name,
        record.description,
        record.source,
        record.role,
      ].filter(Boolean).join('\n').toLowerCase();
      return terms.every(term => haystack.includes(term));
    });
    return {
      total: matches.length,
      offset,
      limit,
      hasMore: offset + limit < matches.length,
      items: matches.slice(offset, offset + limit),
    };
  }

  agentCombinations(): AgentCombinationView[] {
    return this.recipes.map(recipe => validateAgentCombination(recipe, this.capabilitiesCache));
  }

  agentCombination(id: string): AgentCombinationView | undefined {
    return this.agentCombinations().find(item => item.id === id);
  }

  searchAgentCombinations(input: AgentCombinationSearchInput = {}) {
    const query = input.query?.trim().toLowerCase() ?? '';
    if (query.length > 200) throw new RuntimeError('invalid_input', 'Agent combination query must be at most 200 characters');
    const limit = Number.isSafeInteger(input.limit) && input.limit! > 0 ? Math.min(input.limit!, 50) : 30;
    const matches = this.agentCombinations().filter(item => {
      if (input.grade && item.recommendedGrade !== input.grade) return false;
      if (!query) return true;
      return [
        item.id,
        item.name,
        item.description,
        item.recommendedGrade,
        ...item.tags,
        ...item.resources.map(resource => resource.resourceId),
      ].join('\n').toLowerCase().includes(query);
    });
    return { total: matches.length, items: matches.slice(0, limit) };
  }

  async saveAgentCombination(combination: AgentCombination) {
    if (!this.recipesPath) throw new RuntimeError('unsupported', 'This runtime has no agent-combination file');
    const document = parseAgentCombinations({ version: 1, combinations: [...this.recipes.filter(item => item.id !== combination.id), combination] });
    const next = document.combinations;
    const view = validateAgentCombination(combination, this.capabilitiesCache);
    if (view.status !== 'valid') throw new RuntimeError('invalid_agent_combination', view.issues.join('; '));
    await writeAgentCombinations(this.recipesPath, { version: document.version, combinations: next });
    this.recipes = next;
    return validateAgentCombination(combination, this.capabilitiesCache);
  }

  async deleteAgentCombination(id: string) {
    if (!this.recipesPath) throw new RuntimeError('unsupported', 'This runtime has no agent-combination file');
    const next = this.recipes.filter(item => item.id !== id);
    if (next.length === this.recipes.length) throw new RuntimeError('not_found', `Unknown Agent combination ${id}`);
    await writeAgentCombinations(this.recipesPath, { version: 1, combinations: next });
    this.recipes = next;
    return { id, deleted: true };
  }

  compileAgentCombination(id: string) {
    const combination = this.recipes.find(item => item.id === id);
    if (!combination) throw new RuntimeError('not_found', `Unknown Agent combination ${id}`);
    return compileAgentCombinationDefinition(combination, this.capabilitiesCache);
  }
}
