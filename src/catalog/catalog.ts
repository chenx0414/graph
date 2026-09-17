import { canonicalJson, type TaskStore } from '../core/store.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import { parseDefinitionVersion, type ModelGrade } from './models.ts';
import { scanCapabilities } from './file-capabilities.ts';
import {
  compileAgentCombinationDefinition,
  parseAgentCombinations,
  readAgentCombinations,
  validateAgentCombination,
  writeAgentCombinations,
  type AgentCombination,
  type AgentCombinationView,
} from './agent-combinations.ts';

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
  status: 'available' | 'invalid' | 'installing' | 'installed' | 'failed';
  name?: string;
  description?: string;
  role?: 'agent' | 'tool';
  error?: string;
}

/** Versioned Agent definitions and capabilities. Published rows are immutable. */
export class Catalog {
  private readonly store: TaskStore;
  private readonly capabilityRoot?: string;
  private readonly recipesPath?: string;
  private fileCapabilities: CapabilityRecord[] = [];
  private recipes: AgentCombination[] = [];
  private recipesError: string | undefined;
  constructor(store: TaskStore, options: { capabilityRoot?: string; recipesPath?: string } = {}) {
    this.store = store;
    if (options.capabilityRoot) this.capabilityRoot = options.capabilityRoot;
    if (options.recipesPath) this.recipesPath = options.recipesPath;
  }

  async refreshCapabilities() {
    this.fileCapabilities = this.capabilityRoot ? await scanCapabilities(this.capabilityRoot) : [];
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

  recordInstall(record: CapabilityRecord) {
    this.store.db.prepare('INSERT OR IGNORE INTO capabilities(id,kind,source,version,snapshot,status) VALUES(?,?,?,?,?,?)')
      .run(record.id, record.kind, record.source, record.version, canonicalJson(record.snapshot), record.status);
  }

  agentCombinations(): AgentCombinationView[] {
    return this.recipes.map(recipe => validateAgentCombination(recipe, this.capabilities()));
  }

  async saveAgentCombination(combination: AgentCombination) {
    if (!this.recipesPath) throw new RuntimeError('unsupported', 'This runtime has no agent-combination file');
    const document = parseAgentCombinations({ version: 1, combinations: [...this.recipes.filter(item => item.id !== combination.id), combination] });
    const next = document.combinations;
    const view = validateAgentCombination(combination, this.capabilities());
    if (view.status !== 'valid') throw new RuntimeError('invalid_agent_combination', view.issues.join('; '));
    await writeAgentCombinations(this.recipesPath, { version: document.version, combinations: next });
    this.recipes = next;
    return validateAgentCombination(combination, this.capabilities());
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
    const compiled = compileAgentCombinationDefinition(combination, this.capabilities());
    const published = this.ensureDefinition(id, compiled.definition);
    return {
      combination: compiled.view,
      definitionId: published.id,
      definitionVersion: published.key,
      version: published.version,
    };
  }

  capability(id: string, version?: string): CapabilityRecord | undefined {
    if (this.capabilityRoot) {
      return (version
        ? this.fileCapabilities.find(item => item.id === id && item.version === version)
        : [...this.fileCapabilities].reverse().find(item => item.id === id));
    }
    const row = (version
      ? this.store.db.prepare('SELECT * FROM capabilities WHERE id=? AND version=? ORDER BY rowid DESC LIMIT 1').get(id, version)
      : this.store.db.prepare('SELECT * FROM capabilities WHERE id=? ORDER BY rowid DESC LIMIT 1').get(id)) as { id: string; kind: CapabilityRecord['kind']; source: string; version: string; snapshot: string; status: CapabilityRecord['status'] } | undefined;
    if (!row) return;
    return { ...row, snapshot: JSON.parse(row.snapshot) as Json };
  }

  listDefinitions() {
    return this.store.db.prepare('SELECT id,MAX(version) AS version FROM definitions GROUP BY id').all() as { id: string; version: number }[];
  }

  capabilities() {
    if (this.capabilityRoot) return this.fileCapabilities.map(item => ({ ...item }));
    const rows = this.store.db.prepare('SELECT id,kind,source,version,snapshot,status FROM capabilities ORDER BY rowid').all() as { id: string; kind: CapabilityRecord['kind']; source: string; version: string; snapshot: string; status: CapabilityRecord['status'] }[];
    return rows.map(row => ({ ...row, snapshot: JSON.parse(row.snapshot) as Json }));
  }
}
