import { join } from 'node:path';
import { RuntimeError } from '../core/types.ts';

/** Secret values a capability declaration may reference through ${VAR} or $VAR. */
export type McpSecretValues = Record<string, string>;

/**
 * A leading "!" means "run this as a command", for env values and for header
 * values alike, and "!!" is the literal escape. Graph always supplies resolved
 * literals, so every leading bang has to be escaped.
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
