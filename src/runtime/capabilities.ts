import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CapabilityBinding, Catalog } from '../catalog/catalog.ts';
import { normalizeDomainPattern } from '../core/domains.ts';
import { canonicalJson } from '../core/store.ts';
import { RuntimeError, type Json } from '../core/types.ts';
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
}

export interface LoadedCapabilities {
  skillPaths: string[];
  piExtensionPaths: string[];
  piExtensionTools: string[];
  readRoots: string[];
  tools: ToolDefinition[];
  prompts: { agent: string | null; tool: string | null };
  digest: string;
  close(): Promise<void>;
  report: CapabilityLoadFact[];
}

interface McpManifest {
  command?: unknown;
  args?: unknown;
  entry?: unknown;
  url?: unknown;
  headers?: unknown;
  headersEnv?: unknown;
  env?: unknown;
  tools?: unknown;
  networkDomains?: unknown;
  networkAccess?: unknown;
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

function headerValues(headers: unknown, headersEnv: unknown) {
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
    const value = process.env[name];
    if (!value) throw new RuntimeError('capability_unavailable', `MCP manifest requires environment variable ${name}`);
    return value;
  }, 'MCP manifest headersEnv');
  return values;
}

function environmentValues(env: unknown) {
  if (env === undefined) return undefined;
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(value => typeof value !== 'string')) {
    throw new RuntimeError('capability_unavailable', 'MCP manifest env must be a string map');
  }
  const values: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(env as Record<string, string>)) {
    const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(rawValue)?.[1]
      ?? (/^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(rawValue)?.[1]);
    if (reference) {
      const value = process.env[reference];
      if (value === undefined) throw new RuntimeError('capability_unavailable', `MCP manifest requires environment variable ${reference}`);
      values[name] = value;
    } else {
      values[name] = rawValue;
    }
  }
  return values;
}

/** Resolve capability-declared host patterns; base URLs are reduced to their hostname. */
function manifestNetworkDomains(manifest: McpManifest, granted: string[] = []) {
  const declared = manifest.networkDomains;
  if (declared === undefined) return normalizeDomains(granted);
  if (!Array.isArray(declared) || declared.some(value => typeof value !== 'string' || !value.trim())) {
    throw new RuntimeError('capability_unavailable', 'MCP networkDomains must be an array of nonempty strings');
  }
  const resolved: string[] = [];
  for (const value of declared as string[]) {
    const expanded = value.trim().replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced: string | undefined, plain: string | undefined) => {
      const name = braced ?? plain!;
      const replacement = process.env[name];
      if (!replacement) throw new RuntimeError('capability_unavailable', `MCP manifest requires environment variable ${name}`);
      return replacement;
    });
    if (expanded.includes('$')) throw new RuntimeError('capability_unavailable', `MCP networkDomains contains an invalid environment reference: ${value}`);
    let host = expanded;
    try {
      const url = new URL(expanded);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported protocol');
      if (url.username || url.password) throw new Error('embedded credentials');
      host = url.hostname;
    } catch (error) {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(expanded)) {
        throw new RuntimeError('capability_unavailable', `MCP network domain URL is invalid: ${value}`);
      }
    }
    try { resolved.push(normalizeDomainPattern(host)); }
    catch { throw new RuntimeError('capability_unavailable', `MCP networkDomains contains an invalid host: ${host}`); }
  }
  return normalizeDomains([...granted, ...resolved]);
}

/** A granted remote MCP endpoint; the runtime allowlist is checked before any request. */
function remoteConnection(manifest: McpManifest, gate: SendGate, mcpDomains: string[]): McpExchange {
  if (typeof manifest.url !== 'string' || !manifest.url.trim()) {
    throw new RuntimeError('capability_unavailable', 'An MCP capability requires capability.json with an absolute command or a remote url');
  }
  let url: URL;
  try { url = new URL(manifest.url); }
  catch { throw new RuntimeError('capability_unavailable', `Remote MCP url is invalid: ${manifest.url}`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new RuntimeError('capability_unavailable', `Remote MCP supports http and https, not ${url.protocol}`);
  if (url.username || url.password) throw new RuntimeError('capability_unavailable', 'Remote MCP urls cannot embed credentials');
  const domains = manifestNetworkDomains(manifest, [...mcpDomains, url.hostname]);
  if (!allowedDomain(domains, url.hostname)) {
    throw new RuntimeError('capability_unavailable', `Remote MCP host ${url.hostname} is not in the granted MCP domains`);
  }
  return httpExchange({ gate, url: url.href, headers: headerValues(manifest.headers, manifest.headersEnv), timeoutMs: 30_000 });
}

/** Read paths a sandboxed helper needs to start the Node runtime itself.
 * Inside a packaged Electron app `process.execPath` is the bundle binary, and
 * loading it needs the sibling `Frameworks` directory, not just `MacOS`. */
export function nodeReadPaths(execPath = process.execPath, electron = process.versions.electron as string | undefined): string[] {
  const macos = dirname(execPath);
  return electron ? [macos, dirname(macos)] : [macos];
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
  };
}

async function localConnection(input: {
  executor: Awaited<ReturnType<typeof acquireRestrictedExecutor>>['executor']; gate: SendGate;
  manifest: McpManifest; snapshot: string; workspace: string; scratchDir: string; readOnly?: boolean;
  networkDomains?: string[];
  allowUnrestrictedNetwork?: boolean;
}): Promise<McpExchange> {
  // Helper processes use the bundled node binary when the app is packaged.
  const nodeCommand = graphNodeRuntime().execPath;
  const command = input.manifest.command === 'node' ? nodeCommand : input.manifest.command;
  if (typeof command !== 'string' || !isAbsolute(command)) {
    throw new RuntimeError('capability_unavailable', 'A local MCP capability requires capability.json with an absolute command or "node"');
  }
  const args = Array.isArray(input.manifest.args) && input.manifest.args.every(value => typeof value === 'string') ? input.manifest.args as string[] : [];
  const grants = await runGrants(input.workspace, input.scratchDir);
  const env = environmentValues(input.manifest.env);
  return stdioExchange({
    executor: input.executor, gate: input.gate, cwd: grants.workspace, scratchDir: grants.scratchDir,
    command, args: args.map(arg => resolveMcpArg(input.snapshot, arg)),
    ...(env ? { env } : {}),
    readPaths: [input.snapshot, ...nodeReadPaths(nodeCommand, process.env.GRAPH_APP_NODE ? undefined : process.versions.electron as string | undefined)],
    // Discussion turns may read the business directory but only write scratch.
    writePaths: input.readOnly ? [grants.scratchDir] : [grants.workspace, grants.scratchDir],
    ...(input.networkDomains?.length ? { networkDomains: input.networkDomains } : {}),
    ...(input.allowUnrestrictedNetwork ? { allowUnrestrictedNetwork: true } : {}),
  });
}

/** Extensions load only inside the restricted worker, never in the background process. */
async function extensionConnection(input: {
  executor: Awaited<ReturnType<typeof acquireRestrictedExecutor>>['executor']; gate: SendGate;
  manifest: McpManifest; snapshot: string; workspace: string; scratchDir: string; readOnly?: boolean;
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
      // A granted domain only allows reaching the service. Every network tool
      // execution needs its own scoped task grant; tool names, descriptions and
      // MCP annotations are never treated as authorization.
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
  onPermissionRequired?: (request: CapabilityPermissionRequest) => void;
}): Promise<LoadedCapabilities> {
  const skillPaths: string[] = [];
  const piExtensionPaths: string[] = [];
  const piExtensionTools: string[] = [];
  const readRoots: string[] = [];
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
    prompts: { agent: agentPrompt, tool: toolPrompt },
    tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters as unknown as Json })),
  })).digest('hex');
  if (!input.definitionVersion) return { skillPaths, piExtensionPaths, piExtensionTools, readRoots, tools, prompts: { agent: agentPrompt, tool: toolPrompt }, digest: digest(), close, report };
  let definition;
  try { definition = input.catalog.definition(input.definitionVersion); }
  catch { return { skillPaths, piExtensionPaths, piExtensionTools, readRoots, tools, prompts: { agent: agentPrompt, tool: toolPrompt }, digest: digest(), close, report }; } // Unpublished definitions keep briefing-only behavior.
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
      if (!record || !['available', 'installed'].includes(record.status)) {
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
        report.push({
          id: bound.id, version: bound.version, kind: record.kind, loaded: true, executable: true,
          reason: `独立 Pi 进程内加载；声明工具 ${declared.length} 个`,
          path: entry,
          ...(declared.length ? { tools: declared.map(tool => tool.name) } : {}),
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
      if (record.kind === 'extension') {
        const acquired = await acquireRestrictedExecutor();
        releases.push(acquired.release);
        connection = await extensionConnection({ executor: acquired.executor, gate: input.gate, manifest, snapshot, workspace: input.workspace, scratchDir: input.scratchDir, ...(input.readOnly ? { readOnly: true } : {}) });
        loadedReason = input.readOnly ? '只读讨论模式：本地扩展在 scratch 只读范围加载' : null;
      } else if (typeof manifest.command === 'string') {
        if (manifest.networkAccess !== undefined && manifest.networkAccess !== 'unrestricted') {
          throw new RuntimeError('capability_unavailable', 'MCP networkAccess must be "unrestricted"');
        }
        networkAccess = manifest.networkAccess === 'unrestricted' ? 'unrestricted' : undefined;
        if (networkAccess && manifest.networkDomains !== undefined) {
          throw new RuntimeError('capability_unavailable', 'MCP cannot combine networkDomains with unrestricted network access');
        }
        networkDomains = networkAccess ? [] : manifestNetworkDomains(manifest, input.mcpDomains ?? []);
        if (networkDomains.length || networkAccess) {
          authorization = {
            grants: input.grants ?? [],
            ...(input.onPermissionRequired ? { onPermissionRequired: input.onPermissionRequired } : {}),
          };
        }
        const acquired = await acquireRestrictedExecutor();
        releases.push(acquired.release);
        connection = await localConnection({
          executor: acquired.executor, gate: input.gate, manifest, snapshot, workspace: input.workspace, scratchDir: input.scratchDir,
          ...(input.readOnly ? { readOnly: true } : {}),
          ...(networkDomains.length ? { networkDomains } : {}),
          ...(networkAccess ? { allowUnrestrictedNetwork: true } : {}),
        });
        loadedReason = input.readOnly ? '只读讨论模式：本地能力在只读范围加载' : null;
      } else {
        if (manifest.networkAccess !== undefined) {
          throw new RuntimeError('capability_unavailable', 'MCP networkAccess is only valid for local MCP commands');
        }
        // HTTP is only a transport: a remote service can operate on business
        // resources and its self-reported annotations are not authorization.
        // Discussion therefore uses only host-recognized read paths (built-in
        // reads, capability snapshots, local capability reads with a read-only
        // business directory, and controlled retrieval); remote tools load at
        // execution time and remain grant-gated per call.
        if (input.readOnly) {
          report.push({ id: bound.id, version: bound.version, kind: record.kind, loaded: false, executable: false, reason: '只读讨论模式不加载远程能力' });
          continue;
        }
        const grants = input.grants ?? [];
        authorization = { grants, ...(input.onPermissionRequired ? { onPermissionRequired: input.onPermissionRequired } : {}) };
        connection = remoteConnection(manifest, input.gate, input.mcpDomains ?? []);
        networkDomains = manifestNetworkDomains(manifest, [...(input.mcpDomains ?? []), new URL(manifest.url as string).hostname]);
      }
      const discovered = await listMcpTools(connection);
      tools.push(...capabilityTools(connection, discovered, bound, authorization));
      // "Loaded" is discovery; "executable" needs the actual task grants.
      // Reporting true without them would contradict the permission gate.
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
      });
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { skillPaths, piExtensionPaths, piExtensionTools, readRoots, tools, prompts: { agent: agentPrompt, tool: toolPrompt }, digest: digest(), close, report };
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
