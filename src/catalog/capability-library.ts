import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
import { homedir } from 'node:os';
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent';
import { parseCapabilityManifest, scanAgentSkills, scanCapabilities, scanNativeSkills, type CapabilityManifest } from './file-capabilities.ts';
import type { ModelGrade } from './models.ts';

export type CapabilityKind = 'skill' | 'mcp' | 'extension' | 'pi-extension' | 'prompt';

/**
 * Where a skill entry came from. The order matters: it decides which of several entries
 * that share a name the library shows.
 *
 * A library entry comes first because it is the only one that can be bound, and binding
 * mirrors it into the Agent's own folder, which is where the native loader looks first - so
 * the bound copy is the one that actually reaches the model. A hand-placed entry in the
 * Agent's folder comes next (it wins while nothing is bound), then the global folders and
 * finally the project's own folders.
 */
export type CapabilityOrigin = 'library' | 'agent' | 'global' | 'project';

const ORIGIN_ORDER: Record<CapabilityOrigin, number> = { library: 0, agent: 1, global: 2, project: 3 };

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
  /** The Agent recipe this entry belongs to, for skills placed in its own folder. */
  owner?: string;
  /** A fact worth showing next to the entry, such as an excluded skill. */
  note?: string;
  /** Where the entry came from; a record without one is a capability-library entry. */
  origin?: CapabilityOrigin;
  /** Same-name entries the library view folds into this one. */
  duplicates?: { id: string; version: string; source: string }[];
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

export interface CapabilityBundleInput {
  manifest: Json;
  files?: Record<string, string>;
  overwrite?: boolean;
}

const BUNDLE_DIRECTORIES: Record<CapabilityKind, string> = {
  skill: 'skills',
  mcp: 'mcp',
  extension: 'graph-extensions',
  'pi-extension': 'pi-extensions',
  prompt: 'agent-md',
};

function safeBundlePath(path: string) {
  if (!path || isAbsolute(path) || path.includes('\0')) throw new RuntimeError('invalid_capability', 'Capability bundle file paths must be relative');
  const normalizedPath = path.replaceAll('\\', '/').replace(/^\.\/+/, '');
  const parts = normalizedPath.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new RuntimeError('invalid_capability', 'Capability bundle file paths cannot traverse directories');
  const normalized = relative('.', resolve('.', normalizedPath));
  if (normalized.startsWith('..') || isAbsolute(normalized)) throw new RuntimeError('invalid_capability', 'Capability bundle file path escapes its directory');
  return normalized;
}

function validateBundleFiles(manifest: CapabilityManifest, files: Record<string, string>) {
  const entries = Object.entries(files);
  if (entries.length > 64) throw new RuntimeError('invalid_capability', 'A capability bundle may contain at most 64 files');
  let bytes = 0;
  for (const [path, content] of entries) {
    const normalized = safeBundlePath(path);
    if (normalized === 'capability.json') throw new RuntimeError('invalid_capability', 'capability.json is generated from the manifest');
    if (typeof content !== 'string') throw new RuntimeError('invalid_capability', `Capability bundle file ${path} must contain text`);
    bytes += Buffer.byteLength(content, 'utf8');
    if (bytes > 2_000_000) throw new RuntimeError('invalid_capability', 'A capability bundle may contain at most 2 MB of text');
  }
  if (manifest.headers && Object.values(manifest.headers).some(value => !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value))) {
    throw new RuntimeError('invalid_capability', 'Literal credential headers are not allowed; use headersEnv instead');
  }
  if (manifest.kind === 'skill' && !files['SKILL.md']?.trim()) throw new RuntimeError('invalid_capability', 'A skill bundle requires SKILL.md');
  if (manifest.kind === 'prompt' && !files[manifest.role === 'tool' ? 'tool.md' : 'agent.md']?.trim()) {
    throw new RuntimeError('invalid_capability', `A ${manifest.role} prompt bundle requires ${manifest.role === 'tool' ? 'tool.md' : 'agent.md'}`);
  }
  const entry = (manifest.entry ?? './index.mjs').replace(/^\.\/+/, '');
  if ((manifest.kind === 'extension' || manifest.kind === 'pi-extension') && !files[entry]?.trim()) {
    throw new RuntimeError('invalid_capability', `An extension bundle requires ${entry}`);
  }
}

export interface AgentCombinationSearchInput {
  query?: string;
  grade?: ModelGrade;
  limit?: number;
}

interface CapabilityLibraryOptions {
  capabilityRoot?: string;
  recipesPath?: string;
  /** The configured projects, read at refresh time, so their own skill folders are listed. */
  projects?: () => readonly { id: string; root: string }[];
}

/** What the library view calls one entry's source. */
export function capabilitySourceLabel(record: CapabilityRecord): string {
  if (record.owner) return record.owner;
  return record.origin === undefined || record.origin === 'library' ? '能力库' : record.origin;
}

/**
 * One row per skill name: several entries that share a name resolve to a single skill for the
 * native loader, so the library shows the one that decides the outcome and lists the rest.
 *
 * `ORIGIN_ORDER` picks the entry; within one origin the shortest id wins, then the alphabet,
 * so the result never depends on scan order.
 */
export function groupCapabilitiesByName(records: readonly CapabilityRecord[]): CapabilityRecord[] {
  const groups = new Map<string, CapabilityRecord[]>();
  const grouped: CapabilityRecord[] = [];
  for (const record of records) {
    if (record.kind !== 'skill') {
      grouped.push(record);
      continue;
    }
    const key = record.name ?? record.id;
    const bucket = groups.get(key);
    if (bucket) bucket.push(record);
    else groups.set(key, [record]);
  }
  const rank = (record: CapabilityRecord) => ORIGIN_ORDER[record.origin ?? 'library'];
  for (const bucket of groups.values()) {
    const [winner, ...rest] = [...bucket].sort((left, right) =>
      rank(left) - rank(right)
      || left.id.length - right.id.length
      || left.id.localeCompare(right.id));
    if (!rest.length) {
      grouped.push(winner!);
      continue;
    }
    grouped.push({
      ...winner!,
      duplicates: rest.map(record => ({
        id: record.id,
        version: record.version,
        source: capabilitySourceLabel(record),
      })),
    });
  }
  return grouped;
}

/** The filesystem-backed capability library and its Agent recipes. */
export class CapabilityLibrary {
  private readonly capabilityRoot?: string;
  private readonly recipesPath?: string;
  private readonly projects?: () => readonly { id: string; root: string }[];
  private capabilitiesCache: CapabilityRecord[] = [];
  private recipes: AgentCombination[] = [];
  private recipesError: string | undefined;

  constructor(options: CapabilityLibraryOptions = {}) {
    if (options.capabilityRoot) this.capabilityRoot = options.capabilityRoot;
    if (options.projects) this.projects = options.projects;
    if (options.recipesPath) this.recipesPath = options.recipesPath;
  }

  async refreshCapabilities() {
    if (!this.capabilityRoot) {
      this.capabilitiesCache = [];
      return this.capabilities();
    }
    // Skills the user placed belong to the same library view: an Agent's own folder, the
    // global folders - the Pi agent directory and `.agents` - which every Agent loads, and
    // each configured project's own `.pi`/`.agents` folders, which reach the Agents that
    // work in it.
    const placed = await scanAgentSkills(join(dirname(this.capabilityRoot), 'agents'));
    const global = await scanNativeSkills(join(getAgentDir(), 'skills'), '全局（Pi agent 目录）', 'global');
    const agents = await scanNativeSkills(join(homedir(), '.agents', 'skills'), '全局（~/.agents）', 'global');
    const projects: CapabilityRecord[] = [];
    for (const project of this.projects?.() ?? []) {
      projects.push(...await scanNativeSkills(join(project.root, CONFIG_DIR_NAME, 'skills'), `项目 ${project.id}（.pi）`, 'project'));
      projects.push(...await scanNativeSkills(join(project.root, '.agents', 'skills'), `项目 ${project.id}（.agents）`, 'project'));
    }
    this.capabilitiesCache = [
      ...await scanCapabilities(this.capabilityRoot), ...placed, ...global, ...agents, ...projects,
    ];
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

  /** The list the resource library renders: one row per skill name, duplicates folded. */
  capabilitiesView(): CapabilityRecord[] {
    return groupCapabilitiesByName(this.capabilitiesCache);
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
    if (combination.mode === 'main' && combination.id !== 'main') {
      throw new RuntimeError('invalid_agent_combination', 'The Main Agent recipe must use id "main"');
    }
    const document = parseAgentCombinations({ version: 1, combinations: [...this.recipes.filter(item => item.id !== combination.id), combination] });
    const next = document.combinations;
    const view = validateAgentCombination(combination, this.capabilitiesCache);
    if (view.status !== 'valid') throw new RuntimeError('invalid_agent_combination', view.issues.join('; '));
    await writeAgentCombinations(this.recipesPath, { version: document.version, combinations: next });
    this.recipes = next;
    return validateAgentCombination(combination, this.capabilitiesCache);
  }

  async updateAgentCombinationDescription(id: string, description: string) {
    if (!this.recipesPath) throw new RuntimeError('unsupported', 'This runtime has no agent-combination file');
    const current = this.recipes.find(item => item.id === id);
    if (!current) throw new RuntimeError('not_found', `Unknown Agent combination ${id}`);
    const normalized = description.trim();
    if (!normalized) throw new RuntimeError('invalid_agent_combination', 'Agent combination description must be a nonempty string');
    if (normalized.length > 2_000) throw new RuntimeError('invalid_agent_combination', 'Agent combination description must be at most 2000 characters');
    return this.saveAgentCombination({ ...current, description: normalized });
  }

  async deleteAgentCombination(id: string) {
    if (!this.recipesPath) throw new RuntimeError('unsupported', 'This runtime has no agent-combination file');
    if (this.recipes.find(item => item.id === id)?.mode === 'main') {
      throw new RuntimeError('invalid_agent_combination', 'The Main Agent recipe cannot be deleted');
    }
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

  async upsertCapabilityBundle(input: CapabilityBundleInput) {
    if (!this.capabilityRoot) throw new RuntimeError('unsupported', 'This runtime has no writable capability directory');
    const manifest = parseCapabilityManifest(input.manifest, '<bundle>');
    const files = input.files ?? {};
    validateBundleFiles(manifest, files);

    const directory = join(this.capabilityRoot, BUNDLE_DIRECTORIES[manifest.kind], `${manifest.id}-${manifest.version}`);
    const duplicate = this.capabilitiesCache.find(record =>
      record.id === manifest.id && record.version === manifest.version && resolve(record.source) !== resolve(directory));
    if (duplicate) {
      throw new RuntimeError('capability_exists', `Capability ${manifest.id}@${manifest.version} is already registered from ${duplicate.source}`);
    }
    if (existsSync(directory) && !input.overwrite) {
      throw new RuntimeError('capability_exists', `Capability ${manifest.id}@${manifest.version} is already installed; set overwrite=true only after explicit approval`);
    }
    const staging = `${directory}.tmp-${randomUUID()}`;
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(staging, 'capability.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      for (const [path, content] of Object.entries(files)) {
        const target = join(staging, safeBundlePath(path));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { mode: 0o600 });
      }
      const staged = await scanCapabilities(staging);
      const valid = staged.find(record => record.id === manifest.id && record.version === manifest.version && record.status === 'available');
      if (!valid) {
        const invalid = staged.find(record => record.status === 'invalid');
        throw new RuntimeError('invalid_capability', invalid?.error ?? `Capability ${manifest.id}@${manifest.version} did not pass catalog validation`);
      }
      if (existsSync(directory)) await rm(directory, { recursive: true, force: true });
      await rename(staging, directory);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }

    await this.refreshCapabilities();
    const record = this.capability(manifest.id, manifest.version);
    if (!record || record.status !== 'available') {
      throw new RuntimeError('invalid_capability', record?.error ?? `Capability ${manifest.id}@${manifest.version} did not pass catalog validation`);
    }
    return { capability: record, directory };
  }
}
