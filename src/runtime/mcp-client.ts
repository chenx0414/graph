import { resolve } from 'node:path';
import { RuntimeError, type Json } from '../core/types.ts';
import type { RestrictedGate } from './restricted-process.ts';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Json;
}

export interface McpEndpoint {
  executor: { run(command: {
    broker: RestrictedGate; cwd: string; scratchDir: string; executable: string; args: string[];
    input?: string; readPaths: string[]; writePaths: string[]; timeoutMs?: number;
  }): Promise<{ code: number | null; stdout: string; stderr: string }> };
  gate: RestrictedGate;
  cwd: string;
  scratchDir: string;
  command: string;
  args: string[];
  readPaths: string[];
  writePaths: string[];
  timeoutMs?: number;
}

type Reply = { result?: Json; error?: { message?: string } };

/** One process per MCP exchange keeps every server call inside the verified OS sandbox. */
async function exchange(endpoint: McpEndpoint, requests: Json[], expect: number): Promise<Reply> {
  const result = await endpoint.executor.run({
    broker: endpoint.gate, cwd: endpoint.cwd, scratchDir: endpoint.scratchDir,
    executable: endpoint.command, args: endpoint.args,
    readPaths: endpoint.readPaths, writePaths: endpoint.writePaths,
    timeoutMs: endpoint.timeoutMs ?? 30_000,
    input: `${requests.map(request => JSON.stringify(request)).join('\n')}\n`,
  });
  const replies = new Map<number, Reply>();
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line) as { id?: unknown } & Reply;
      if (typeof message.id === 'number') replies.set(message.id, message);
    } catch { /* non-protocol output is ignored, never evaluated */ }
  }
  if (result.code !== 0 && replies.size === 0) {
    throw new RuntimeError('capability_failed', result.stderr.trim() || `MCP server exited with code ${result.code}`);
  }
  const reply = replies.get(expect);
  if (!reply) throw new RuntimeError('capability_failed', `MCP server did not answer request ${expect}`);
  if (reply.error) throw new RuntimeError('capability_failed', reply.error.message ?? 'MCP server error');
  if (reply.result === undefined) throw new RuntimeError('capability_failed', `MCP server returned no result for request ${expect}`);
  return reply;
}

function handshake(): Json[] {
  return [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'graph', version: '0.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ];
}

export async function listMcpTools(endpoint: McpEndpoint): Promise<McpTool[]> {
  const reply = await exchange(endpoint, [...handshake(), { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }], 2);
  const tools = (reply.result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) throw new RuntimeError('capability_failed', 'MCP server did not list tools');
  return tools.map((tool) => {
    const value = tool as { name?: unknown; description?: unknown; inputSchema?: Json };
    if (typeof value.name !== 'string' || !value.name.trim()) throw new RuntimeError('capability_failed', 'MCP tool is missing a name');
    return { name: value.name, ...(typeof value.description === 'string' ? { description: value.description } : {}), ...(value.inputSchema ? { inputSchema: value.inputSchema } : {}) };
  });
}

export async function callMcpTool(endpoint: McpEndpoint, name: string, args: Json): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> {
  const reply = await exchange(endpoint, [...handshake(), { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }], 2);
  const result = reply.result as { content?: unknown; isError?: unknown };
  const content = Array.isArray(result.content)
    ? result.content.map((part) => {
        const value = part as { type?: unknown; text?: unknown };
        return { type: 'text' as const, text: typeof value.text === 'string' ? value.text : JSON.stringify(value) };
      })
    : [];
  return { content, isError: result.isError === true };
}

/** Resolve a manifest argument that points inside the installed snapshot. */
export function resolveMcpArg(snapshot: string, value: string) {
  return value.startsWith('./') || value.startsWith('../') ? resolve(snapshot, value) : value;
}
