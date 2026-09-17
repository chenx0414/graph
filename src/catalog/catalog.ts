import { canonicalJson, type TaskStore } from '../core/store.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import { parseDefinitionVersion, type ModelGrade } from './models.ts';

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
  status: 'installing' | 'installed' | 'failed';
}

/** Versioned Agent definitions and capabilities. Published rows are immutable. */
export class Catalog {
  private readonly store: TaskStore;
  constructor(store: TaskStore) { this.store = store; }

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

  capability(id: string, version?: string): CapabilityRecord | undefined {
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
    const rows = this.store.db.prepare('SELECT id,kind,source,version,snapshot,status FROM capabilities ORDER BY rowid').all() as { id: string; kind: CapabilityRecord['kind']; source: string; version: string; snapshot: string; status: CapabilityRecord['status'] }[];
    return rows.map(row => ({ ...row, snapshot: JSON.parse(row.snapshot) as Json }));
  }
}
