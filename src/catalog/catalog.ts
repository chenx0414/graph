import { canonicalJson, type TaskStore } from '../core/store.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import { parseDefinitionVersion } from './models.ts';
import { CapabilityLibrary, type CapabilityBinding, type CapabilityBundleInput, type CapabilityRecord, type CapabilitySearchInput, type DefinitionSpec } from './capability-library.ts';
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

/** Result of saving a recipe. Saving always persists the document and then
 * compiles it. `definition` is present when compilation published/extended a
 * definition; `compileError` is present instead when a saved recipe could not
 * be compiled. The two are mutually exclusive. */
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

/** Versioned Agent definitions and capabilities. Published rows are immutable. */
export class Catalog {
  private readonly store: TaskStore;
  private readonly capabilityLibrary: CapabilityLibrary;
  constructor(store: TaskStore, options: { capabilityRoot?: string; recipesPath?: string; projects?: () => readonly { id: string; root: string }[] } = {}) {
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

  /** Publish a recipe compilation unless it is already the latest version.
   *
   * Reusing an older matching definition would make the compile result point at
   * a lower version than the current latest. Callers resolve the active main
   * definition by maximum version, so a deliberate recipe rollback must create
   * a new monotonic version instead of reactivating an old row that is now
   * hidden behind newer definitions. */
  ensureDefinition(id: string, spec: DefinitionSpec) {
    if (!id.trim()) throw new RuntimeError('invalid_input', 'A definition id is required');
    const latest = this.store.db.prepare('SELECT version,spec FROM definitions WHERE id=? ORDER BY version DESC LIMIT 1').get(id) as { version: number; spec: string } | undefined;
    const desired = canonicalJson(spec);
    if (latest && canonicalJson(JSON.parse(latest.spec) as Json) === desired) {
      return { id, version: latest.version, key: `${id}@${latest.version}` };
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

  /** Persist a recipe and compile it in the same step.
   *
   * Every recipe is a deployable definition, not a draft-only document, so the
   * compile is no longer limited to `main` and callers never need a second
   * request. Persisting and compiling are deliberately separate: a failed
   * compile must not discard a successful save, so the failure is reported
   * through `compileError` while `combination` stays persisted. */
  async saveAgentCombination(combination: AgentCombination): Promise<SavedAgentCombination> {
    const saved = await this.capabilityLibrary.saveAgentCombination(combination);
    try {
      const definition = this.compileAgentCombination(saved.id);
      return { combination: saved, definition };
    } catch (error) {
      return { combination: saved, compileError: error instanceof Error ? error.message : String(error) };
    }
  }

  async updateAgentCombinationDescription(id: string, description: string) {
    const combination = await this.capabilityLibrary.updateAgentCombinationDescription(id, description);
    const definition = this.compileAgentCombination(id);
    return { combination, definition };
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

  async upsertCapabilityBundle(input: CapabilityBundleInput) {
    return this.capabilityLibrary.upsertCapabilityBundle(input);
  }

  searchCapabilities(input: CapabilitySearchInput = {}) {
    return this.capabilityLibrary.search(input);
  }

  listDefinitions() {
    return this.store.db.prepare('SELECT id,MAX(version) AS version FROM definitions GROUP BY id').all() as { id: string; version: number }[];
  }

  /** Latest published definitions whose recipes still exist and compile. */
  availableAgentDefinitions() {
    const activeIds = new Set(this.agentCombinations()
      .filter(item => item.status === 'valid')
      .map(item => item.id));
    return this.listDefinitions().filter(item => activeIds.has(item.id));
  }

  capabilities() {
    return this.capabilityLibrary.capabilities();
  }

  /** The list the resource library renders: one row per skill name, duplicates folded. */
  capabilitiesView() {
    return this.capabilityLibrary.capabilitiesView();
  }
}
