


import { useEffect,useState } from 'react';




import { api } from './api.ts';


import { toast } from './ui.tsx';


import { GRAPH_ARCHITECTURES } from '../catalog/architecture-catalog.ts';


import type { CapabilityRecord } from './catalog-view-types.ts';


import type { AgentCombinationView } from './catalog-view-types.ts';


import './setup.ts';




import type { ExtensionUpdate,LibraryEntryFilter,OfficialPackage,ResourceSettings } from "./resource-library-entries.tsx";

import { capabilityIsConfigured,splitLibraryEntries } from "./resource-library-entries.tsx";

import './resource-library.css';

export function useResourceLibraryState({ settings, section }: { settings: ResourceSettings | null; section?: string | undefined }) {
  const [selected, setSelected] = useState<CapabilityRecord | null>(null);
  const [editing, setEditing] = useState<AgentCombinationView | null | undefined>(undefined);
  const [resourceQuery, setResourceQuery] = useState('');
  const [resourceLimits, setResourceLimits] = useState<Record<string, number>>({});
  const [libraryFilter, setLibraryFilter] = useState<LibraryEntryFilter>('all');
  const bridge = typeof window !== 'undefined' ? window.graph : undefined;
  const capabilities = settings?.capabilities ?? [];
  const agentCombinations = settings?.agentCombinations ?? [];
  const sections = [
    { id: 'skills', title: 'Skills 库', icon: 'spark' as const, description: '扫描自能力目录的独立 Skills。', items: capabilities.filter(item => item.kind === 'skill') },
    { id: 'mcp', title: 'MCP 库', icon: 'link' as const, description: '扫描自能力目录的 MCP servers。', items: capabilities.filter(item => item.kind === 'mcp') },
    { id: 'pi-extensions', title: 'Pi 扩展库', icon: 'box' as const, description: '扫描到的 Pi extensions 与 Graph extensions。', items: capabilities.filter(item => item.kind === 'pi-extension' || item.kind === 'extension') },
    { id: 'agent-md', title: 'Agent.md 库', icon: 'message' as const, description: '可作为 Agent 身份模板的 prompt 能力。', items: capabilities.filter(item => item.kind === 'prompt' && item.role === 'agent') },
    { id: 'prompts', title: 'Prompt 库', icon: 'message' as const, description: '集中管理注入给 Agent 与 Pi 的系统提示词和运行时提示词。', items: [] as CapabilityRecord[] },
    { id: 'config', title: '配置', icon: 'settings' as const, description: '需要凭据、环境变量或服务地址才能加载的能力。', items: [] as CapabilityRecord[] },
    { id: 'agents', title: 'Agent 组合库', icon: 'catalog' as const, description: '引用已有能力的配方；编译后直接成为可派发定义。', items: [] as CapabilityRecord[] },
    { id: 'architectures', title: '架构库', icon: 'graph' as const, description: 'Graph 支持并可组合使用的经典任务图架构。', items: [] as CapabilityRecord[] },
  ];
  const active = sections.find(item => item.id === section) ?? sections[0]!;
  const query = resourceQuery.trim().toLowerCase();
  const filtered = active.items.filter(item => !query || [item.id, item.name, item.description, item.source, item.kind, item.role].some(value => value?.toLowerCase().includes(query)));
  const filteredAgents = agentCombinations.filter(item => !query || [
    item.id, item.name, item.description, item.recommendedGrade, ...item.tags,
    ...item.resources.map(resource => resource.resourceId),
  ].some(value => value?.toLowerCase().includes(query)));
  const visibleAgents = filteredAgents.slice(0, resourceLimits.agents ?? 40);
  const configByRef = new Map((settings?.capabilityConfig ?? []).map(item => [`${item.id}@${item.version}`, item]));
  const configFor = (item: CapabilityRecord) => configByRef.get(`${item.id}@${item.version}`);
  const split = splitLibraryEntries(filtered, libraryFilter, item => capabilityIsConfigured(item, configFor(item)));
  const pageLimit = resourceLimits[active.id] ?? 40;
  const configuredVisible = split.configured.slice(0, pageLimit);
  const unconfiguredVisible = split.unconfigured.slice(0, pageLimit);
  const showConfigured = libraryFilter !== 'unconfigured';
  const showUnconfigured = libraryFilter !== 'configured';
  const shownCount = (showConfigured ? configuredVisible.length : 0) + (showUnconfigured ? unconfiguredVisible.length : 0);
  const countFor = (id: string) => id === 'config' ? settings?.capabilityConfig?.length ?? 0
    : id === 'architectures' ? GRAPH_ARCHITECTURES.length
    : id === 'prompts' ? 6
    : id === 'agents' ? agentCombinations.length
      : sections.find(item => item.id === id)?.items.length ?? 0;
  const [updates, setUpdates] = useState<Record<string, ExtensionUpdate>>({});
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseQuery, setBrowseQuery] = useState('');
  const [browseHits, setBrowseHits] = useState<OfficialPackage[]>([]);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  // Read-only: this browses the official channel, it never writes a capability.
  const loadBrowse = async () => {
    setBrowseBusy(true);
    setBrowseError(null);
    try {
      const result = await api<{ packages: OfficialPackage[] }>(`/api/catalog/pi-packages?q=${encodeURIComponent(browseQuery.trim())}`);
      setBrowseHits(result.packages);
    } catch (cause) {
      setBrowseError(cause instanceof Error ? cause.message : String(cause));
      setBrowseHits([]);
    } finally {
      setBrowseBusy(false);
    }
  };
  const toggleBrowse = async () => {
    const next = !browseOpen;
    setBrowseOpen(next);
    if (next && !browseHits.length) await loadBrowse();
  };
  // The switch is a daemon setting, so it lives in the config file rather than browser preferences.
  useEffect(() => {
    let live = true;
    void api<{ revision: number; config?: { piExtensionAutoUpdate?: boolean } }>('/api/config')
      .then(result => { if (live) setAutoUpdate(Boolean(result.config?.piExtensionAutoUpdate)); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  const saveAutoUpdate = async (value: boolean) => {
    setAutoUpdate(value);
    try {
      const current = await api<{ revision: number; config: Record<string, unknown> }>('/api/config');
      await api('/api/config', { method: 'POST', body: JSON.stringify({ expectedRevision: current.revision, document: { ...current.config, piExtensionAutoUpdate: value } }) });
      toast(value ? '已开启 Pi 扩展自动更新' : '已关闭 Pi 扩展自动更新', 'success');
    } catch (cause) {
      setAutoUpdate(!value);
      toast(cause instanceof Error ? cause.message : String(cause), 'danger');
    }
  };
  // Pi extension sources are checked once per page open; the server caches the registry answer.
  useEffect(() => {
    let live = true;
    void api<{ updates: { id: string; version: string; installed: string | null; latest: string | null; available: boolean }[] }>('/api/catalog/pi-extension-updates')
      .then(result => {
        if (!live) return;
        setUpdates(Object.fromEntries(result.updates.map(item => [`${item.id}@${item.version}`, item])));
        const available = result.updates.filter(item => item.available);
        if (available.length) toast(`有 ${available.length} 个 Pi 扩展可以更新：${available.map(item => item.id).join('、')}`);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  const updateOne = async (item: CapabilityRecord) => {
    try {
      const result = await api<{ updated: boolean; version: string | null }>(
        `/api/catalog/pi-extensions/${encodeURIComponent(item.id)}/${encodeURIComponent(item.version)}/update`,
        { method: 'POST' },
      );
      toast(`已更新 ${item.id}${result.version ? ` 到 ${result.version}` : ''}`, 'success');
      setUpdates(current => ({ ...current, [`${item.id}@${item.version}`]: { installed: result.version, latest: result.version, available: false } }));
      window.dispatchEvent(new Event('graph:settings-changed'));
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'danger');
    }
  };
  // A capability installed while the app is running is invisible until a new
  // extension host reads its configuration: this is the action that replaces
  // the host without restarting the app.
  const reloadExtensions = () => {
    void api<{ reloaded: boolean }>('/api/extensions/reload', {
      method: 'POST',
      body: JSON.stringify({ requestId: `extensions-reload-${Date.now()}` }),
    }).then(result => {
      toast(result.reloaded
        ? '已重载扩展：下一次会话会重新读取扩展配置'
        : '扩展宿主当前未运行；下一次会话创建时会读取最新配置', 'success');
    }).catch(cause => toast(cause instanceof Error ? cause.message : String(cause), 'danger'));
  };
  const refresh = () => {
    void api('/api/catalog/refresh', { method: 'POST' }).then(() => {
      window.dispatchEvent(new Event('graph:settings-changed'));
      toast('已重新扫描能力目录', 'success');
    }).catch(cause => toast(cause instanceof Error ? cause.message : String(cause), 'danger'));
  };
  const openResolvedCapability = (resourceId: string, version: string) => {
    const record = capabilities.find(item => item.id === resourceId && item.version === version);
    if (!record) {
      toast(`找不到能力 ${resourceId}@${version}`, 'danger');
      return;
    }
    setSelected(record);
  };
  const remove = async (id: string) => {
    try {
      await api(`/api/catalog/combinations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      window.dispatchEvent(new Event('graph:settings-changed'));
      toast('配方已删除', 'success');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'danger');
    }
  };
  async function openResource(kind: 'skills' | 'mcp' | 'pi-extensions' | 'agent-md' | 'prompts') {
    if (!bridge?.openResource) {
      toast('请在桌面 APP 中使用访达打开能力目录', 'info');
      return;
    }
    const result = await bridge.openResource(kind);
    if (!result.opened) toast(`打开目录失败：${result.message ?? '系统未返回原因'}`, 'danger');
  }
  return { fallback: null, openResource, sections, active, countFor, setEditing, refresh, settings, agentCombinations, resourceQuery, setResourceQuery, filteredAgents, visibleAgents, openResolvedCapability, remove, libraryFilter, setLibraryFilter, autoUpdate, saveAutoUpdate, filtered, toggleBrowse, browseOpen, browseQuery, setBrowseQuery, loadBrowse, browseBusy, browseError, browseHits, split, showConfigured, configuredVisible, setSelected, showUnconfigured, unconfiguredVisible, configFor, shownCount, setResourceLimits, selected, updates, updateOne, editing, capabilities, reloadExtensions, Event };
}
