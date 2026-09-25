import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import { mcpAdapterServerDefinition, mcpAdapterServerName, type McpSecretValues } from './mcp-adapter-server.ts';

/**
 * pi-mcp-adapter registers runtime MCP servers through a shared event bus, so a
 * host extension can hand it the servers a Graph definition is bound to without
 * the adapter deep-importing Graph or writing any file.
 */
export const MCP_RUNTIME_REGISTER_EVENT = 'pi-mcp-adapter:runtime-register:v1';
const MCP_RUNTIME_REGISTER_VERSION = 1;

/** The adapter's own gateway tool, which is how runtime-registered servers reach the model. */
export const MCP_ADAPTER_PROXY_TOOL = 'mcp';

interface RuntimeRegistrationRequest {
  version: number;
  name: string;
  definition: unknown;
  result?: { ok: true; registration: { dispose(): Promise<void> } } | { ok: false; error: Error };
}

/**
 * Build the inline extension that registers every MCP server this operation is
 * bound to. Registered servers are proxy-tool-only, so the model reaches them
 * through the adapter's "mcp" gateway, which has to be allowed in the session.
 */
export function mcpAdapterBridge(servers: readonly { name: string; definition: unknown }[]): InlineExtension {
  return {
    name: 'graph-mcp-adapter',
    hidden: true,
    factory: pi => {
      const registrations: { dispose(): Promise<void> }[] = [];
      pi.on('session_start', () => {
        for (const server of servers) {
          const request: RuntimeRegistrationRequest = {
            version: MCP_RUNTIME_REGISTER_VERSION,
            name: server.name,
            definition: server.definition,
          };
          try { (pi as ExtensionAPI).events?.emit(MCP_RUNTIME_REGISTER_EVENT, request); }
          catch { continue; }
          const result = request.result;
          if (result?.ok) registrations.push(result.registration);
        }
      });
      pi.on('session_shutdown', async () => {
        for (const registration of registrations.splice(0)) await registration.dispose().catch(() => undefined);
      });
    },
  };
}

/**
 * The MCP servers this Agent definition binds, with ${VAR} values already resolved
 * from the operation's secrets. A capability whose declaration carries no transport
 * is skipped: it is reported by the library, not silently connected.
 */
export function mcpAdapterServers(facts: readonly {
  id: string;
  version: string;
  kind: string;
  path?: string;
  role?: 'agent' | 'tool';
}[], secrets: McpSecretValues = {}): { name: string; definition: unknown }[] {
  const servers: { name: string; definition: unknown }[] = [];
  for (const fact of facts) {
    // A bound capability carries no role; only prompt bindings are marked agent/tool.
    if (fact.kind !== 'mcp' || (fact.role && fact.role !== 'tool') || !fact.path || !fact.id.trim()) continue;
    const manifest = JSON.parse(readFileSync(join(fact.path, 'capability.json'), 'utf8')) as unknown;
    const declaration = manifest && typeof manifest === 'object' ? manifest as Record<string, unknown> : {};
    const definition = mcpAdapterServerDefinition({
      ...(declaration.command !== undefined ? { command: declaration.command } : {}),
      ...(declaration.args !== undefined ? { args: declaration.args } : {}),
      ...(declaration.url !== undefined ? { url: declaration.url } : {}),
      ...(declaration.headers !== undefined ? { headers: declaration.headers } : {}),
      ...(declaration.headersEnv !== undefined ? { headersEnv: declaration.headersEnv } : {}),
      ...(declaration.env !== undefined ? { env: declaration.env } : {}),
    }, secrets, fact.path);
    if (!definition) continue;
    servers.push({ name: mcpAdapterServerName(fact.id), definition });
  }
  return servers;
}
