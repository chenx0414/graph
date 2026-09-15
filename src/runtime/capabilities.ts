import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Catalog } from '../catalog/catalog.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import { callMcpTool, httpExchange, listMcpTools, resolveMcpArg, stdioExchange, type McpExchange, type McpTool } from './mcp-client.ts';
import { allowedDomain, normalizeDomains } from './domains.ts';
import { externallyGated } from './pi-instance.ts';
import { acquireRestrictedExecutor, type RestrictedGate } from './restricted-process.ts';
import type { SendGate } from './controlled-openai.ts';

export interface CapabilityLoadFact { id: string; version: string; kind: string | null; loaded: boolean; executable: boolean; reason: string | null }

export interface LoadedCapabilities {
  skillPaths: string[];
  readRoots: string[];
  tools: ToolDefinition[];
  close(): Promise<void>;
  report: CapabilityLoadFact[];
}

interface McpManifest { command?: unknown; args?: unknown; entry?: unknown; url?: unknown; headers?: unknown; headersEnv?: unknown }

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

async function manifestOf(snapshot: string) {
  try { return JSON.parse(await readFile(join(snapshot, 'capability.json'), 'utf8')) as McpManifest; }
  catch (error) { throw new RuntimeError('capability_unavailable', `Capability manifest is unreadable: ${String(error)}`); }
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
  const domains = normalizeDomains(mcpDomains);
  if (!allowedDomain(domains, url.hostname)) {
    throw new RuntimeError('capability_unavailable', `Remote MCP host ${url.hostname} is not in the granted MCP domains`);
  }
  return httpExchange({ gate, url: url.href, headers: headerValues(manifest.headers, manifest.headersEnv), timeoutMs: 30_000 });
}

async function runGrants(workspace: string, scratchDir: string) {
  // The verified OS sandbox requires canonical, already-existing grants.
  const canonicalWorkspace = await realpath(workspace);
  await mkdir(scratchDir, { recursive: true, mode: 0o700 });
  return { workspace: canonicalWorkspace, scratchDir: await realpath(scratchDir) };
}

async function localConnection(input: {
  executor: Awaited<ReturnType<typeof acquireRestrictedExecutor>>['executor']; gate: SendGate;
  manifest: McpManifest; snapshot: string; workspace: string; scratchDir: string; readOnly?: boolean;
}): Promise<McpExchange> {
  const command = input.manifest.command === 'node' ? process.execPath : input.manifest.command;
  if (typeof command !== 'string' || !isAbsolute(command)) {
    throw new RuntimeError('capability_unavailable', 'A local MCP capability requires capability.json with an absolute command or "node"');
  }
  const args = Array.isArray(input.manifest.args) && input.manifest.args.every(value => typeof value === 'string') ? input.manifest.args as string[] : [];
  const grants = await runGrants(input.workspace, input.scratchDir);
  return stdioExchange({
    executor: input.executor, gate: input.gate, cwd: grants.workspace, scratchDir: grants.scratchDir,
    command, args: args.map(arg => resolveMcpArg(input.snapshot, arg)),
    readPaths: [input.snapshot, dirname(process.execPath)],
    // Discussion turns may read the business directory but only write scratch.
    writePaths: input.readOnly ? [grants.scratchDir] : [grants.workspace, grants.scratchDir],
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
    command: process.execPath, args: [extensionWorker, await realpath(entry)],
    readPaths: [input.snapshot, dirname(process.execPath), dirname(extensionWorker)],
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
      // A granted domain only allows reaching the service. Every remote tool
      // execution needs its own scoped task grant; tool names, descriptions and
      // MCP annotations are never treated as authorization.
      if (authorization) {
        const grant = mcpGrant(capability.id, tool.name);
        if (!authorization.grants.includes(grant)) {
          authorization.onPermissionRequired?.({ grant, capabilityId: capability.id, tool: tool.name, description: tool.description ?? '' });
          throw new Error(`Permission required: remote MCP tool ${tool.name} needs the task grant ${grant}`);
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
  mcpDomains?: string[];
  grants?: string[];
  /** Discussion turns investigate without writing the business directory. */
  readOnly?: boolean;
  onPermissionRequired?: (request: CapabilityPermissionRequest) => void;
}): Promise<LoadedCapabilities> {
  const skillPaths: string[] = [];
  const readRoots: string[] = [];
  const tools: ToolDefinition[] = [];
  const releases: (() => Promise<void>)[] = [];
  // Actual load facts: later projections must never guess these from catalog
  // status alone.
  const report: { id: string; version: string; kind: string | null; loaded: boolean; executable: boolean; reason: string | null }[] = [];
  const close = async () => { for (const release of releases.reverse()) await release(); releases.length = 0; };
  if (!input.definitionVersion) return { skillPaths, readRoots, tools, close, report };
  let definition;
  try { definition = input.catalog.definition(input.definitionVersion); }
  catch { return { skillPaths, readRoots, tools, close, report }; } // Unpublished definitions keep briefing-only behavior.
  try {
    for (const bound of definition.capabilities ?? []) {
      const record = input.catalog.capability(bound.id, bound.version);
      if (!record || record.status !== 'installed') {
        throw new RuntimeError('capability_unavailable', `Capability ${bound.id}@${bound.version} is not installed`);
      }
      const snapshot = snapshotPath(record);
      if (record.kind === 'skill') {
        if (!existsSync(join(snapshot, 'SKILL.md'))) throw new RuntimeError('capability_unavailable', `Skill ${bound.id}@${bound.version} has no SKILL.md`);
        skillPaths.push(snapshot);
        readRoots.push(snapshot);
        report.push({ id: bound.id, version: bound.version, kind: record.kind, loaded: true, executable: false, reason: '技能已加载为只读文档' });
        continue;
      }
      if (record.kind !== 'mcp' && record.kind !== 'extension') {
        throw new RuntimeError('capability_unsupported', `Capability kind ${record.kind} is not loadable`);
      }
      const manifest = await manifestOf(snapshot);
      let connection: McpExchange;
      let authorization: { grants: string[]; onPermissionRequired?: (request: CapabilityPermissionRequest) => void } | undefined;
      let loadedReason: string | null = null;
      if (record.kind === 'extension') {
        const acquired = await acquireRestrictedExecutor();
        releases.push(acquired.release);
        connection = await extensionConnection({ executor: acquired.executor, gate: input.gate, manifest, snapshot, workspace: input.workspace, scratchDir: input.scratchDir, ...(input.readOnly ? { readOnly: true } : {}) });
        loadedReason = input.readOnly ? '只读讨论模式：本地扩展在 scratch 只读范围加载' : null;
      } else if (typeof manifest.command === 'string') {
        const acquired = await acquireRestrictedExecutor();
        releases.push(acquired.release);
        connection = await localConnection({ executor: acquired.executor, gate: input.gate, manifest, snapshot, workspace: input.workspace, scratchDir: input.scratchDir, ...(input.readOnly ? { readOnly: true } : {}) });
        loadedReason = input.readOnly ? '只读讨论模式：本地能力在只读范围加载' : null;
      } else {
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
      report.push({ id: bound.id, version: bound.version, kind: record.kind, loaded: true, executable, reason: grantReason ?? loadedReason });
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { skillPaths, readRoots, tools, close, report };
}
