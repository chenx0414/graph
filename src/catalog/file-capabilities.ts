import { existsSync } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { normalizeDomainPattern } from '../core/domains.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import type { CapabilityKind, CapabilityOrigin, CapabilityRecord } from './capability-library.ts';

export interface CapabilityManifest {
  id: string;
  kind: CapabilityKind;
  version: string;
  name: string;
  description?: string;
  /** Prompt capabilities declare whether the file is agent.md or tool.md. */
  role?: 'agent' | 'tool';
  /** Local MCP command and arguments. */
  command?: string;
  args?: string[];
  /** Remote MCP endpoint and optional credential headers. */
  url?: string;
  headers?: Record<string, string>;
  headersEnv?: Record<string, string>;
  /** Host patterns this MCP process may reach; `${ENV}` may resolve to a base URL. */
  networkDomains?: string[];
  /** Package-manager setup policy. Manager is inferred from uvx/npx when omitted. */
  provisioning?: {
    manager?: 'uv' | 'npm';
    /** Extra hosts needed only while installing the MCP's dependencies. */
    domains?: string[];
  };
  /** Explicit opt-in for browser-style MCPs that must reach arbitrary public hosts. */
  networkAccess?: 'unrestricted';
  /** Graph extension or Pi extension entry file. */
  entry?: string;
  /**
   * Pi extension package source resolved by the Pi SDK's own package manager instead of a
   * vendored copy: `npm:<spec>`, a git URL, or a local path. When present, `entry` is ignored.
   */
  source?: string;
  tools?: { name: string; description?: string }[];
  /** Host runtime requirements for a trusted Pi extension. */
  runtime?: {
    commands?: string[];
    env?: Record<string, string>;
    readPaths?: string[];
    writePaths?: string[];
    networkDomains?: string[];
    networkAccess?: 'unrestricted';
    allowLocalBinding?: boolean;
    unixSockets?: string[];
  };
  tags?: string[];
  [key: string]: unknown;
}

const KINDS = new Set<CapabilityKind>(['skill', 'mcp', 'extension', 'pi-extension', 'prompt']);
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_SCAN_DEPTH = 4;
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.worker-home', '.worker-tmp']);

function text(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new RuntimeError('invalid_capability', `${label} must be a nonempty string`);
  return value.trim();
}

export function parseCapabilityManifest(value: unknown, path: string): CapabilityManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeError('invalid_capability', `${path} must contain a capability object`);
  }
  const raw = value as Record<string, unknown>;
  const id = text(raw.id, `${path}.id`);
  if (!ID_PATTERN.test(id)) throw new RuntimeError('invalid_capability', `${path}.id must use lowercase letters, numbers and hyphens`);
  const kind = text(raw.kind, `${path}.kind`) as CapabilityKind;
  if (!KINDS.has(kind)) throw new RuntimeError('invalid_capability', `${path}.kind is unsupported`);
  const version = text(raw.version, `${path}.version`);
  const name = text(raw.name, `${path}.name`);
  const description = raw.description === undefined ? undefined : text(raw.description, `${path}.description`);
  const role = raw.role === undefined ? undefined : text(raw.role, `${path}.role`) as 'agent' | 'tool';
  if (role && role !== 'agent' && role !== 'tool') throw new RuntimeError('invalid_capability', `${path}.role must be agent or tool`);
  if (kind === 'prompt' && !role) throw new RuntimeError('invalid_capability', `${path}.role is required for prompt capabilities`);
  const stringMap = (value: unknown, label: string) => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) {
      throw new RuntimeError('invalid_capability', `${label} must be a string map`);
    }
    return Object.fromEntries(Object.entries(value as Record<string, string>).map(([key, item]) => [key, item.trim()]));
  };
  const stringList = (value: unknown, label: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
      throw new RuntimeError('invalid_capability', `${label} must be an array of nonempty strings`);
    }
    return value.map(item => item.trim());
  };
  const networkDomains = (value: unknown, label: string): string[] | undefined => {
    const domains = stringList(value, label);
    if (!domains) return undefined;
    return domains.map((domain) => {
      const expanded = domain.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, 'placeholder.example');
      if (expanded.includes('$')) throw new RuntimeError('invalid_capability', `${label} contains an invalid environment reference`);
      try { normalizeDomainPattern(expanded); }
      catch { throw new RuntimeError('invalid_capability', `${label} must contain host patterns or environment references`); }
      return domain;
    });
  };
  const command = raw.command === undefined ? undefined : text(raw.command, `${path}.command`);
  const args = stringList(raw.args, `${path}.args`);
  const url = raw.url === undefined ? undefined : text(raw.url, `${path}.url`);
  let provisioning: CapabilityManifest['provisioning'];
  if (raw.provisioning !== undefined) {
    if (!raw.provisioning || typeof raw.provisioning !== 'object' || Array.isArray(raw.provisioning)) {
      throw new RuntimeError('invalid_capability', `${path}.provisioning must be an object`);
    }
    const value = raw.provisioning as Record<string, unknown>;
    const manager = value.manager === undefined ? undefined : text(value.manager, `${path}.provisioning.manager`);
    if (manager && manager !== 'uv' && manager !== 'npm') {
      throw new RuntimeError('invalid_capability', `${path}.provisioning.manager must be uv or npm`);
    }
    const expected = command === 'uvx' ? 'uv' : command === 'npx' ? 'npm' : undefined;
    if (!expected) {
      throw new RuntimeError('invalid_capability', `${path}.provisioning is only valid for local uvx or npx MCP commands`);
    }
    if (manager && manager !== expected) {
      throw new RuntimeError('invalid_capability', `${path}.provisioning.manager does not match command ${command}`);
    }
    const provisioningDomains = networkDomains(value.domains, `${path}.provisioning.domains`);
    provisioning = {
      manager: (manager ?? expected) as 'uv' | 'npm',
      ...(provisioningDomains ? { domains: provisioningDomains } : {}),
    };
  }
  const headers = stringMap(raw.headers, `${path}.headers`);
  const headersEnv = stringMap(raw.headersEnv, `${path}.headersEnv`);
  const domains = networkDomains(raw.networkDomains, `${path}.networkDomains`);
  const networkAccess = raw.networkAccess === undefined ? undefined : text(raw.networkAccess, `${path}.networkAccess`);
  if (networkAccess && networkAccess !== 'unrestricted') throw new RuntimeError('invalid_capability', `${path}.networkAccess must be "unrestricted"`);
  if (domains && kind !== 'mcp') throw new RuntimeError('invalid_capability', `${path}.networkDomains is only valid for MCP capabilities`);
  if (networkAccess && kind !== 'mcp') throw new RuntimeError('invalid_capability', `${path}.networkAccess is only valid for MCP capabilities`);
  if (domains && networkAccess) throw new RuntimeError('invalid_capability', `${path} cannot combine networkDomains with unrestricted network access`);
  const entry = raw.entry === undefined ? undefined : text(raw.entry, `${path}.entry`);
  const tags = stringList(raw.tags, `${path}.tags`);
  let tools: CapabilityManifest['tools'];
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) throw new RuntimeError('invalid_capability', `${path}.tools must be an array`);
    tools = raw.tools.map((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeError('invalid_capability', `${path}.tools[${index}] must be an object`);
      const tool = value as Record<string, unknown>;
      return {
        name: text(tool.name, `${path}.tools[${index}].name`),
        ...(tool.description === undefined ? {} : { description: text(tool.description, `${path}.tools[${index}].description`) }),
      };
    });
  }
  let runtime: CapabilityManifest['runtime'];
  if (raw.runtime !== undefined) {
    if (!raw.runtime || typeof raw.runtime !== 'object' || Array.isArray(raw.runtime)) {
      throw new RuntimeError('invalid_capability', `${path}.runtime must be an object`);
    }
    if (kind !== 'pi-extension') throw new RuntimeError('invalid_capability', `${path}.runtime is only valid for Pi extensions`);
    const value = raw.runtime as Record<string, unknown>;
    const commands = stringList(value.commands, `${path}.runtime.commands`);
    if (commands?.some(command => /[\0\r\n;|&`$<>]/.test(command))) {
      throw new RuntimeError('invalid_capability', `${path}.runtime.commands contains an invalid command`);
    }
    const runtimeEnv = stringMap(value.env, `${path}.runtime.env`);
    if (runtimeEnv && Object.keys(runtimeEnv).some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      throw new RuntimeError('invalid_capability', `${path}.runtime.env contains an invalid variable name`);
    }
    const readPaths = stringList(value.readPaths, `${path}.runtime.readPaths`);
    const writePaths = stringList(value.writePaths, `${path}.runtime.writePaths`);
    const runtimeDomains = networkDomains(value.networkDomains, `${path}.runtime.networkDomains`);
    const networkAccess = value.networkAccess === undefined ? undefined : text(value.networkAccess, `${path}.runtime.networkAccess`);
    if (networkAccess && networkAccess !== 'unrestricted') {
      throw new RuntimeError('invalid_capability', `${path}.runtime.networkAccess must be "unrestricted"`);
    }
    if (runtimeDomains && networkAccess) {
      throw new RuntimeError('invalid_capability', `${path} cannot combine runtime networkDomains with unrestricted network access`);
    }
    if (value.allowLocalBinding !== undefined && typeof value.allowLocalBinding !== 'boolean') {
      throw new RuntimeError('invalid_capability', `${path}.runtime.allowLocalBinding must be boolean`);
    }
    const unixSockets = stringList(value.unixSockets, `${path}.runtime.unixSockets`);
    runtime = {
      ...(commands ? { commands } : {}),
      ...(runtimeEnv ? { env: runtimeEnv } : {}),
      ...(readPaths ? { readPaths } : {}),
      ...(writePaths ? { writePaths } : {}),
      ...(runtimeDomains ? { networkDomains: runtimeDomains } : {}),
      ...(networkAccess ? { networkAccess: networkAccess as 'unrestricted' } : {}),
      ...(value.allowLocalBinding !== undefined ? { allowLocalBinding: value.allowLocalBinding as boolean } : {}),
      ...(unixSockets ? { unixSockets } : {}),
    };
  }
  return {
    ...raw,
    id,
    kind,
    version,
    name,
    ...(description ? { description } : {}),
    ...(role ? { role } : {}),
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(url ? { url } : {}),
    ...(provisioning ? { provisioning } : {}),
    ...(headers ? { headers } : {}),
    ...(headersEnv ? { headersEnv } : {}),
    ...(domains ? { networkDomains: domains } : {}),
    ...(networkAccess ? { networkAccess: networkAccess as 'unrestricted' } : {}),
    ...(entry ? { entry } : {}),
    ...(tools ? { tools } : {}),
    ...(runtime ? { runtime } : {}),
    ...(tags ? { tags } : {}),
  };
}

export async function readCapabilityManifest(directory: string): Promise<CapabilityManifest> {
  const path = join(directory, 'capability.json');
  let body: Json;
  try {
    body = JSON.parse(await readFile(path, 'utf8')) as Json;
  } catch (error) {
    throw new RuntimeError('invalid_capability', `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseCapabilityManifest(body, path);
}

async function validateFiles(directory: string, manifest: CapabilityManifest) {
  if (manifest.kind === 'skill') {
    const skill = join(directory, 'SKILL.md');
    if (!existsSync(skill)) throw new RuntimeError('invalid_capability', `${directory} is a skill without SKILL.md`);
    if (!(await readFile(skill, 'utf8')).trim()) throw new RuntimeError('invalid_capability', `${skill} is empty`);
  }
  if (manifest.kind === 'prompt') {
    const prompt = join(directory, manifest.role === 'tool' ? 'tool.md' : 'agent.md');
    if (!existsSync(prompt)) throw new RuntimeError('invalid_capability', `${directory} is a ${manifest.role} prompt without ${manifest.role === 'tool' ? 'tool.md' : 'agent.md'}`);
    if (!(await readFile(prompt, 'utf8')).trim()) throw new RuntimeError('invalid_capability', `${prompt} is empty`);
  }
  if (manifest.kind === 'mcp' && !manifest.command && !manifest.url) {
    throw new RuntimeError('invalid_capability', `${directory} is an MCP capability without command or url`);
  }
  if (manifest.kind === 'extension' || manifest.kind === 'pi-extension') {
    // A Pi extension may declare a package source instead of a vendored entry: the SDK resolves
    // and validates that source at load time, so there is no local entry to check here.
    const sourced = manifest.kind === 'pi-extension' && typeof manifest.source === 'string' && manifest.source.trim().length > 0;
    if (!sourced) {
      const entry = manifest.entry ?? './index.mjs';
      const path = isAbsolute(entry) ? entry : resolve(directory, entry);
      if (path !== directory && !path.startsWith(`${directory}/`)) {
        throw new RuntimeError('invalid_capability', `${directory} extension entry must stay inside its capability directory`);
      }
      if (!existsSync(path)) throw new RuntimeError('invalid_capability', `${directory} extension entry ${entry} does not exist`);
    }
  }
}

/** The frontmatter a native skill loader needs: name, description and the invocation flag. */
async function skillFrontmatter(directory: string) {
  const file = join(directory, 'SKILL.md');
  if (!existsSync(file)) return undefined;
  const text = await readFile(file, 'utf8');
  const block = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return { name: undefined, description: undefined, disableModelInvocation: false, hasFrontmatter: false };
  const values: Record<string, string> = {};
  for (const line of block[1]!.split(/\r?\n/)) {
    const parsed = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (parsed) values[parsed[1]!] = parsed[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return {
    name: values.name || undefined,
    description: values.description || undefined,
    disableModelInvocation: (values['disable-model-invocation'] ?? '').toLowerCase() === 'true',
    hasFrontmatter: true,
  };
}

const SKILL_FRONTMATTER_ERROR = 'SKILL.md 缺少 frontmatter（name/description）：原生加载器会跳过它';

/** What the library should say about a skill file, given the native loader's rules. */
async function skillNote(directory: string): Promise<string | undefined> {
  const front = await skillFrontmatter(directory);
  if (!front) return undefined;
  if (!front.hasFrontmatter) return SKILL_FRONTMATTER_ERROR;
  if (front.disableModelInvocation) {
    return '声明了 disable-model-invocation：不会进入系统提示（原生语义为仅显式调用）';
  }
  return undefined;
}

/**
 * Skills the user placed directly in one native skills folder: the SDK's global agent
 * folder, a project's `.pi/skills`, or an Agent's own folder.
 *
 * Symlinked entries are the mirror of the skills a recipe already binds, and the library
 * lists those from the capability root, so only hand-made folders are recorded here.
 */
export async function scanNativeSkills(skillsDir: string, owner: string, origin: CapabilityOrigin): Promise<CapabilityRecord[]> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: CapabilityRecord[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const directory = join(skillsDir, entry.name);
    if (!existsSync(join(directory, 'SKILL.md'))) continue;
    const front = await skillFrontmatter(directory);
    const note = await skillNote(directory);
    const usable = Boolean(front?.hasFrontmatter);
    records.push({
      id: entry.name,
      kind: 'skill',
      source: directory,
      version: 'local',
      snapshot: { path: directory },
      status: usable ? 'available' : 'invalid',
      ...(front?.name ? { name: front.name } : {}),
      ...(front?.description ? { description: front.description } : {}),
      owner,
      origin,
      ...(note ? { note } : {}),
      ...(usable ? {} : { error: SKILL_FRONTMATTER_ERROR }),
    });
  }
  return records;
}

/** Skills the user placed in any Agent's own folder. */
export async function scanAgentSkills(agentsRoot: string): Promise<CapabilityRecord[]> {
  let agents;
  try {
    agents = await readdir(agentsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: CapabilityRecord[] = [];
  for (const agent of agents.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).sort((left, right) => left.name.localeCompare(right.name))) {
    records.push(...await scanNativeSkills(join(agentsRoot, agent.name, 'skills'), agent.name, 'agent'));
  }
  return records;
}

async function walkCapabilityDirectories(root: string, directory: string, depth: number, records: CapabilityRecord[]) {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (depth === 0 && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entries.some(entry => entry.isFile() && entry.name === 'capability.json')) {
    try {
      const manifest = await readCapabilityManifest(directory);
      await validateFiles(directory, manifest);
      const note = manifest.kind === 'skill' ? await skillNote(directory) : undefined;
      records.push({
        id: manifest.id,
        kind: manifest.kind,
        source: directory,
        version: manifest.version,
        snapshot: { path: directory, manifest: manifest as unknown as Json },
        status: 'available',
        name: manifest.name,
        ...(manifest.description ? { description: manifest.description } : {}),
        ...(manifest.role ? { role: manifest.role } : {}),
        ...(note ? { note } : {}),
        ...(manifest.kind === 'pi-extension' && manifest.source ? { packageSource: manifest.source } : {}),
      });
    } catch (error) {
      records.push({
        id: directory.slice(root.length + 1).replaceAll('/', '-') || directory,
        kind: 'skill',
        source: directory,
        version: 'invalid',
        snapshot: { path: directory, error: error instanceof Error ? error.message : String(error) },
        status: 'invalid',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
    await walkCapabilityDirectories(root, join(directory, entry.name), depth + 1, records);
  }
}

export async function scanCapabilities(root: string): Promise<CapabilityRecord[]> {
  try { root = await realpath(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: CapabilityRecord[] = [];
  await walkCapabilityDirectories(root, root, 0, records);
  const seen = new Map<string, CapabilityRecord>();
  for (const record of records) {
    if (record.status === 'invalid') continue;
    const key = `${record.id}@${record.version}`;
    const previous = seen.get(key);
    if (previous) {
      record.status = 'invalid';
      record.error = `Duplicate capability ${key}; also found at ${previous.source}`;
      record.snapshot = { path: record.source, error: record.error };
      continue;
    }
    seen.set(key, record);
  }
  return records;
}
