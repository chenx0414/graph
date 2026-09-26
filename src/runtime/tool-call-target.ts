/**
 * Which file a tool call targeted, as an absolute path, or `null` when a call has no single target.
 *
 * This is what makes skill usage observable at all: `tool_calls` records what ran, and the target
 * turns "something read something" into "this skill was read, at this time".
 *
 * Deliberately keyed on well-known argument names rather than per-tool schemas: `path` is what the
 * built-in file tools use (`read`, `write`, `edit`) and the aliases cover tools that name their
 * target differently. A tool whose target we cannot identify simply contributes nothing.
 */
import { isAbsolute, resolve } from 'node:path';

export const TARGET_LIMIT = 256;

/** Argument keys that name a single file or directory, in priority order. */
const TARGET_KEYS = ['path', 'file_path', 'filePath', 'target'] as const;

/** Resolved against the instance's workspace so derivation is a plain prefix match later on. */
export function toolCallTarget(_tool: string, args: unknown, options: { workspace: string }): string | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const raw = value.trim();
    const path = isAbsolute(raw) ? raw : resolve(options.workspace, raw);
    return path.length > TARGET_LIMIT ? path.slice(0, TARGET_LIMIT) : path;
  }
  return null;
}
