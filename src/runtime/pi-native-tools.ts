import type { AgentToolPromptEntry } from './agent-system-prompt.ts';

export const PI_NATIVE_TOOL_NAMES = [
  'read',
  'bash',
  'edit',
  'write',
  'ls',
  'find',
  'grep',
  'powershell',
] as const;

export type PiNativeToolName = typeof PI_NATIVE_TOOL_NAMES[number];

const LEGACY_GRAPH_ALIASES: Partial<Record<PiNativeToolName, string>> = {
  read: 'read',
  bash: 'run_command',
  write: 'write_file',
  ls: 'list_dir',
};

export function graphToolsSupersededByNative(nativeTools: readonly string[]): Set<string> {
  const superseded = new Set(nativeTools);
  for (const [native, legacy] of Object.entries(LEGACY_GRAPH_ALIASES)) {
    if (nativeTools.includes(native) && legacy) superseded.add(legacy);
  }
  return superseded;
}

const NATIVE_TOOL_METADATA: readonly AgentToolPromptEntry[] = [
  {
    name: 'read',
    description: 'Read file contents, including supported images, with optional line offset and limit.',
    source: 'Pi',
    parameters: ['path', 'offset', 'limit'],
    permission: 'workspace and granted read roots',
    available: true,
  },
  {
    name: 'bash',
    description: 'Execute a bash command in the current working directory and return stdout and stderr.',
    source: 'Pi',
    parameters: ['command', 'timeout'],
    permission: 'sandboxed shell',
    available: true,
  },
  {
    name: 'edit',
    description: 'Make precise file edits with exact text replacement, including multiple disjoint edits in one call.',
    source: 'Pi',
    parameters: ['path', 'edits'],
    permission: 'workspace write',
    available: true,
  },
  {
    name: 'write',
    description: 'Create or overwrite a file, creating parent directories when needed.',
    source: 'Pi',
    parameters: ['path', 'content'],
    permission: 'workspace write',
    available: true,
  },
  {
    name: 'ls',
    description: 'List directory contents with directory suffixes and bounded output.',
    source: 'Pi',
    parameters: ['path', 'limit'],
    permission: 'workspace and granted read roots',
    available: true,
  },
  {
    name: 'find',
    description: 'Find files by glob pattern while respecting .gitignore.',
    source: 'Pi',
    parameters: ['pattern', 'path', 'limit'],
    permission: 'workspace and granted read roots',
    available: true,
  },
  {
    name: 'grep',
    description: 'Search file contents for a regex or literal pattern while respecting .gitignore.',
    source: 'Pi',
    parameters: ['pattern', 'path', 'glob', 'ignoreCase', 'literal', 'context', 'limit'],
    permission: 'workspace and granted read roots',
    available: true,
  },
  {
    name: 'powershell',
    description: 'Execute a PowerShell command in the current working directory and return stdout and stderr.',
    source: 'Pi',
    parameters: ['command', 'timeout'],
    permission: 'sandboxed shell',
    available: true,
  },
];

export function piNativeToolPromptEntries(): AgentToolPromptEntry[] {
  return NATIVE_TOOL_METADATA.map(tool => ({ ...tool, parameters: [...tool.parameters] }));
}
