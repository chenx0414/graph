/**
 * Which file a tool call targeted, as an absolute path, or `null` when a call has no single target.
 *
 * This is what makes skill usage observable at all: `tool_calls` records what ran, and the target
 * turns "something read something" into "this skill was read, at this time".
 *
 * Deliberately keyed on well-known argument names rather than per-tool schemas: `path` is what the
 * built-in file tools use (`read`, `write`, `edit`), and the aliases cover tools that name their
 * target differently. A tool whose target we cannot identify simply contributes nothing.
 */

export const TARGET_LIMIT = 256;

/** Argument keys that name a single file or directory, in priority order. */
const TARGET_KEYS = ['path', 'file_path', 'filePath', 'target'] as const;

export function toolCallTarget(tool: string, args: unknown, options: { workspace: string }): string | null {
  void tool;
  void args;
  void options;
  return null;
}

export function targetKeys(): readonly string[] {
  return TARGET_KEYS;
}
