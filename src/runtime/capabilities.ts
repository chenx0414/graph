import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CapabilityBinding, CapabilityRecord, Catalog } from '../catalog/catalog.ts';
import { normalizeDomainPattern } from '../core/domains.ts';
import { isLocalMcpCommand, LOCAL_MCP_COMMANDS } from '../core/mcp-commands.ts';
import { canonicalJson } from '../core/store.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import type { ResolvedAccessPolicy } from '../core/access-policy.ts';
import { callMcpTool, httpExchange, listMcpTools, resolveMcpArg, stdioExchange, type McpExchange, type McpTool } from './mcp-client.ts';
import { allowedDomain, normalizeDomains } from './domains.ts';
import { externallyGated } from './pi-instance.ts';
import { acquireRestrictedExecutor, type RestrictedGate } from './restricted-process.ts';
import { graphNodeRuntime } from './workspace-command.ts';
import type { SendGate } from './controlled-openai.ts';

export interface CapabilityLoadFact {
  id: string;
  version: string;
  kind: string | null;
  loaded: boolean;
  executable: boolean;
  reason: string | null;
  name?: string;
  description?: string;
  path?: string;
  tools?: string[];
  networkDomains?: string[];
  networkAccess?: 'unrestricted';
  provisioning?: {
    manager: 'uv' | 'npm';
    domains: string[];
    path: string;
  };
  runtime?: Json;
}

export interface LoadedCapabilities {
  skillPaths: string[];
  piExtensionPaths: string[];
  piExtensionTools: string[];
  readRoots: string[];
  writeRoots: string[];
  env: Record<string, string>;
  networkDomains: string[];
  allowUnrestrictedNetwork: boolean;
  allowLocalBinding: boolean;
  unixSockets: string[];
  tools: ToolDefinition[];
  prompts: { agent: string | null; tool: string | null };
  digest: string;
  close(): Promise<void>;
  report: CapabilityLoadFact[];
}

export interface ResolvedCapabilityFact {
  id: string;
  version: string;
  kind: string;
  role?: 'agent' | 'tool';
  source: string;
  path: string;
  digest: string;
  declaredTools?: { name: string; description: string }[];
  entry?: string;
  command?: string;
  url?: string;
  networkDomains?: string[];
  networkAccess?: 'unrestricted';
  provisioning?: {
    manager: 'uv' | 'npm';
    domains: string[];
  };
}

interface McpManifest {
  command?: unknown;
  args?: unknown;
  entry?: unknown;
  url?: unknown;
  provisioning?: unknown;
  headers?: unknown;
  headersEnv?: unknown;
  env?: unknown;
  tools?: unknown;
  networkDomains?: unknown;
  networkAccess?: unknown;
  runtime?: unknown;
}

const UV_PROVISIONING_DOMAINS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org',
] as const;

const NPM_PROVISIONING_DOMAINS = [
  'registry.npmjs.org',
] as const;

interface McpProvisioningPlan {
  manager: 'uv' | 'npm';
  domains: string[];
  root: string;
  readyFile: string;
  key: string;
}

/** A remote MCP operation the task has not pre-authorized; the user answers with this exact grant. */
export interface CapabilityPermissionRequest {
  grant: string;
  capabilityId: string;
  tool: string;
  description: string;
}

export function mcpGrant(capabilityId: string, tool: string) {
  return `mcp:${capabilityId}:${tool}`;
}

const extensionWorker = fileURLToPath(new URL('./extension-worker.mjs', import.meta.url));

function snapshotPath(record: { snapshot: Json }) {
  const snapshot = record.snapshot;
  const path = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? (snapshot as { path?: unknown }).path : undefined;
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new RuntimeError('capability_unavailable', 'Installed capability has no absolute snapshot path');
  }
  return path;
}

function mcpToolName(capabilityId: string, tool: string) {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_]/g, '_');
  return `mcp_${clean(capabilityId)}_${clean(tool)}`;
}

function safeToolName(name: string) {
  const clean = name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z]+/, '');
  if (!clean) throw new RuntimeError('invalid_input', `Invalid tool name ${name}`);
  return clean;
}

function declaredTools(manifest: McpManifest) {
  if (manifest.tools === undefined) return [];
  if (!Array.isArray(manifest.tools)) throw new RuntimeError('capability_unavailable', 'Pi extension manifest tools must be an array');
  return manifest.tools.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeError('capability_unavailable', 'Pi extension tool declarations must be objects');
    const tool = value as { name?: unknown; description?: unknown };
    if (typeof tool.name !== 'string' || !tool.name.trim()) throw new RuntimeError('capability_unavailable', 'Pi extension tool declaration requires a name');
    if (tool.description !== undefined && typeof tool.description !== 'string') throw new RuntimeError('capability_unavailable', `Pi extension tool ${tool.name} has an invalid description`);
    return {
      name: safeToolName(tool.name),
      description: typeof tool.description === 'string' ? tool.description : `Pi extension tool ${tool.name}`,
    };
  });
}

interface PiExtensionRuntime {
  commands?: string[];
  env?: Record<string, string>;
  readPaths?: string[];
  writePaths?: string[];
  networkDomains?: string[];
  networkAccess?: 'unrestricted';
  allowLocalBinding?: boolean;
  unixSockets?: string[];
}

interface ResolvedPiExtensionRuntime {
  env: Record<string, string>;
  readPaths: string[];
  writePaths: string[];
  networkDomains: string[];
  allowUnrestrictedNetwork: boolean;
  allowLocalBinding: boolean;
  unixSockets: string[];
}

function runtimeDeclaration(value: unknown): PiExtensionRuntime | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeError('capability_unavailable', 'Pi extension runtime must be an object');
  }
  const raw = value as Record<string, unknown>;
  const strings = (value: unknown, label: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
      throw new RuntimeError('capability_unavailable', `${label} must be an array of nonempty strings`);
    }
    return value.map(item => (item as string).trim());
  };
  const env = raw.env === undefined ? undefined : raw.env;
  if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) ||
      Object.entries(env as Record<string, unknown>).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string'))) {
    throw new RuntimeError('capability_unavailable', 'Pi extension runtime.env must be a string map with valid variable names');
  }
  const networkAccess = raw.networkAccess === undefined
    ? undefined
    : raw.networkAccess === 'unrestricted'
      ? 'unrestricted' as const
      : (() => { throw new RuntimeError('capability_unavailable', 'Pi extension runtime.networkAccess must be "unrestricted"'); })();
  const networkDomains = strings(raw.networkDomains, 'Pi extension runtime.networkDomains');
  if (networkDomains && networkAccess) {
    throw new RuntimeError('capability_unavailable', 'Pi extension runtime cannot combine networkDomains with unrestricted network access');
  }
  if (raw.allowLocalBinding !== undefined && typeof raw.allowLocalBinding !== 'boolean') {
    throw new RuntimeError('capability_unavailable', 'Pi extension runtime.allowLocalBinding must be boolean');
  }
  return {
    ...(strings(raw.commands, 'Pi extension runtime.commands') ? { commands: strings(raw.commands, 'Pi extension runtime.commands')! } : {}),
    ...(env ? { env: Object.fromEntries(Object.entries(env as Record<string, string>).map(([name, value]) => [name, value.trim()])) } : {}),
    ...(strings(raw.readPaths, 'Pi extension runtime.readPaths') ? { readPaths: strings(raw.readPaths, 'Pi extension runtime.readPaths')! } : {}),
    ...(strings(raw.writePaths, 'Pi extension runtime.writePaths') ? { writePaths: strings(raw.writePaths, 'Pi extension runtime.writePaths')! } : {}),
    ...(networkDomains ? { networkDomains } : {}),
    ...(networkAccess ? { networkAccess } : {}),
    ...(raw.allowLocalBinding !== undefined ? { allowLocalBinding: raw.allowLocalBinding as boolean } : {}),
    ...(strings(raw.unixSockets, 'Pi extension runtime.unixSockets') ? { unixSockets: strings(raw.unixSockets, 'Pi extension runtime.unixSockets')! } : {}),
  };
}

function runtimePlaceholders(input: {
  snapshot: string;
  workspace: string;
  scratchDir: string;
  stateDir: string;
  secrets: CapabilitySecrets;
}) {
  return {
    HOME: homedir(),
    uid: String(typeof process.getuid === 'function' ? process.getuid() : ''),
    pid: String(process.pid),
    snapshot: input.snapshot,
    workspace: input.workspace,
    scratchDir: input.scratchDir,
    stateDir: input.stateDir,
    ...input.secrets,
  } satisfies Record<string, string>;
}

function expandRuntimeValue(value: string, placeholders: Record<string, string>, label: string) {
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced: string | undefined, plain: string | undefined) => {
    const name = braced ?? plain!;
    const replacement = placeholders[name] ?? process.env[name];
    if (replacement === undefined) throw new RuntimeError('capability_unavailable', `${label} requires environment variable ${name}`);
    return replacement;
  });
  if (expanded.includes('$')) throw new RuntimeError('capability_unavailable', `${label} contains an invalid environment reference`);
  return expanded;
}

function runtimePath(value: string, snapshot: string, placeholders: Record<string, string>, label: string) {
  const expanded = expandRuntimeValue(value, placeholders, label);
  return resolve(isAbsolute(expanded) ? expanded : resolve(snapshot, expanded));
}

async function resolveRuntimeCommand(command: string, snapshot: string) {
  const runtime = graphNodeRuntime();
  if (command === 'node') {
    return {
      command,
      path: resolve(runtime.execPath),
      readPaths: nodeReadPaths(runtime.execPath, runtime.electron),
    };
  }
  const candidate = isAbsolute(command)
    ? command
    : command.includes('/') || command.includes('\\')
      ? resolve(snapshot, command)
      : (process.env.PATH ?? '').split(':').filter(Boolean).map(directory => resolve(directory, command)).find(path => {
          try { accessSync(path, constants.X_OK); return true; }
          catch { return false; }
        });
  if (!candidate) throw new RuntimeError('capability_unavailable', `Pi extension runtime command ${command} was not found on PATH`);
  try { accessSync(candidate, constants.X_OK); }
  catch { throw new RuntimeError('capability_unavailable', `Pi extension runtime command ${command} is not executable`); }
  const target = await realpath(candidate);
  return {
    command,
    path: resolve(candidate),
    readPaths: [...new Set([dirname(resolve(candidate)), dirname(target)])],
  };
}

async function resolvePiExtensionRuntime(input: {
  manifest: McpManifest;
  snapshot: string;
  workspace: string;
  scratchDir: string;
  stateDir: string;
  secrets: CapabilitySecrets;
}): Promise<ResolvedPiExtensionRuntime | undefined> {
  const runtime = runtimeDeclaration(input.manifest.runtime);
  if (!runtime) return undefined;
  const placeholders = runtimePlaceholders(input);
  const readPaths = new Set<string>();
  const writePaths = new Set<string>();
  const networkDomains = new Set<string>();
  const unixSockets = new Set<string>();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(runtime.env ?? {})) {
    env[name] = expandRuntimeValue(value, placeholders, `Pi extension runtime.env.${name}`);
  }
  for (const value of runtime.readPaths ?? []) readPaths.add(runtimePath(value, input.snapshot, placeholders, 'Pi extension runtime.readPaths'));
  for (const value of runtime.writePaths ?? []) writePaths.add(runtimePath(value, input.snapshot, placeholders, 'Pi extension runtime.writePaths'));
  for (const value of runtime.unixSockets ?? []) {
    const path = runtimePath(value, input.snapshot, placeholders, 'Pi extension runtime.unixSockets');
    unixSockets.add(path);
    readPaths.add(path);
    writePaths.add(path);
  }
  for (const value of runtime.networkDomains ?? []) {
    networkDomains.add(expandRuntimeValue(value, placeholders, 'Pi extension runtime.networkDomains'));
  }
  for (const command of runtime.commands ?? []) {
    const resolved = await resolveRuntimeCommand(command, input.snapshot);
    for (const path of resolved.readPaths) readPaths.add(path);
    env.PATH = [...new Set([...resolved.readPaths, ...(env.PATH ? env.PATH.split(':') : [])])].join(':');
  }
  return {
    env,
    readPaths: [...readPaths],
    writePaths: [...writePaths],
    networkDomains: [...networkDomains],
    allowUnrestrictedNetwork: runtime.networkAccess === 'unrestricted',
    allowLocalBinding: runtime.allowLocalBinding === true,
    unixSockets: [...unixSockets],
  };
}

async function manifestOf(snapshot: string) {
  try { return JSON.parse(await readFile(join(snapshot, 'capability.json'), 'utf8')) as McpManifest; }
  catch (error) { throw new RuntimeError('capability_unavailable', `Capability manifest is unreadable: ${String(error)}`); }
}

async function promptText(snapshot: string, name: 'agent.md' | 'tool.md') {
  try {
    const value = await readFile(join(snapshot, name), 'utf8');
    if (!value.trim()) throw new Error('empty prompt');
    return value;
  } catch (error) {
    throw new RuntimeError('capability_unavailable', `Prompt ${snapshot} requires a nonempty ${name}: ${String(error)}`);
  }
}

async function fileDigest(path: string) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function textDigest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function extensionEntry(manifest: McpManifest, snapshot: string) {
  const value = typeof manifest.entry === 'string' && manifest.entry.trim() ? manifest.entry : './index.mjs';
  const path = isAbsolute(value) ? value : resolve(snapshot, value);
  if (path !== snapshot && !path.startsWith(`${snapshot}/`)) {
    throw new RuntimeError('capability_unavailable', `Capability entry ${value} must stay inside its snapshot`);
  }
  return path;
}

function skillMetadata(text: string) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const values: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const parsed = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!parsed) continue;
    const raw = parsed[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (raw) values[parsed[1]!] = raw;
  }
  return {
    ...(values.name ? { name: values.name } : {}),
    ...(values.description ? { description: values.description } : {}),
  };
}

export type CapabilitySecrets = Record<string, string>;

function headerValues(headers: unknown, headersEnv: unknown, secrets: CapabilitySecrets = {}) {
  const values: Record<string, string> = {};
  const merge = (source: unknown, resolveValue: (value: string) => string, label: string) => {
    if (source === undefined) return;
    if (!source || typeof source !== 'object' || Array.isArray(source) || Object.values(source).some(value => typeof value !== 'string')) {
      throw new RuntimeError('capability_unavailable', `${label} must be a string map`);
    }
    for (const [header, value] of Object.entries(source as Record<string, string>)) values[header] = resolveValue(value);
  };
  merge(headers, value => value, 'MCP manifest headers');
  merge(headersEnv, name => {
    const value = secrets[name] ?? process.env[name];
    if (!value) throw new RuntimeError('capability_unavailable', `MCP manifest requires environment variable ${name}`);
    return value;
  }, 'MCP manifest headersEnv');
  return values;
}

function environmentValues(env: unknown, secrets: CapabilitySecrets = {}) {
  if (env === undefined) return undefined;
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(value => typeof value !== 'string')) {
    throw new RuntimeError('capability_unavailable', 'MCP manifest env must be a string map');
  }
  const values: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(env as Record<string, string>)) {
    const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(rawValue)?.[1]
      ?? (/^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(rawValue)?.[1]);
    if (reference) {
      const value = secrets[reference] ?? process.env[reference];
      if (value === undefined) throw new RuntimeError('capability_unavailable', `MCP manifest requires environment variable ${reference}`);
      values[name] = value;
    } else {
      values[name] = rawValue;
    }
  }
  return values;
}

function resolveManifestDomains(declared: unknown, label: string, granted: string[] = [], secrets: CapabilitySecrets = {}) {
  if (declared === undefined) return normalizeDomains(granted);
  if (!Array.isArray(declared) || declared.some(value => typeof value !== 'string' || !value.trim())) {
    throw new RuntimeError('capability_unavailable', `${label} must be an array of nonempty strings`);
  }
  const resolved: string[] = [];
  for (const value of declared as string[]) {
    const expanded = value.trim().replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced: string | undefined, plain: string | undefined) => {
      const name = braced ?? plain!;
      const replacement = secrets[name] ?? process.env[name];
      if (!replacement) throw new RuntimeError('capability_unavailable', `MCP manifest requires environment variable ${name}`);
      return replacement;
    });
    if (expanded.includes('$')) throw new RuntimeError('capability_unavailable', `${label} contains an invalid environment reference: ${value}`);
    let host = expanded;
    try {
      const url = new URL(expanded);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported protocol');
      if (url.username || url.password) throw new Error('embedded credentials');
      host = url.hostname;
    } catch (error) {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(expanded)) {
        throw new RuntimeError('capability_unavailable', `${label} URL is invalid: ${value}`);
      }
    }
    try { resolved.push(normalizeDomainPattern(host)); }
    catch { throw new RuntimeError('capability_unavailable', `${label} contains an invalid host: ${host}`); }
  }
  return normalizeDomains([...granted, ...resolved]);
}

/** Resolve capability-declared host patterns; base URLs are reduced to their hostname. */
function manifestNetworkDomains(manifest: McpManifest, granted: string[] = [], secrets: CapabilitySecrets = {}) {
  return resolveManifestDomains(manifest.networkDomains, 'MCP networkDomains', granted, secrets);
}

async function mcpProvisioningPlan(manifest: McpManifest, snapshot: string, secrets: CapabilitySecrets = {}): Promise<McpProvisioningPlan | undefined> {
  const command = typeof manifest.command === 'string' ? manifest.command.trim() : '';
  const inferred = command === 'uvx' ? 'uv' : command === 'npx' ? 'npm' : undefined;
  if (!inferred && manifest.provisioning !== undefined) {
    throw new RuntimeError('capability_unavailable', 'MCP provisioning is only valid for uvx or npx commands');
  }
  if (!inferred) return undefined;
  let manager = inferred as 'uv' | 'npm';
  let extraDomains: unknown;
  if (manifest.provisioning !== undefined) {
    if (!manifest.provisioning || typeof manifest.provisioning !== 'object' || Array.isArray(manifest.provisioning)) {
      throw new RuntimeError('capability_unavailable', 'MCP provisioning must be an object');
    }
    const value = manifest.provisioning as Record<string, unknown>;
    if (value.manager !== undefined) {
      if (value.manager !== 'uv' && value.manager !== 'npm') {
        throw new RuntimeError('capability_unavailable', 'MCP provisioning.manager must be uv or npm');
      }
      if (value.manager !== inferred) {
        throw new RuntimeError('capability_unavailable', `MCP provisioning.manager does not match command ${command}`);
      }
      manager = value.manager;
    }
    extraDomains = value.domains;
  }
  const defaults = manager === 'uv' ? UV_PROVISIONING_DOMAINS : NPM_PROVISIONING_DOMAINS;
  const domains = resolveManifestDomains(extraDomains, 'MCP provisioning.domains', [...defaults], secrets);
  const key = createHash('sha256').update(canonicalJson({
    command,
    args: manifest.args,
    provisioning: { manager, domains },
  })).digest('hex');
  const root = join(snapshot, '.graph-provisioning', key);
  return {
    manager,
    domains,
    root,
    readyFile: join(root, '.ready'),
    key,
  };
}

function mcpProvisioningEnvironment(plan: McpProvisioningPlan, phase: 'provision' | 'runtime') {
  const cache = join(plan.root, 'cache');
  if (plan.manager === 'uv') {
    return {
      UV_CACHE_DIR: cache,
      UV_PYTHON_INSTALL_DIR: join(plan.root, 'python'),
      UV_NO_PROGRESS: '1',
      ...(phase === 'runtime' ? { UV_OFFLINE: '1' } : {}),
    };
  }
  return {
    npm_config_cache: cache,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    ...(phase === 'runtime' ? {
      npm_config_offline: 'true',
      npm_config_prefer_offline: 'true',
    } : {}),
  };
}

/** A granted remote MCP endpoint; the runtime allowlist is checked before any request. */
function remoteConnection(manifest: McpManifest, gate: SendGate, mcpDomains: string[], secrets: CapabilitySecrets = {}): McpExchange {
  if (typeof manifest.url !== 'string' || !manifest.url.trim()) {
    throw new RuntimeError('capability_unavailable', 'An MCP capability requires capability.json with an absolute command or a remote url');
  }
  let url: URL;
  try { url = new URL(manifest.url); }
  catch { throw new RuntimeError('capability_unavailable', `Remote MCP url is invalid: ${manifest.url}`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new RuntimeError('capability_unavailable', `Remote MCP supports http and https, not ${url.protocol}`);
  if (url.username || url.password) throw new RuntimeError('capability_unavailable', 'Remote MCP urls cannot embed credentials');
  const domains = manifestNetworkDomains(manifest, [...mcpDomains, url.hostname], secrets);
  if (!allowedDomain(domains, url.hostname)) {
    throw new RuntimeError('capability_unavailable', `Remote MCP host ${url.hostname} is not in the granted MCP domains`);
  }
  return httpExchange({ gate, url: url.href, headers: headerValues(manifest.headers, manifest.headersEnv, secrets), timeoutMs: 30_000 });
}

export interface CapabilityCheckResult {
  ok: boolean;
  tools: string[];
  message: string;
}

/** Verify one credential-bound MCP without mutating task or capability state. */
export async function verifyMcpCapability(record: CapabilityRecord, secrets: CapabilitySecrets = {}): Promise<CapabilityCheckResult> {
  if (record.kind !== 'mcp') return { ok: false, tools: [], message: 'Only MCP capabilities can be verified here' };
  const snapshot = snapshotPath(record);
  const manifest = await manifestOf(snapshot);
  const gate: SendGate = { dispatch: (_id, _reservation, send) => send(), settle: () => undefined };
  let release: (() => Promise<void>) | undefined;
  let workspace: string | undefined;
  try {
    let connection: McpExchange;
    if (typeof manifest.command === 'string') {
      workspace = await mkdtemp(join(tmpdir(), 'graph-capability-check-'));
      const scratch = join(workspace, 'scratch');
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      const domains = manifestNetworkDomains(manifest, [], secrets);
      const provisioning = await ensureMcpProvisioned({
        gate,
        manifest,
        snapshot,
        workspace,
        scratchDir: scratch,
        ...(secrets ? { secrets } : {}),
        ...(domains.length ? { runtimeDomains: domains } : {}),
      });
      const acquired = await acquireRestrictedExecutor();
      release = acquired.release;
      connection = await localConnection({
        executor: acquired.executor,
        gate,
        manifest,
        snapshot,
        workspace,
        scratchDir: scratch,
        secrets,
        ...(provisioning ? { provisioning: { plan: provisioning, phase: 'runtime' } } : {}),
        ...(domains.length ? { networkDomains: domains } : {}),
        ...(manifest.networkAccess === 'unrestricted' ? { allowUnrestrictedNetwork: true } : {}),
      });
    } else {
      connection = remoteConnection(manifest, gate, [], secrets);
    }
    const tools = await listMcpTools(connection);
    return { ok: true, tools: tools.map(tool => tool.name), message: `连接成功，发现 ${tools.length} 个工具` };
  } catch (error) {
    return { ok: false, tools: [], message: error instanceof Error ? error.message : String(error) };
  } finally {
    await release?.().catch(() => undefined);
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}

/** Read paths a sandboxed helper needs to start the Node runtime itself.
 * Inside a packaged Electron app `process.execPath` is the bundle binary, and
 * loading it needs the sibling `Frameworks` directory, not just `MacOS`. */
export function nodeReadPaths(execPath = process.execPath, electron = process.versions.electron as string | undefined): string[] {
  const macos = dirname(execPath);
  return electron ? [macos, dirname(macos)] : [macos];
}

function localNodeReadPaths(runtime: { execPath: string; electron?: string | undefined }) {
  return [...new Set([
    ...nodeReadPaths(runtime.execPath, runtime.electron),
    ...(runtime.execPath.startsWith('/opt/homebrew/')
      ? [
        '/opt/homebrew/opt',
        '/opt/homebrew/lib',
        '/opt/homebrew/Cellar',
        '/opt/homebrew/etc/openssl@3',
        '/opt/homebrew/etc/openssl@1.1',
      ].filter(existsSync)
      : []),
  ])];
}

async function runGrants(workspace: string, scratchDir: string) {
  // The verified OS sandbox requires canonical, already-existing grants.
  const canonicalWorkspace = await realpath(workspace);
  await mkdir(scratchDir, { recursive: true, mode: 0o700 });
  return { workspace: canonicalWorkspace, scratchDir: await realpath(scratchDir) };
}

function bindingKey(bound: CapabilityBinding, role: string) {
  return `${bound.id}@${bound.version}:${role}`;
}

function stableFact(fact: CapabilityLoadFact) {
  return {
    id: fact.id,
    version: fact.version,
    kind: fact.kind,
    name: fact.name ?? null,
    description: fact.description ?? null,
    path: fact.path ?? null,
    tools: fact.tools ?? [],
    networkDomains: fact.networkDomains ?? [],
    networkAccess: fact.networkAccess ?? null,
    provisioning: fact.provisioning ?? null,
    runtime: fact.runtime ?? null,
  };
}

async function localConnection(input: {
  executor: Awaited<ReturnType<typeof acquireRestrictedExecutor>>['executor']; gate: SendGate;
  manifest: McpManifest; snapshot: string; workspace: string; scratchDir: string; readOnly?: boolean;
  networkDomains?: string[];
  allowUnrestrictedNetwork?: boolean;
  access?: ResolvedAccessPolicy;
  secrets?: CapabilitySecrets;
  provisioning?: { plan: McpProvisioningPlan; phase: 'provision' | 'runtime' };
  timeoutMs?: number;
  hostCommands?: boolean;
}): Promise<McpExchange> {
  const resolved = await resolveLocalMcpCommand(input.manifest.command, input.hostCommands === true);
  const args = Array.isArray(input.manifest.args) && input.manifest.args.every(value => typeof value === 'string') ? input.manifest.args as string[] : [];
  const grants = await runGrants(input.workspace, input.scratchDir);
  const env = {
    ...(environmentValues(input.manifest.env, input.secrets) ?? {}),
    ...(input.provisioning ? mcpProvisioningEnvironment(input.provisioning.plan, input.provisioning.phase) : {}),
  };
  const provisioningPaths = input.provisioning ? [input.provisioning.plan.root] : [];
  const protectedPathExceptions = [
    input.snapshot,
    ...resolved.readPaths,
    ...provisioningPaths,
  ];
  return stdioExchange({
    executor: input.executor, gate: input.gate, cwd: grants.workspace, scratchDir: grants.scratchDir,
    command: resolved.executable,
    args: [...resolved.argsPrefix, ...args.map(arg => resolveMcpArg(input.snapshot, arg, input.secrets))],
    ...(Object.keys(env).length ? { env } : {}),
    readPaths: [input.snapshot, ...resolved.readPaths, ...provisioningPaths],
    // Discussion turns may read the business directory but only write scratch.
    writePaths: [...(input.readOnly ? [grants.scratchDir] : [grants.workspace, grants.scratchDir]), ...provisioningPaths],
    ...(provisioningPaths.length ? { allowGitMetadataWrites: provisioningPaths } : {}),
    timeoutMs: input.timeoutMs ?? 30_000,
    ...(input.networkDomains?.length ? { networkDomains: input.networkDomains } : {}),
    ...(input.allowUnrestrictedNetwork ? { allowUnrestrictedNetwork: true } : {}),
    ...(input.access ? {
      filesystem: input.access.filesystem.read === 'host' || input.access.filesystem.write === 'host' ? 'host' as const : 'bounded' as const,
      protectedPaths: input.access.protectedPaths,
      ...(protectedPathExceptions.length ? { protectedPathExceptions } : {}),
      allowGitMetadataWritesAll: input.access.filesystem.gitMetadata === 'writable',
      allowLocalBinding: input.access.piExtensions.localBinding,
      allowAllUnixSockets: input.access.piExtensions.unixSockets === 'all',
      allowAppleEvents: input.access.piExtensions.appleEvents,
    } : {}),
  });
}

async function ensureMcpProvisioned(input: {
  gate: SendGate;
  manifest: McpManifest;
  snapshot: string;
  workspace: string;
  scratchDir: string;
  secrets?: CapabilitySecrets;
  runtimeDomains?: string[];
  hostCommands?: boolean;
  allowUnrestrictedNetwork?: boolean;
  access?: ResolvedAccessPolicy;
}): Promise<McpProvisioningPlan | undefined> {
  const plan = await mcpProvisioningPlan(input.manifest, input.snapshot, input.secrets);
  if (!plan) return undefined;
  await mkdir(plan.root, { recursive: true, mode: 0o700 });
  if (existsSync(plan.readyFile)) return plan;
  const acquired = await acquireRestrictedExecutor();
  try {
    const connection = await localConnection({
      executor: acquired.executor,
      gate: input.gate,
      manifest: input.manifest,
      snapshot: input.snapshot,
      workspace: input.workspace,
      scratchDir: input.scratchDir,
      ...(input.secrets ? { secrets: input.secrets } : {}),
      provisioning: { plan, phase: 'provision' },
      networkDomains: [...new Set([...plan.domains, ...(input.runtimeDomains ?? [])])],
      timeoutMs: 120_000,
      ...(input.hostCommands ? { hostCommands: true } : {}),
      ...(input.allowUnrestrictedNetwork ? { allowUnrestrictedNetwork: true } : {}),
      ...(input.access ? { access: input.access } : {}),
    });
    await listMcpTools(connection);
    await writeFile(plan.readyFile, `${plan.key}\n`, { mode: 0o600 });
    return plan;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RuntimeError('capability_unavailable', `${plan.manager} provisioning failed: ${message}`);
  } finally {
    await acquired.release();
  }
}

function localMcpSearchDirectories(command: string) {
  const configured = (process.env.PATH ?? '').split(':').filter(Boolean);
  const common = [
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const preferred = command === 'uvx'
    ? [join(homedir(), '.local', 'bin'), ...common]
    : command === 'npx'
      ? ['/opt/homebrew/bin', '/usr/local/bin', ...common]
      : common;
  return [...new Set([...configured, ...preferred])];
}

function findExecutable(command: string) {
  for (const directory of localMcpSearchDirectories(command)) {
    const candidate = resolve(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return undefined;
}

async function resolveLocalMcpCommand(value: unknown, hostCommands = false): Promise<{
  executable: string;
  argsPrefix: string[];
  readPaths: string[];
}> {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RuntimeError('capability_unavailable', 'A local MCP capability requires capability.json with a command');
  }
  const command = value.trim();
  if (command === 'node') {
    const runtime = graphNodeRuntime();
    return {
      executable: runtime.execPath,
      argsPrefix: [],
      readPaths: localNodeReadPaths(runtime),
    };
  }
  if (!hostCommands && !isLocalMcpCommand(command) && !isAbsolute(command)) {
    throw new RuntimeError(
      'capability_unavailable',
      `A local MCP command must be one of ${LOCAL_MCP_COMMANDS.join(', ')} or an absolute executable path`,
    );
  }

  const candidate = isAbsolute(command) ? command : findExecutable(command);
  if (!candidate) throw new RuntimeError('capability_unavailable', `Local MCP command "${command}" was not found on PATH`);
  try {
    accessSync(candidate, constants.X_OK);
  } catch {
    throw new RuntimeError('capability_unavailable', `Local MCP command "${command}" is not executable`);
  }
  const target = await realpath(candidate);
  const baseReadPaths = [...new Set([dirname(candidate), dirname(target)])];
  if (command === 'npx') {
    const runtime = graphNodeRuntime();
    return {
      executable: runtime.execPath,
      argsPrefix: [target],
      // npx-cli.js loads npm's package files relative to its real path.
      readPaths: [...new Set([
        ...localNodeReadPaths(runtime),
        ...baseReadPaths,
        dirname(dirname(runtime.execPath)),
        dirname(dirname(target)),
      ])],
    };
  }
  return { executable: candidate, argsPrefix: [], readPaths: baseReadPaths };
}

/** Extensions load only inside the restricted worker, never in the background process. */
async function extensionConnection(input: {
  executor: Awaited<ReturnType<typeof acquireRestrictedExecutor>>['executor']; gate: SendGate;
  manifest: McpManifest; snapshot: string; workspace: string; scratchDir: string; readOnly?: boolean;
  access?: ResolvedAccessPolicy;
}): Promise<McpExchange> {
  const entryValue = typeof input.manifest.entry === 'string' && input.manifest.entry.trim() ? input.manifest.entry : './index.mjs';
  const entry = isAbsolute(entryValue) ? entryValue : resolve(input.snapshot, entryValue);
  if (entry !== input.snapshot && !entry.startsWith(`${input.snapshot}/`)) {
    throw new RuntimeError('capability_unavailable', `Extension entry ${entryValue} must stay inside the snapshot`);
  }
  if (!existsSync(entry)) throw new RuntimeError('capability_unavailable', `Extension entry ${entryValue} does not exist`);
  const grants = await runGrants(input.workspace, input.scratchDir);
  return stdioExchange({
    executor: input.executor, gate: input.gate, cwd: grants.workspace, scratchDir: grants.scratchDir,
    command: graphNodeRuntime().execPath, args: [extensionWorker, await realpath(entry)],
    readPaths: [input.snapshot, ...nodeReadPaths(graphNodeRuntime().execPath, process.env.GRAPH_APP_NODE ? undefined : process.versions.electron as string | undefined), dirname(extensionWorker)],
    // Extension register() and every tool call share this restriction, so a
    // bound extension cannot write business files during discussion.
    writePaths: input.readOnly ? [grants.scratchDir] : [grants.workspace, grants.scratchDir],
    ...(input.access ? {
      filesystem: input.access.filesystem.read === 'host' || input.access.filesystem.write === 'host' ? 'host' as const : 'bounded' as const,
      protectedPaths: input.access.protectedPaths,
      protectedPathExceptions: [input.snapshot, entry, dirname(entry)],
      allowGitMetadataWritesAll: input.access.filesystem.gitMetadata === 'writable',
      allowLocalBinding: input.access.piExtensions.localBinding,
      allowAllUnixSockets: input.access.piExtensions.unixSockets === 'all',
      allowAppleEvents: input.access.piExtensions.appleEvents,
    } : {}),
  });
}

function capabilityTools(
  connection: McpExchange, tools: McpTool[], capability: { id: string; version: string },
  authorization?: { grants: string[]; onPermissionRequired?: (request: CapabilityPermissionRequest) => void },
): ToolDefinition[] {
  return tools.map(tool => externallyGated({
    name: mcpToolName(capability.id, tool.name), label: `${tool.name} (${capability.id})`,
    description: tool.description ?? `MCP tool ${tool.name} from ${capability.id}@${capability.version}`,
    parameters: Type.Unsafe(tool.inputSchema ?? { type: 'object', properties: {} }),
    execute: async (_id, params) => {
      // The bound capability loader pre-authorizes every discovered tool.
      // Explicit task grants remain an audit-compatible additional source.
      if (authorization) {
        const grant = mcpGrant(capability.id, tool.name);
        if (!authorization.grants.includes(grant)) {
          authorization.onPermissionRequired?.({ grant, capabilityId: capability.id, tool: tool.name, description: tool.description ?? '' });
          throw new Error(`Permission required: MCP tool ${tool.name} needs the task grant ${grant}`);
        }
      }
      const result = await callMcpTool(connection, tool.name, params as Json);
      const content = result.content.length ? result.content : [{ type: 'text' as const, text: 'MCP tool returned no content' }];
      if (result.isError) throw new Error(content.map(part => part.text).join('\n'));
      return { content, details: {} };
    },
  }));
}

/**
 * Load the capabilities bound by an Agent definition version.
 *
 * Skills become Pi resources and a read-only tool; local MCP servers and
 * extensions run one restricted process per call; remote MCP talks to a host in
 * the runtime's granted domains. Every tool call passes the same send gate as
 * model calls.
 */
export async function resolveCapabilityFacts(
  catalog: Catalog,
  definitionVersion?: string,
): Promise<ResolvedCapabilityFact[]> {
  if (!definitionVersion) return [];
  let definition: ReturnType<Catalog['definition']>;
  try { definition = catalog.definition(definitionVersion); }
  catch { return []; }
  const bindings: { bound: CapabilityBinding; role: 'capability' | 'agent' | 'tool' }[] = [
    ...(definition.capabilities ?? []).map(bound => ({ bound, role: 'capability' as const })),
    ...(definition.prompts?.agent ? [{ bound: definition.prompts.agent, role: 'agent' as const }] : []),
    ...(definition.prompts?.tool ? [{ bound: definition.prompts.tool, role: 'tool' as const }] : []),
  ];
  const facts: ResolvedCapabilityFact[] = [];
  const seen = new Set<string>();
  for (const { bound, role } of bindings) {
    const key = `${role}:${bound.id}@${bound.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const record = catalog.capability(bound.id, bound.version);
    if (!record || record.status !== 'available') {
      throw new RuntimeError('capability_unavailable', `Capability ${bound.id}@${bound.version} is not available in the capability directory`);
    }
    const snapshot = snapshotPath(record);
    if (record.kind === 'prompt') {
      if (role === 'capability') throw new RuntimeError('capability_unsupported', `Prompt capability ${bound.id}@${bound.version} must be bound under prompts`);
      const file = role === 'agent' ? 'agent.md' : 'tool.md';
      const body = await promptText(snapshot, file);
      facts.push({
        id: bound.id,
        version: bound.version,
        kind: record.kind,
        role: role === 'agent' ? 'agent' : 'tool',
        source: record.source,
        path: join(snapshot, file),
        digest: textDigest(body),
      });
      continue;
    }
    if (role !== 'capability') {
      throw new RuntimeError('capability_unsupported', `${role} prompt binding ${bound.id}@${bound.version} is not a prompt capability`);
    }
    const manifest = await manifestOf(snapshot);
    if (record.kind === 'skill') {
      const file = join(snapshot, 'SKILL.md');
      if (!existsSync(file)) throw new RuntimeError('capability_unavailable', `Skill ${bound.id}@${bound.version} has no SKILL.md`);
      const body = await readFile(file, 'utf8');
      facts.push({
        id: bound.id,
        version: bound.version,
        kind: record.kind,
        source: record.source,
        path: file,
        digest: textDigest(body),
      });
      continue;
    }
    if (record.kind === 'pi-extension') {
      const entry = extensionEntry(manifest, snapshot);
      if (!existsSync(entry)) throw new RuntimeError('capability_unavailable', `Pi extension ${bound.id}@${bound.version} entry does not exist`);
      const declared = declaredTools(manifest);
      facts.push({
        id: bound.id,
        version: bound.version,
        kind: record.kind,
        source: record.source,
        path: snapshot,
        digest: textDigest(canonicalJson({
          manifest: manifest as unknown as Json,
          entry: await fileDigest(entry),
        })),
        declaredTools: declared,
        entry,
      });
      continue;
    }
    if (record.kind === 'extension') {
      const entry = extensionEntry(manifest, snapshot);
      if (!existsSync(entry)) throw new RuntimeError('capability_unavailable', `Graph extension ${bound.id}@${bound.version} entry does not exist`);
      facts.push({
        id: bound.id,
        version: bound.version,
        kind: record.kind,
        source: record.source,
        path: snapshot,
        digest: textDigest(canonicalJson({
          manifest: manifest as unknown as Json,
          entry: await fileDigest(entry),
        })),
        entry,
      });
      continue;
    }
    const networkAccess = manifest.networkAccess === 'unrestricted' ? 'unrestricted' : undefined;
    const networkDomains = Array.isArray(manifest.networkDomains)
      ? manifest.networkDomains.filter((domain): domain is string => typeof domain === 'string')
      : undefined;
    const provisioningManager = manifest.command === 'uvx'
      ? 'uv' as const
      : manifest.command === 'npx'
        ? 'npm' as const
        : undefined;
    facts.push({
      id: bound.id,
      version: bound.version,
      kind: record.kind,
      source: record.source,
      path: snapshot,
      digest: textDigest(canonicalJson(manifest as unknown as Json)),
      ...(typeof manifest.command === 'string' ? { command: manifest.command } : {}),
      ...(typeof manifest.url === 'string' ? { url: manifest.url } : {}),
      ...(networkDomains?.length ? { networkDomains } : {}),
      ...(networkAccess ? { networkAccess } : {}),
      ...(provisioningManager ? {
        provisioning: {
          manager: provisioningManager,
          domains: [...(provisioningManager === 'uv' ? UV_PROVISIONING_DOMAINS : NPM_PROVISIONING_DOMAINS)],
        },
      } : {}),
    });
  }
  return facts.sort((left, right) =>
    `${left.kind}:${left.role ?? ''}:${left.id}@${left.version}`.localeCompare(`${right.kind}:${right.role ?? ''}:${right.id}@${right.version}`));
}

/** Internal resource loader. Production callers consume CapabilityBundleVersion. */
export async function loadCapabilities(input: {
  catalog: Catalog;
  definitionVersion?: string;
  workspace: string;
  scratchDir: string;
  gate: SendGate;
  /** Immutable Graph bootstrap prompts are not user capabilities. */
  bootstrap?: { agent?: string; tool?: string };
  mcpDomains?: string[];
  grants?: string[];
  /** Discussion turns investigate without writing the business directory. */
  readOnly?: boolean;
  /** APP/keychain values merged over the daemon environment for MCP config. */
  secrets?: CapabilitySecrets;
  onPermissionRequired?: (request: CapabilityPermissionRequest) => void;
  /** Effective host access policy for this operation. */
  access?: ResolvedAccessPolicy;
}): Promise<LoadedCapabilities> {
  const skillPaths: string[] = [];
  const piExtensionPaths: string[] = [];
  const piExtensionTools: string[] = [];
  const readRoots: string[] = [];
  const writeRoots: string[] = [];
  const env: Record<string, string> = {};
  const runtimeNetworkDomains = new Set<string>();
  const runtimeUnixSockets = new Set<string>();
  let runtimeUnrestrictedNetwork = false;
  let runtimeLocalBinding = false;
  const tools: ToolDefinition[] = [];
  let agentPrompt: string | null = input.bootstrap?.agent?.trim() || null;
  let toolPrompt: string | null = input.bootstrap?.tool?.trim() || null;
  const releases: (() => Promise<void>)[] = [];
  // Actual load facts: later projections must never guess these from catalog
  // status alone.
  const report: CapabilityLoadFact[] = [];
  const close = async () => { for (const release of releases.reverse()) await release(); releases.length = 0; };
  const digest = () => createHash('sha256').update(canonicalJson({
    definitionVersion: input.definitionVersion ?? null,
    report: report.map(stableFact) as unknown as Json,
    skillPaths,
    piExtensionPaths,
    piExtensionTools,
    writeRoots,
    env,
    networkDomains: [...runtimeNetworkDomains],
    allowUnrestrictedNetwork: runtimeUnrestrictedNetwork,
    allowLocalBinding: runtimeLocalBinding,
    unixSockets: [...runtimeUnixSockets],
    prompts: { agent: agentPrompt, tool: toolPrompt },
    tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters as unknown as Json })),
  })).digest('hex');
  if (!input.definitionVersion) return {
    skillPaths, piExtensionPaths, piExtensionTools, readRoots, writeRoots, env,
    networkDomains: [...runtimeNetworkDomains],
    allowUnrestrictedNetwork: runtimeUnrestrictedNetwork,
    allowLocalBinding: runtimeLocalBinding,
    unixSockets: [...runtimeUnixSockets],
    tools, prompts: { agent: agentPrompt, tool: toolPrompt }, digest: digest(), close, report,
  };
  let definition;
  try { definition = input.catalog.definition(input.definitionVersion); }
  catch { return {
    skillPaths, piExtensionPaths, piExtensionTools, readRoots, writeRoots, env,
    networkDomains: [...runtimeNetworkDomains],
    allowUnrestrictedNetwork: runtimeUnrestrictedNetwork,
    allowLocalBinding: runtimeLocalBinding,
    unixSockets: [...runtimeUnixSockets],
    tools, prompts: { agent: agentPrompt, tool: toolPrompt }, digest: digest(), close, report,
  }; } // Unpublished definitions keep briefing-only behavior.
  try {
    const bindings: { bound: CapabilityBinding; role: 'capability' | 'agent' | 'tool' }[] = [
      ...(definition.capabilities ?? []).map(bound => ({ bound, role: 'capability' as const })),
      ...(definition.prompts?.agent ? [{ bound: definition.prompts.agent, role: 'agent' as const }] : []),
      ...(definition.prompts?.tool ? [{ bound: definition.prompts.tool, role: 'tool' as const }] : []),
    ];
    const seen = new Set<string>();
    for (const { bound, role } of bindings) {
      const seenKey = bindingKey(bound, role);
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);
      const record = input.catalog.capability(bound.id, bound.version);
      if (!record || record.status !== 'available') {
        throw new RuntimeError('capability_unavailable', `Capability ${bound.id}@${bound.version} is not available in the capability directory`);
      }
      const snapshot = snapshotPath(record);
      if (record.kind === 'prompt') {
        if (role === 'capability') throw new RuntimeError('capability_unsupported', `Prompt capability ${bound.id}@${bound.version} must be bound under prompts`);
        const text = await promptText(snapshot, role === 'agent' ? 'agent.md' : 'tool.md');
        if (role === 'agent') agentPrompt = text;
        else toolPrompt = [toolPrompt, text].filter(Boolean).join('\n\n');
        report.push({ id: bound.id, version: bound.version, kind: record.kind, loaded: true, executable: false, reason: `${role === 'agent' ? '身份' : '能力感知'} Prompt 已注入` });
        continue;
      }
      if (role !== 'capability') throw new RuntimeError('capability_unsupported', `${role} prompt binding ${bound.id}@${bound.version} is not a prompt capability`);
      if (record.kind === 'skill') {
        const skillFile = join(snapshot, 'SKILL.md');
        if (!existsSync(skillFile)) throw new RuntimeError('capability_unavailable', `Skill ${bound.id}@${bound.version} has no SKILL.md`);
        const metadata = skillMetadata(await readFile(skillFile, 'utf8'));
        skillPaths.push(snapshot);
        readRoots.push(snapshot);
        report.push({
          id: bound.id, version: bound.version, kind: record.kind, loaded: true, executable: false,
          reason: '技能已加载为只读文档', path: skillFile, ...metadata,
        });
        continue;
      }
      if (record.kind === 'pi-extension') {
        if (!existsSync(snapshot)) throw new RuntimeError('capability_unavailable', `Pi extension ${bound.id}@${bound.version} has no snapshot`);
        const manifest = await manifestOf(snapshot);
        const entryValue = typeof manifest.entry === 'string' && manifest.entry.trim() ? manifest.entry : './index.mjs';
        const entry = isAbsolute(entryValue) ? entryValue : resolve(snapshot, entryValue);
        if (entry !== snapshot && !entry.startsWith(`${snapshot}/`)) {
          throw new RuntimeError('capability_unavailable', `Pi extension entry ${entryValue} must stay inside the snapshot`);
        }
        if (!existsSync(entry)) throw new RuntimeError('capability_unavailable', `Pi extension entry ${entryValue} does not exist`);
        const declared = declaredTools(manifest);
        piExtensionPaths.push(entry);
        piExtensionTools.push(...declared.map(tool => tool.name));
        readRoots.push(snapshot);
        const runtime = await resolvePiExtensionRuntime({
          manifest,
          snapshot,
          workspace: input.workspace,
          scratchDir: input.scratchDir,
          stateDir: dirname(input.scratchDir),
          secrets: input.secrets ?? {},
        });
        if (runtime) {
          for (const [name, value] of Object.entries(runtime.env)) env[name] = value;
          for (const path of [...runtime.writePaths, ...runtime.unixSockets]) {
            await mkdir(path, { recursive: true, mode: 0o700 });
          }
          readRoots.push(...runtime.readPaths);
          writeRoots.push(...runtime.writePaths);
          for (const domain of runtime.networkDomains) runtimeNetworkDomains.add(domain);
          for (const path of runtime.unixSockets) runtimeUnixSockets.add(path);
          runtimeUnrestrictedNetwork ||= runtime.allowUnrestrictedNetwork;
          runtimeLocalBinding ||= runtime.allowLocalBinding;
        }
        report.push({
          id: bound.id, version: bound.version, kind: record.kind, loaded: true, executable: true,
          reason: [
            `独立 Pi 进程内加载；声明工具 ${declared.length} 个`,
            runtime ? `运行时声明：命令 ${runtime.env.PATH ? '已解析' : '无'}，网络 ${runtime.allowUnrestrictedNetwork ? '不受限' : runtime.networkDomains.length ? runtime.networkDomains.join(', ') : '无'}，Unix socket ${runtime.unixSockets.length}` : '',
          ].filter(Boolean).join('；'),
          path: entry,
          ...(declared.length ? { tools: declared.map(tool => tool.name) } : {}),
          ...(runtime ? {
            runtime: {
              env: Object.keys(runtime.env).sort(),
              readPaths: runtime.readPaths,
              writePaths: runtime.writePaths,
              networkDomains: runtime.networkDomains,
              networkAccess: runtime.allowUnrestrictedNetwork ? 'unrestricted' : null,
              allowLocalBinding: runtime.allowLocalBinding,
              unixSockets: runtime.unixSockets,
            } as unknown as Json,
          } : {}),
        });
        continue;
      }
      if (record.kind !== 'mcp' && record.kind !== 'extension') {
        throw new RuntimeError('capability_unsupported', `Capability kind ${record.kind} is not loadable`);
      }
      const manifest = await manifestOf(snapshot);
      let connection: McpExchange;
      let authorization: { grants: string[]; onPermissionRequired?: (request: CapabilityPermissionRequest) => void } | undefined;
      let loadedReason: string | null = null;
      let networkDomains: string[] = [];
      let networkAccess: 'unrestricted' | undefined;
      let provisioning: McpProvisioningPlan | undefined;
      if (record.kind === 'extension') {
        const acquired = await acquireRestrictedExecutor();
        releases.push(acquired.release);
        connection = await extensionConnection({
          executor: acquired.executor,
          gate: input.gate,
          manifest,
          snapshot,
          workspace: input.workspace,
          scratchDir: input.scratchDir,
          ...(input.readOnly ? { readOnly: true } : {}),
          ...(input.access ? { access: input.access } : {}),
        });
        loadedReason = input.readOnly ? '只读讨论模式：本地扩展在 scratch 只读范围加载' : null;
      } else if (typeof manifest.command === 'string') {
        const fullNetwork = input.access?.network === 'unrestricted';
        if (!fullNetwork && manifest.networkAccess !== undefined && manifest.networkAccess !== 'unrestricted') {
          throw new RuntimeError('capability_unavailable', 'MCP networkAccess must be "unrestricted"');
        }
        networkAccess = fullNetwork || manifest.networkAccess === 'unrestricted' ? 'unrestricted' : undefined;
        if (!fullNetwork && networkAccess && manifest.networkDomains !== undefined) {
          throw new RuntimeError('capability_unavailable', 'MCP cannot combine networkDomains with unrestricted network access');
        }
        networkDomains = networkAccess ? [] : manifestNetworkDomains(manifest, input.mcpDomains ?? [], input.secrets);
        if (networkDomains.length || networkAccess) {
          authorization = {
            grants: input.grants ?? [],
            ...(input.onPermissionRequired ? { onPermissionRequired: input.onPermissionRequired } : {}),
          };
        }
        provisioning = await ensureMcpProvisioned({
          gate: input.gate,
          manifest,
          snapshot,
          workspace: input.workspace,
          scratchDir: input.scratchDir,
          ...(input.secrets ? { secrets: input.secrets } : {}),
          ...(networkDomains.length ? { runtimeDomains: networkDomains } : {}),
          ...(input.access?.commands === 'host' ? { hostCommands: true } : {}),
          ...(fullNetwork ? { allowUnrestrictedNetwork: true } : {}),
          ...(input.access ? { access: input.access } : {}),
        });
        const acquired = await acquireRestrictedExecutor();
        releases.push(acquired.release);
        connection = await localConnection({
          executor: acquired.executor, gate: input.gate, manifest, snapshot, workspace: input.workspace, scratchDir: input.scratchDir,
          ...(input.readOnly ? { readOnly: true } : {}),
          ...(provisioning ? { provisioning: { plan: provisioning, phase: 'runtime' } } : {}),
          ...(input.access?.commands === 'host' ? { hostCommands: true } : {}),
          ...(networkDomains.length ? { networkDomains } : {}),
          ...(networkAccess ? { allowUnrestrictedNetwork: true } : {}),
          ...(input.secrets ? { secrets: input.secrets } : {}),
          ...(input.access ? { access: input.access } : {}),
        });
        loadedReason = input.readOnly ? '只读讨论模式：本地能力在只读范围加载' : null;
      } else {
        if (manifest.networkAccess !== undefined) {
          throw new RuntimeError('capability_unavailable', 'MCP networkAccess is only valid for local MCP commands');
        }
        const grants = input.grants ?? [];
        authorization = { grants, ...(input.onPermissionRequired ? { onPermissionRequired: input.onPermissionRequired } : {}) };
        connection = remoteConnection(manifest, input.gate, input.mcpDomains ?? [], input.secrets);
        networkDomains = manifestNetworkDomains(manifest, [...(input.mcpDomains ?? []), new URL(manifest.url as string).hostname], input.secrets);
      }
      const discovered = await listMcpTools(connection);
      if (authorization) {
        // Binding a capability to the Agent definition is the default
        // authorization boundary. Keep explicit task grants as additional
        // evidence, but do not require a second per-tool approval for tools
        // that are already present in the bound, versioned capability.
        authorization = {
          grants: [...new Set([
            ...authorization.grants,
            ...discovered.map(tool => mcpGrant(bound.id, tool.name)),
          ])].sort(),
          ...(authorization.onPermissionRequired ? { onPermissionRequired: authorization.onPermissionRequired } : {}),
        };
      }
      tools.push(...capabilityTools(connection, discovered, bound, authorization));
      // "Loaded" is discovery; "executable" reflects the effective grants
      // assembled for this operation.
      let executable = true;
      let grantReason: string | null = null;
      if (authorization && discovered.length) {
        const granted = discovered.filter(tool => authorization.grants.includes(mcpGrant(bound.id, tool.name)));
        executable = granted.length > 0;
        if (!granted.length) grantReason = `已加载 ${discovered.length} 个工具，当前无任务授权（例如 ${mcpGrant(bound.id, discovered[0]!.name)}），调用会被权限门拒绝`;
        else if (granted.length < discovered.length) grantReason = `已加载 ${discovered.length} 个工具，其中 ${granted.length} 个获授权，其余调用会被权限门拒绝`;
      } else if (authorization && !discovered.length) {
        executable = false;
        grantReason = '能力已连接但没有可调用工具';
      }
      report.push({
        id: bound.id, version: bound.version, kind: record.kind, loaded: true, executable,
        reason: grantReason ?? loadedReason,
        ...(discovered.length ? { tools: discovered.map(tool => mcpToolName(bound.id, tool.name)) } : {}),
        ...(networkDomains.length ? { networkDomains } : {}),
        ...(networkAccess ? { networkAccess } : {}),
        ...(provisioning ? {
          provisioning: {
            manager: provisioning.manager,
            domains: provisioning.domains,
            path: provisioning.root,
          },
        } : {}),
      });
    }
  } catch (error) {
    await close();
    throw error;
  }
  if (input.access?.network === 'unrestricted') {
    runtimeNetworkDomains.clear();
    runtimeUnrestrictedNetwork = true;
  }
  if (input.access?.piExtensions.localBinding) runtimeLocalBinding = true;
  return {
    skillPaths, piExtensionPaths, piExtensionTools, readRoots, writeRoots, env,
    networkDomains: [...runtimeNetworkDomains],
    allowUnrestrictedNetwork: runtimeUnrestrictedNetwork,
    allowLocalBinding: runtimeLocalBinding,
    unixSockets: [...runtimeUnixSockets],
    tools, prompts: { agent: agentPrompt, tool: toolPrompt }, digest: digest(), close, report,
  };
}

/** Build the identity and capability-awareness prompts from the exact loaded bundle.
 * The generated tool section is authoritative even when a tool.md capability is bound. */
export function capabilityPrompts(input: {
  definitionVersion: string;
  action: string;
  role?: string;
  agentPrompt: string | null;
  toolPrompt: string | null;
  report: CapabilityLoadFact[];
  tools: readonly ToolDefinition[];
}) {
  const systemPrompt = input.agentPrompt ?? [
    `You are the ${input.action} Agent in Graph${input.role ? ` (${input.role})` : ''}.`,
    'Work only within the confirmed task and the capabilities listed in tool.md.',
    'Use tools for evidence. Do not claim a tool result that did not happen.',
  ].join('\n');
  const byKind = (kind: string) => input.report.filter(item => item.kind === kind);
  const skillLines = byKind('skill').map(item => `- ${item.name ?? item.id} (${item.id}@${item.version})${item.path ? ` at ${item.path}` : ''}${item.description ? `: ${item.description}` : item.reason ? `: ${item.reason}` : ''}`);
  const piExtensionLines = byKind('pi-extension').map(item => `- ${item.id}@${item.version}${item.tools?.length ? `: ${item.tools.join(', ')}` : ''}${item.reason ? ` (${item.reason})` : ''}`);
  const bridgeLines = [...byKind('mcp'), ...byKind('extension')].map(item => {
    const network = item.networkAccess === 'unrestricted'
      ? 'network: unrestricted'
      : item.networkDomains?.length
        ? `network: ${item.networkDomains.join(', ')}`
        : 'network: none';
    return `- ${item.id}@${item.version} [${network}]${item.tools?.length ? `: ${item.tools.join(', ')}` : ''}`;
  });
  const toolLines = input.tools.map(tool => `- ${tool.name}: ${tool.description}`);
  const toolAwareness = [
    input.toolPrompt?.trim() ?? '',
    '# Capability awareness',
    `Definition: ${input.definitionVersion}`,
    'The following inventory is generated from the exact capability bundle loaded for this Agent process.',
    skillLines.length ? `\n## Skills\n${skillLines.join('\n')}` : '',
    piExtensionLines.length ? `\n## Pi extensions\n${piExtensionLines.join('\n')}` : '',
    bridgeLines.length ? `\n## Graph/MCP bridge capabilities\n${bridgeLines.join('\n')}` : '',
    toolLines.length ? `\n## Callable tools\n${toolLines.join('\n')}` : '',
    '\nUse only the callable tools listed above. Every model, command, MCP and extension call passes the Graph send gate; a blocked call is not retried by inventing another route.',
  ].filter(Boolean).join('\n');
  const digest = createHash('sha256').update(canonicalJson({
    definitionVersion: input.definitionVersion,
    action: input.action,
    role: input.role ?? null,
    systemPrompt,
    appendSystemPrompt: toolAwareness,
    report: input.report.map(stableFact) as unknown as Json,
    tools: input.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters as unknown as Json })),
  })).digest('hex');
  return { systemPrompt, appendSystemPrompt: toolAwareness, digest };
}
