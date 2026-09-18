import { canonicalJson, type TaskStore } from '../core/store.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import { parseDefinitionVersion } from './models.ts';
import { CapabilityLibrary, type CapabilityBinding, type CapabilityRecord, type CapabilitySearchInput, type DefinitionSpec } from './capability-library.ts';
import type { AgentCombination, AgentCombinationView } from './agent-combinations.ts';

export type {
  AgentCombinationSearchInput,
  CapabilityBinding,
  CapabilityKind,
  CapabilityRecord,
  CapabilitySearchInput,
  CapabilitySearchResult,
  DefinitionSpec,
} from './capability-library.ts';

/** Versioned Agent definitions and capabilities. Published rows are immutable. */
export class Catalog {
  private readonly store: TaskStore;
  private readonly capabilityLibrary: CapabilityLibrary;
  constructor(store: TaskStore, options: { capabilityRoot?: string; recipesPath?: string } = {}) {
    this.store = store;
    this.capabilityLibrary = new CapabilityLibrary(options);
  }

  async refreshCapabilities() {
    return this.capabilityLibrary.refreshCapabilities();
  }

  async refresh() {
    return this.capabilityLibrary.refresh();
  }

  capabilityRootPath() { return this.capabilityLibrary.capabilityRootPath(); }
  agentCombinationFilePath() { return this.capabilityLibrary.agentCombinationFilePath(); }
  agentCombinationError() { return this.capabilityLibrary.agentCombinationError(); }

  private assertBinding(label: string, binding: CapabilityBinding | undefined) {
    if (!binding) return;
    if (!binding.id?.trim() || !binding.version?.trim()) throw new RuntimeError('invalid_input', `${label} requires capability id and version`);
  }

  publishDefinition(id: string, spec: DefinitionSpec) {
    if (!id.trim()) throw new RuntimeError('invalid_input', 'A definition id is required');
    if (!['low', 'medium', 'high', 'highest'].includes(spec.recommendedGrade)) throw new RuntimeError('invalid_input', 'A recommended model grade is required');
    for (const binding of spec.capabilities ?? []) this.assertBinding('Capability binding', binding);
    this.assertBinding('Agent prompt binding', spec.prompts?.agent);
    this.assertBinding('Tool prompt binding', spec.prompts?.tool);
    if (spec.prompts && !spec.prompts.agent && spec.prompts.tool) {
      throw new RuntimeError('invalid_input', 'A tool prompt binding requires an agent prompt binding');
    }
    const { version } = this.store.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM definitions WHERE id=?').get(id) as { version: number };
    this.store.db.prepare('INSERT INTO definitions VALUES(?,?,?)').run(id, version, canonicalJson(spec));
    return { id, version, key: `${id}@${version}` };
  }

  /** Publish a recipe compilation only when the exact definition is not already present. */
  ensureDefinition(id: string, spec: DefinitionSpec) {
    if (!id.trim()) throw new RuntimeError('invalid_input', 'A definition id is required');
    const rows = this.store.db.prepare('SELECT version,spec FROM definitions WHERE id=? ORDER BY version').all(id) as { version: number; spec: string }[];
    const desired = canonicalJson(spec);
    for (const row of rows) {
      if (canonicalJson(JSON.parse(row.spec) as Json) === desired) return { id, version: row.version, key: `${id}@${row.version}` };
    }
    return this.publishDefinition(id, spec);
  }

  definition(key: string): DefinitionSpec & { id: string; version: number } {
    const parsed = parseDefinitionVersion(key);
    const row = this.store.db.prepare('SELECT spec FROM definitions WHERE id=? AND version=?').get(parsed.id, parsed.version) as { spec: string } | undefined;
    if (!row) throw new RuntimeError('not_found', `Unknown Agent definition ${key}`);
    return { id: parsed.id, version: parsed.version, ...JSON.parse(row.spec) as DefinitionSpec };
  }

  preset(id: string) {
    return this.store.db.prepare('SELECT id,version,hash,detail,installed_at FROM presets WHERE id=?').get(id) as { id: string; version: string; hash: string; detail: string | null; installed_at: number } | undefined;
  }

  recordPreset(id: string, version: string, hash: string, detail: Json) {
    this.store.db.prepare('INSERT OR REPLACE INTO presets VALUES(?,?,?,?,?)').run(id, version, hash, canonicalJson(detail), Date.now());
  }

  agentCombinations(): AgentCombinationView[] {
    return this.capabilityLibrary.agentCombinations();
  }

  agentCombination(id: string) {
    return this.capabilityLibrary.agentCombination(id);
  }

  searchAgentCombinations(input: { query?: string; grade?: DefinitionSpec['recommendedGrade']; limit?: number } = {}) {
    return this.capabilityLibrary.searchAgentCombinations(input);
  }

  async saveAgentCombination(combination: AgentCombination) {
    const saved = await this.capabilityLibrary.saveAgentCombination(combination);
    // Main Agent changes are a deployable recipe, not a draft-only document:
    // compile immediately so newly created master nodes use the latest version.
    if (saved.mode === 'main') this.compileAgentCombination(saved.id);
    return saved;
  }

  async deleteAgentCombination(id: string) {
    return this.capabilityLibrary.deleteAgentCombination(id);
  }

  compileAgentCombination(id: string) {
    const compiled = this.capabilityLibrary.compileAgentCombination(id);
    const published = this.ensureDefinition(id, compiled.definition);
    return {
      combination: compiled.view,
      definitionId: published.id,
      definitionVersion: published.key,
      version: published.version,
    };
  }

  capability(id: string, version?: string): CapabilityRecord | undefined {
    return this.capabilityLibrary.capability(id, version);
  }

  searchCapabilities(input: CapabilitySearchInput = {}) {
    return this.capabilityLibrary.search(input);
  }

  listDefinitions() {
    return this.store.db.prepare('SELECT id,MAX(version) AS version FROM definitions GROUP BY id').all() as { id: string; version: number }[];
  }

  capabilities() {
    return this.capabilityLibrary.capabilities();
  }
}
