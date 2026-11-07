






import type { CapabilityRecord } from './catalog-view-types.ts';

import type { AgentCombinationView } from './catalog-view-types.ts';

import './setup.ts';

import './resource-library.css';

export interface ResourceSettings {
  capabilities: CapabilityRecord[];
  agentCombinations?: AgentCombinationView[];
  capabilityConfig?: CapabilityConfigItem[];
  capabilityRoot?: string | null;
  agentCombinationFile?: string | null;
  agentCombinationError?: string | null;
}

export type CapabilityConfigField = {
  env: string;
  label: string;
  secret: boolean;
  reason: string;
};

export type CapabilityConfigItem = {
  id: string;
  version: string;
  name: string;
  kind: string;
  source: string;
  fields: CapabilityConfigField[];
  configured: string[];
  missing: string[];
  ready: boolean;
  error?: string;
};

export type CapabilitySort = 'alphabetical' | 'enabled' | 'popular';

export type LibraryEntryFilter = 'all' | 'configured' | 'unconfigured';

export interface LibraryEntryCounts {
  all: number;
  configured: number;
  unconfigured: number;
}

export interface LibraryEntrySplit<T> {
  configured: T[];
  unconfigured: T[];
  counts: LibraryEntryCounts;
  visible: T[];
}

export const LIBRARY_FILTERS: readonly { id: LibraryEntryFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'configured', label: '已配置' },
  { id: 'unconfigured', label: '未配置' },
];

export function splitLibraryEntries<T>(
  entries: readonly T[],
  filter: LibraryEntryFilter,
  isConfigured: (entry: T) => boolean,
): LibraryEntrySplit<T> {
  const configured: T[] = [];
  const unconfigured: T[] = [];
  for (const entry of entries) (isConfigured(entry) ? configured : unconfigured).push(entry);
  const visible = filter === 'configured' ? [...configured]
    : filter === 'unconfigured' ? [...unconfigured]
      : [...configured, ...unconfigured];
  return {
    configured,
    unconfigured,
    counts: { all: configured.length + unconfigured.length, configured: configured.length, unconfigured: unconfigured.length },
    visible,
  };
}

export function capabilityIsConfigured(item: CapabilityRecord, config?: CapabilityConfigItem): boolean {
  if (item.status !== 'available') return false;
  return config ? config.ready : true;
}

export function configGuidance(input: { missing?: string[] | undefined; error?: string | undefined }): string {
  if (input.error) return `配置读取失败：${input.error} 请在能力目录修复后重新扫描。`;
  if (input.missing?.length) return `需要配置 ${input.missing.join(' / ')}：设置对应环境变量，或到设置页保存凭据；保存后立即对新请求生效。`;
  return '需要配置：到设置页连接模型或保存对应凭据；保存后立即生效。';
}

export function capabilityConfigGuidance(item: CapabilityRecord, config?: CapabilityConfigItem): string {
  if (item.status !== 'available') {
    return item.error
      ? `清单不可读：${item.error} 请在能力目录修复 capability.json 后重新扫描。`
      : '清单不可读：请在能力目录补齐 capability.json 后重新扫描。';
  }
  return configGuidance(config ?? {});
}

export function capabilityConfigItemIsConfigured(item: CapabilityConfigItem): boolean {
  return item.ready && !item.error;
}

export function capabilityConfigItemGuidance(item: CapabilityConfigItem): string {
  return configGuidance(item);
}

export const CAPABILITY_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function capabilityUsage(combinations: AgentCombinationView[]) {
  const usage = new Map<string, number>();
  for (const combination of combinations) {
    const seen = new Set<string>();
    for (const resource of combination.resources) {
      if (seen.has(resource.resourceId)) continue;
      seen.add(resource.resourceId);
      usage.set(resource.resourceId, (usage.get(resource.resourceId) ?? 0) + 1);
    }
  }
  return usage;
}

export function capabilityMatches(item: CapabilityRecord, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [item.id, item.name, item.description, item.source, item.kind, item.role]
    .filter(Boolean).join('\n').toLowerCase();
  return terms.every(term => haystack.includes(term));
}

export function orderedCapabilities(input: {
  items: CapabilityRecord[];
  selected: Set<string>;
  query: string;
  sort: CapabilitySort;
  usage: Map<string, number>;
}) {
  const compareNames = (left: CapabilityRecord, right: CapabilityRecord) =>
    CAPABILITY_COLLATOR.compare(left.name ?? left.id, right.name ?? right.id) || CAPABILITY_COLLATOR.compare(left.id, right.id);
  return input.items.filter(item => capabilityMatches(item, input.query)).sort((left, right) => {
    if (input.sort === 'enabled') {
      const leftEnabled = input.selected.has(`${left.id}@${left.version}`);
      const rightEnabled = input.selected.has(`${right.id}@${right.version}`);
      if (leftEnabled !== rightEnabled) return leftEnabled ? -1 : 1;
    }
    if (input.sort === 'popular') {
      const difference = (input.usage.get(right.id) ?? 0) - (input.usage.get(left.id) ?? 0);
      if (difference) return difference;
    }
    return compareNames(left, right);
  });
}

export const MAIN_AGENT_SYSTEM_CAPABILITIES = [
  '任务规划',
  'Graph 设计',
  '组装并调用 Subagents',
  '按订阅选择模型',
  '监控 Graph 全程',
  '处理执行问题',
  '面向用户汇报',
];

export function capabilityKindLabel(item: CapabilityRecord) {
  if (item.kind === 'prompt') return item.role === 'tool' ? 'Tool.md' : 'Agent.md';
  if (item.kind === 'pi-extension') return 'Pi extension';
  if (item.kind === 'extension') return 'Graph extension';
  return item.kind === 'mcp' ? 'MCP' : 'Skill';
}

export function capabilityGroups(item: AgentCombinationView) {
  const groups = [
    { id: 'agent-md', label: 'Agent.md', resources: item.resolved.filter(resource => resource.role === 'identity' || resource.role === 'tool') },
    { id: 'skills', label: 'Skills', resources: item.resolved.filter(resource => resource.role === 'skill') },
    { id: 'mcp', label: 'MCP', resources: item.resolved.filter(resource => resource.role === 'mcp') },
    { id: 'pi-extensions', label: 'Pi extensions', resources: item.resolved.filter(resource => resource.role === 'pi-extension' || resource.role === 'extension') },
  ];
  return groups.filter(group => group.resources.length);
}

export type ExtensionUpdate = { installed: string | null; latest: string | null; available: boolean; installGaps?: string[] };

export type OfficialPackage = { name: string; version: string; description: string; publisher: string | null; weeklyDownloads: number | null; url: string | null };
