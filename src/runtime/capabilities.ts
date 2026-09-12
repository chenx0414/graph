import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Catalog } from '../catalog/catalog.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import { readBounded } from './bounded-path.ts';
import { callMcpTool, listMcpTools, resolveMcpArg, type McpEndpoint } from './mcp-client.ts';
import { externallyGated } from './pi-instance.ts';
import { acquireRestrictedExecutor, openRestrictedExecutor } from './restricted-process.ts';
import type { SendGate } from './controlled-openai.ts';

export interface LoadedCapabilities {
  skillPaths: string[];
  readRoots: string[];
  tools: ToolDefinition[];
  close(): Promise<void>;
}

interface McpManifest { command?: unknown; args?: unknown }

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

async function mcpEndpoint(input: {
  executor: Awaited<ReturnType<typeof openRestrictedExecutor>>; gate: SendGate;
  snapshot: string; workspace: string; scratchDir: string;
}): Promise<McpEndpoint> {
  const manifest = JSON.parse(await readFile(join(input.snapshot, 'capability.json'), 'utf8')) as McpManifest;
  if (typeof manifest.command !== 'string' || !isAbsolute(manifest.command)) {
    throw new RuntimeError('capability_unavailable', 'An MCP capability requires capability.json with an absolute command');
  }
  const args = Array.isArray(manifest.args) && manifest.args.every(value => typeof value === 'string') ? manifest.args as string[] : [];
  // The verified OS sandbox requires canonical, already-existing grants.
  const workspace = await realpath(input.workspace);
  await mkdir(input.scratchDir, { recursive: true, mode: 0o700 });
  const scratchDir = await realpath(input.scratchDir);
  return {
    executor: input.executor, gate: input.gate, cwd: workspace, scratchDir,
    command: manifest.command, args: args.map(arg => resolveMcpArg(input.snapshot, arg)),
    readPaths: [input.snapshot, dirname(process.execPath)],
    writePaths: [workspace, scratchDir],
  };
}

/**
 * Load the capabilities bound by an Agent definition version.
 *
 * Skills become Pi resources and a read-only tool; MCP tools become callable
 * tools whose every call runs one restricted server process through the same
 * send gate as model calls. Extensions are refused here: the architecture does
 * not load third-party extension code in the formal background process.
 */
export async function loadCapabilities(input: {
  catalog: Catalog;
  definitionVersion?: string;
  workspace: string;
  scratchDir: string;
  gate: SendGate;
}): Promise<LoadedCapabilities> {
  const skillPaths: string[] = [];
  const readRoots: string[] = [];
  const tools: ToolDefinition[] = [];
  const releases: (() => Promise<void>)[] = [];
  const close = async () => { for (const release of releases.reverse()) await release(); releases.length = 0; };
  if (!input.definitionVersion) return { skillPaths, readRoots, tools, close };
  let definition;
  try { definition = input.catalog.definition(input.definitionVersion); }
  catch { return { skillPaths, readRoots, tools, close }; } // Unpublished definitions keep briefing-only behavior.
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
      } else if (record.kind === 'mcp') {
        const acquired = await acquireRestrictedExecutor();
        releases.push(acquired.release);
        const endpoint = await mcpEndpoint({ executor: acquired.executor, gate: input.gate, snapshot, workspace: input.workspace, scratchDir: input.scratchDir });
        for (const tool of await listMcpTools(endpoint)) {
          tools.push(externallyGated({
            name: mcpToolName(bound.id, tool.name), label: `${tool.name} (${bound.id})`,
            description: tool.description ?? `MCP tool ${tool.name} from ${bound.id}@${bound.version}`,
            parameters: Type.Unsafe(tool.inputSchema ?? { type: 'object', properties: {} }),
            execute: async (_id, params) => {
              const result = await callMcpTool(endpoint, tool.name, params as Json);
              const content = result.content.length ? result.content : [{ type: 'text' as const, text: 'MCP tool returned no content' }];
              if (result.isError) throw new Error(content.map(part => part.text).join('\n'));
              return { content, details: {} };
            },
          }));
        }
      } else {
        throw new RuntimeError('capability_unsupported', `Extension ${bound.id}@${bound.version} requires the restricted worker and is not loaded in the background process`);
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { skillPaths, readRoots, tools, close };
}
