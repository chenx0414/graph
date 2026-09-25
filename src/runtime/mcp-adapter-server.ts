import { join } from 'node:path';
import { RuntimeError } from '../core/types.ts';

/** Secret values a capability declaration may reference through ${VAR} or $VAR. */
export type McpSecretValues = Record<string, string>;

/** The server shape pi-mcp-adapter accepts in ServerEntry (command/args/env/cwd or url/headers). */
export interface McpAdapterServerDefinition {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  inheritEnv?: boolean;
  url?: string;
  headers?: Record<string, string>;
}

/** The MCP fields Graph capability manifests may declare. */
export interface McpAdapterServerDeclaration {
  command?: unknown;
  args?: unknown;
  url?: unknown;
  headers?: unknown;
  headersEnv?: unknown;
  env?: unknown;
}

/**
 * pi-mcp-adapter treats a leading "!" as "run this as a command", for env values
 * and for header values alike, and "!!" as the literal escape. Graph always
 * supplies resolved literals, so every leading bang has to be escaped.
 */
function literalValue(value: string): string {
  return value.startsWith('!') ? `!${value}` : value;
}

function stringMap(source: unknown, label: string): Record<string, string> | undefined {
  if (source === undefined) return undefined;
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.values(source).some(value => typeof value !== 'string')) {
    throw new RuntimeError('capability_unavailable', `${label} must be a string map`);
  }
  return source as Record<string, string>;
}

function stringList(source: unknown, label: string): string[] | undefined {
  if (source === undefined) return undefined;
  if (!Array.isArray(source) || source.some(value => typeof value !== 'string')) {
    throw new RuntimeError('capability_unavailable', `${label} must be a list of strings`);
  }
  return source as string[];
}

export function headerValues(headers: unknown, headersEnv: unknown, secrets: McpSecretValues = {}): Record<string, string> {
  const values: Record<string, string> = {};
  const merge = (source: unknown, resolveValue: (value: string) => string, label: string) => {
    const map = stringMap(source, label);
    if (!map) return;
    for (const [header, value] of Object.entries(map)) values[header] = literalValue(resolveValue(value));
  };
  merge(headers, value => value, 'MCP manifest headers');
  merge(headersEnv, name => {
    const value = secrets[name] ?? process.env[name];
    if (!value) throw new RuntimeError('capability_unavailable', `MCP manifest requires environment variable ${name}`);
    return value;
  }, 'MCP manifest headersEnv');
  return values;
}

export function environmentValues(env: unknown, secrets: McpSecretValues = {}): Record<string, string> | undefined {
  const map = stringMap(env, 'MCP manifest env');
  if (!map) return undefined;
  const values: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(map)) {
    const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(rawValue)?.[1]
      ?? (/^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(rawValue)?.[1]);
    if (reference) {
      const value = secrets[reference] ?? process.env[reference];
      if (value === undefined) throw new RuntimeError('capability_unavailable', `MCP manifest requires environment variable ${reference}`);
      values[name] = literalValue(value);
    } else {
      values[name] = literalValue(rawValue);
    }
  }
  return values;
}

/** The adapter requires a non-empty server name and accepts any string, so the capability id is used unchanged. */
export function mcpAdapterServerName(id: string): string {
  return id;
}

/**
 * Translate one capability declaration into the server definition pi-mcp-adapter
 * registers. Returns undefined when the declaration carries no transport, so a
 * half-configured capability is reported rather than silently connected.
 */
export function mcpAdapterServerDefinition(
  declaration: McpAdapterServerDeclaration,
  secrets: McpSecretValues = {},
  capabilityDir = '',
): McpAdapterServerDefinition | undefined {
  const url = typeof declaration.url === 'string' && declaration.url.trim() ? declaration.url.trim() : undefined;
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new RuntimeError('capability_unavailable', `Remote MCP url is invalid: ${url}`); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new RuntimeError('capability_unavailable', `Remote MCP supports http and https, not ${parsed.protocol}`);
    }
    if (parsed.username || parsed.password) throw new RuntimeError('capability_unavailable', 'Remote MCP urls cannot embed credentials');
    const headers = headerValues(declaration.headers, declaration.headersEnv, secrets);
    return { url, ...(Object.keys(headers).length ? { headers } : {}) };
  }
  const command = typeof declaration.command === 'string' && declaration.command.trim() ? declaration.command.trim() : undefined;
  if (!command) return undefined;
  const args = stringList(declaration.args, 'MCP manifest args');
  const resolvedArgs = args?.map(value => declaredArg(capabilityDir, value, secrets));
  const env = environmentValues(declaration.env, secrets);
  // inheritEnv: false keeps the MCP child on declared values only, matching the
  // environment Graph used to build for the server instead of the whole host env.
  return {
    command,
    ...(resolvedArgs ? { args: resolvedArgs } : {}),
    ...(env ? { env } : {}),
    inheritEnv: false,
  };
}

/**
 * One declared argument, resolved the way the host broker resolves it: a
 * capability-relative path stays relative to the capability, never to whatever
 * cwd the adapter happens to run the command from.
 */
function declaredArg(capabilityDir: string, value: string, secrets: McpSecretValues): string {
  const relative = value.startsWith('./') || value.startsWith('../');
  if (relative && !capabilityDir) {
    throw new RuntimeError('capability_unavailable', 'MCP manifest declares a capability directory-relative arg but the capability directory is unknown');
  }
  try {
    return resolveManifestArg(capabilityDir, value, secrets);
  } catch (error) {
    throw new RuntimeError('capability_unavailable', error instanceof Error ? error.message : String(error));
  }
}

/** Resolve one manifest argument: ${VAR} and $VAR from secrets/process env, else a snapshot-relative path. */
export function resolveManifestArg(snapshot: string, value: string, env: Record<string, string> = {}): string {
  const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1]
    ?? (/^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value)?.[1]);
  if (reference) {
    const resolved = env[reference] ?? process.env[reference];
    if (resolved === undefined) throw new Error(`Environment variable ${reference} is not set`);
    return resolved;
  }
  return value.startsWith('./') || value.startsWith('../') ? join(snapshot, value) : value;
}
