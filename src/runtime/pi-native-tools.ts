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

export function piNativeToolNamesForPlatform(
  platform: NodeJS.Platform | string = process.platform,
): PiNativeToolName[] {
  return PI_NATIVE_TOOL_NAMES.filter(name => name !== 'powershell' || platform === 'win32');
}

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
    description: 'Read file contents',
    source: 'Pi',
    group: 'pi_native',
    order: 0,
    parameters: ['path', 'offset', 'limit'],
    permission: 'workspace and granted read roots',
    available: true,
  },
  {
    name: 'bash',
    description: 'Execute bash commands (ls, grep, find, etc.)',
    source: 'Pi',
    group: 'pi_native',
    order: 1,
    parameters: ['command', 'timeout'],
    permission: 'sandboxed shell',
    available: true,
  },
  {
    name: 'edit',
    description: 'Make precise file edits with exact text replacement, including multiple disjoint edits in one call.',
    source: 'Pi',
    group: 'pi_native',
    order: 2,
    parameters: ['path', 'edits'],
    permission: 'workspace write',
    available: true,
  },
  {
    name: 'write',
    description: 'Create or overwrite files',
    source: 'Pi',
    group: 'pi_native',
    order: 3,
    parameters: ['path', 'content'],
    permission: 'workspace write',
    available: true,
  },
  {
    name: 'ls',
    description: 'List directory contents',
    source: 'Pi',
    group: 'pi_native',
    order: 4,
    parameters: ['path', 'limit'],
    permission: 'workspace and granted read roots',
    available: true,
  },
  {
    name: 'find',
    description: 'Find files by pattern',
    source: 'Pi',
    group: 'pi_native',
    order: 5,
    parameters: ['pattern', 'path', 'limit'],
    permission: 'workspace and granted read roots',
    available: true,
  },
  {
    name: 'grep',
    description: 'Search file contents',
    source: 'Pi',
    group: 'pi_native',
    order: 6,
    parameters: ['pattern', 'path', 'glob', 'ignoreCase', 'literal', 'context', 'limit'],
    permission: 'workspace and granted read roots',
    available: true,
  },
  {
    name: 'powershell',
    description: 'Execute PowerShell commands',
    source: 'Pi',
    group: 'pi_native',
    order: 7,
    parameters: ['command', 'timeout'],
    permission: 'sandboxed shell',
    available: true,
  },
];

export function piNativeToolPromptEntries(
  enabledNames: readonly string[] = piNativeToolNamesForPlatform(),
): AgentToolPromptEntry[] {
  const enabled = new Set(enabledNames);
  return NATIVE_TOOL_METADATA
    .filter(tool => enabled.has(tool.name))
    .map(tool => ({ ...tool, parameters: [...tool.parameters] }));
}
