import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { RuntimeError, type Json } from '../core/types.ts';
import type { RestrictedGate } from './restricted-process.ts';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Json;
}

export interface StdioEndpoint {
  executor: { run(command: {
    broker: RestrictedGate; cwd: string; scratchDir: string; executable: string; args: string[];
    input?: string; readPaths: string[]; writePaths: string[]; timeoutMs?: number;
    networkDomains?: string[];
    allowUnrestrictedNetwork?: boolean;
    keepStdinOpen?: boolean;
    onSpawn?: (process: { kill(signal?: NodeJS.Signals): boolean; end(): void }) => void;
    onStdout?: (chunk: string) => void;
  }): Promise<{ code: number | null; stdout: string; stderr: string }> };
  gate: RestrictedGate;
  cwd: string;
  scratchDir: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  readPaths: string[];
  writePaths: string[];
  timeoutMs?: number;
  networkDomains?: string[];
  allowUnrestrictedNetwork?: boolean;
}

export interface HttpEndpoint {
  gate: RestrictedGate;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** One JSON-RPC exchange; every transport runs it through the same send gate. */
export interface McpExchange {
  exchange(requests: Json[], expect: number): Promise<Reply>;
}

type Reply = { id?: unknown; result?: Json; error?: { message?: string } };

const HAND_SHAKE = (): Json[] => [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'graph', version: '0.0.0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
];
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function usageSettled<T>(gate: RestrictedGate, run: () => Promise<T>) {
  const invocationId = randomUUID();
  let failure: unknown;
  let value: T | undefined;
  return gate.dispatch(invocationId, 0, async () => {
    try { value = await run(); }
    catch (error) { failure = error; }
    finally { gate.settle(invocationId, ZERO); }
  }).then(() => {
    if (failure) throw failure;
    return value!;
  });
}

/**
 * One actual HTTP send. The pause and budget check runs in the same turn as the
 * send, so a pause between two requests of one logical exchange stops the next
 * request instead of letting the whole exchange through under its first check.
 */
async function gatedRequest<T>(gate: RestrictedGate, send: () => Promise<T>): Promise<T> {
  const invocationId = randomUUID();
  let sent = false;
  try {
    return await gate.dispatch(invocationId, 0, () => { sent = true; return send(); });
  } finally {
    if (sent) gate.settle(invocationId, ZERO);
  }
}

/** One OS-restricted process per exchange keeps every local server call inside the verified sandbox. */
export function stdioExchange(endpoint: StdioEndpoint): McpExchange {
  return {
    exchange(requests, expect) {
      return usageSettled(endpoint.gate, async () => {
        let pending = '';
        let streamedReply: Reply | undefined;
        let processControl: { kill(signal?: NodeJS.Signals): boolean; end(): void } | undefined;
        const result = await endpoint.executor.run({
          broker: endpoint.gate, cwd: endpoint.cwd, scratchDir: endpoint.scratchDir,
          executable: endpoint.command, args: endpoint.args,
          ...(endpoint.env ? { env: endpoint.env } : {}),
          readPaths: endpoint.readPaths, writePaths: endpoint.writePaths,
          timeoutMs: endpoint.timeoutMs ?? 30_000,
          ...(endpoint.networkDomains?.length ? { networkDomains: endpoint.networkDomains } : {}),
          ...(endpoint.allowUnrestrictedNetwork ? { allowUnrestrictedNetwork: true } : {}),
          keepStdinOpen: true,
          onSpawn: process => { processControl = process; },
          onStdout: (chunk) => {
            pending += chunk;
            let newline: number;
            while ((newline = pending.indexOf('\n')) !== -1) {
              const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
              if (!line.trim()) continue;
              try {
                const message = JSON.parse(line) as Reply;
                if (message.id === expect) {
                  streamedReply = message;
                  processControl?.end();
                }
              } catch { /* non-protocol output is ignored, never evaluated */ }
            }
          },
          input: `${requests.map(request => JSON.stringify(request)).join('\n')}\n`,
        });
        const replies = new Map<number, Reply>();
        for (const line of result.stdout.split('\n')) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as Reply;
            if (typeof message.id === 'number') replies.set(message.id, message);
          } catch { /* non-protocol output is ignored, never evaluated */ }
        }
        if (result.code !== 0 && replies.size === 0) {
          throw new RuntimeError('capability_failed', result.stderr.trim() || `MCP server exited with code ${result.code}`);
        }
        const reply = streamedReply ?? replies.get(expect);
        if (!reply) throw new RuntimeError('capability_failed', `MCP server did not answer request ${expect}`);
        return reply;
      });
    },
  };
}

function parseHttpBody(body: string, contentType: string): Reply[] {
  if (contentType.includes('text/event-stream')) {
    const replies: Reply[] = [];
    for (const line of body.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { replies.push(JSON.parse(data) as Reply); } catch { /* ignore non-protocol events */ }
    }
    return replies;
  }
  const parsed = JSON.parse(body) as Reply | Reply[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Remote MCP over Streamable HTTP. The runtime domain allowlist is checked
 * before this transport is created; redirects are refused so a permitted host
 * cannot forward the request to an unlisted one.
 */
export function httpExchange(endpoint: HttpEndpoint): McpExchange {
  return {
    exchange(requests, expect) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs ?? 30_000);
      return (async () => {
        try {
          const session: Record<string, string> = {};
          let reply: Reply | undefined;
          for (const request of requests) {
            const response = await gatedRequest(endpoint.gate, () => fetch(endpoint.url, {
              method: 'POST', redirect: 'error', signal: controller.signal,
              headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(endpoint.headers ?? {}), ...session },
              body: JSON.stringify(request),
            }));
            const sessionId = response.headers.get('mcp-session-id');
            if (sessionId) session['mcp-session-id'] = sessionId;
            if (response.status === 202 || response.status === 204) continue;
            if (!response.ok) throw new RuntimeError('capability_failed', `Remote MCP answered HTTP ${response.status}`);
            const body = await response.text();
            if (body.length > 2_000_000) throw new RuntimeError('capability_failed', 'Remote MCP response exceeded the size bound');
            if (!body.trim()) continue;
            for (const message of parseHttpBody(body, response.headers.get('content-type') ?? '')) {
              if (message.id === expect) reply = message;
            }
          }
          if (!reply) throw new RuntimeError('capability_failed', `Remote MCP did not answer request ${expect}`);
          if (reply.error) throw new RuntimeError('capability_failed', reply.error.message ?? 'Remote MCP error');
          if (reply.result === undefined) throw new RuntimeError('capability_failed', `Remote MCP returned no result for request ${expect}`);
          return reply;
        } finally { clearTimeout(timer); }
      })();
    },
  };
}

function requireResult(reply: Reply, expect: number) {
  if (reply.error) throw new RuntimeError('capability_failed', reply.error.message ?? 'MCP server error');
  if (reply.result === undefined) throw new RuntimeError('capability_failed', `MCP server returned no result for request ${expect}`);
  return reply;
}

export async function listMcpTools(connection: McpExchange): Promise<McpTool[]> {
  const reply = requireResult(await connection.exchange([...HAND_SHAKE(), { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }], 2), 2);
  const tools = (reply.result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) throw new RuntimeError('capability_failed', 'MCP server did not list tools');
  return tools.map((tool) => {
    const value = tool as { name?: unknown; description?: unknown; inputSchema?: Json };
    if (typeof value.name !== 'string' || !value.name.trim()) throw new RuntimeError('capability_failed', 'MCP tool is missing a name');
    return { name: value.name, ...(typeof value.description === 'string' ? { description: value.description } : {}), ...(value.inputSchema ? { inputSchema: value.inputSchema } : {}) };
  });
}

export async function callMcpTool(connection: McpExchange, name: string, args: Json): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> {
  const reply = requireResult(await connection.exchange([...HAND_SHAKE(), { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }], 2), 2);
  const result = reply.result as { content?: unknown; isError?: unknown };
  const content = Array.isArray(result.content)
    ? result.content.map((part) => {
        const value = part as { type?: unknown; text?: unknown };
        return { type: 'text' as const, text: typeof value.text === 'string' ? value.text : JSON.stringify(value) };
      })
    : [];
  return { content, isError: result.isError === true };
}

/** Resolve host environment references and relative paths in a manifest argument. */
export function resolveMcpArg(snapshot: string, value: string) {
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) {
      throw new RuntimeError('capability_unavailable', `MCP manifest requires environment variable ${name}`);
    }
    return resolved;
  });
  return expanded.startsWith('./') || expanded.startsWith('../') ? resolve(snapshot, expanded) : expanded;
}
