import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.ts';
import { Button, Card, Empty, Icon, Pill, toast } from './ui.tsx';
import { GRAPH_ARCHITECTURES } from '../catalog/architecture-catalog.ts';
import type { CapabilityRecord } from '../catalog/catalog.ts';
import type { AgentCombination, AgentCombinationView } from '../catalog/agent-combinations.ts';
import './setup.ts';

interface ResourceSettings {
  capabilities: CapabilityRecord[];
  agentCombinations?: AgentCombinationView[];
  capabilityConfig?: CapabilityConfigItem[];
  capabilityRoot?: string | null;
  agentCombinationFile?: string | null;
  agentCombinationError?: string | null;
}

type CapabilityConfigField = {
  env: string;
  label: string;
  secret: boolean;
  reason: string;
};

type CapabilityConfigItem = {
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

type CapabilitySort = 'alphabetical' | 'enabled' | 'popular';

const CAPABILITY_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function capabilityUsage(combinations: AgentCombinationView[]) {
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

function capabilityMatches(item: CapabilityRecord, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [item.id, item.name, item.description, item.source, item.kind, item.role]
    .filter(Boolean).join('\n').toLowerCase();
  return terms.every(term => haystack.includes(term));
}

function orderedCapabilities(input: {
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

const MAIN_AGENT_SYSTEM_CAPABILITIES = [
  '任务规划',
  'Graph 设计',
  '组装并调用 Subagents',
  '按订阅选择模型',
  '监控 Graph 全程',
  '处理执行问题',
  '面向用户汇报',
];

function capabilityKindLabel(item: CapabilityRecord) {
  if (item.kind === 'prompt') return item.role === 'tool' ? 'Tool.md' : 'Agent.md';
  if (item.kind === 'pi-extension') return 'Pi extension';
  if (item.kind === 'extension') return 'Graph extension';
  return item.kind === 'mcp' ? 'MCP' : 'Skill';
}

function capabilityGroups(item: AgentCombinationView) {
  const groups = [
    { id: 'agent-md', label: 'Agent.md', resources: item.resolved.filter(resource => resource.role === 'identity' || resource.role === 'tool') },
    { id: 'skills', label: 'Skills', resources: item.resolved.filter(resource => resource.role === 'skill') },
    { id: 'mcp', label: 'MCP', resources: item.resolved.filter(resource => resource.role === 'mcp') },
    { id: 'pi-extensions', label: 'Pi extensions', resources: item.resolved.filter(resource => resource.role === 'pi-extension' || resource.role === 'extension') },
  ];
  return groups.filter(group => group.resources.length);
}

function CapabilityDetail({ item }: { item: CapabilityRecord }) {
  return (
    <div className="stack resource-detail-sections" data-testid={`capability-detail-${item.id}`}>
      <div className="row" style={{ gap: 8 }}>
        <Pill tone={item.status === 'available' ? 'success' : 'danger'}>{item.status === 'available' ? '可用' : '清单有误'}</Pill>
        <Pill tone="neutral">{capabilityKindLabel(item)}</Pill>
        <Pill tone="neutral">v{item.version}</Pill>
      </div>
      <p>{item.description || '该能力没有提供说明。'}</p>
      {item.error && <div className="form-error">{item.error}</div>}
      <section>
        <h4>本地目录</h4>
        <code className="resource-path">{item.source}</code>
      </section>
      <section>
        <h4>使用边界</h4>
        <p className="muted">扫描到正确目录后即可直接使用。能力本身不会授予任务权限，实际运行仍受任务范围、暂停和调用门约束。</p>
      </section>
    </div>
  );
}

function CapabilityConfigPanel({ items }: { items: CapabilityConfigItem[] }) {
  const bridge = typeof window !== 'undefined' ? window.graph : undefined;
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string; tools?: string[] }>>({});
  if (!items.length) return <Empty icon="settings" title="暂无需要配置的能力" hint="需要凭据或环境变量的 MCP 会显示在这里。" />;
  const saveAndTest = async (item: CapabilityConfigItem) => {
    const key = `${item.id}@${item.version}`;
    setBusy(key);
    try {
      const supplied = Object.fromEntries(item.fields.flatMap(field => {
        const value = values[`${key}:${field.env}`]?.trim();
        return value ? [[field.env, value]] : [];
      }));
      if (bridge) {
        for (const [ref, value] of Object.entries(supplied)) {
          const saved = await bridge.saveSecret(ref, value);
          if (!saved.stored && !saved.applied) throw new Error(saved.message ?? `无法保存 ${ref}`);
        }
        window.dispatchEvent(new Event('graph:settings-changed'));
      }
      const result = await api<{ ok: boolean; message: string; tools?: string[] }>(
        `/api/capabilities/${encodeURIComponent(item.id)}/${encodeURIComponent(item.version)}/test`,
        { method: 'POST', body: JSON.stringify({ values: supplied }) },
      );
      setResults(current => ({ ...current, [key]: result }));
      if (result.ok) toast(`${item.name} 可用${result.tools?.length ? `，发现 ${result.tools.length} 个工具` : ''}`, 'success');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setResults(current => ({ ...current, [key]: { ok: false, message } }));
      toast(message, 'danger');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="capability-config-list" data-testid="capability-config-list">
      {items.map(item => {
        const key = `${item.id}@${item.version}`;
        const result = results[key];
        return (
          <article className="capability-config-item" key={key} data-testid={`capability-config-${item.id}`}>
            <header>
              <div><strong>{item.name}</strong><code>{item.id}@{item.version}</code></div>
              <Pill tone={item.ready ? 'success' : item.missing.length ? 'warn' : 'danger'}>
                {item.error ? '清单不可读' : item.ready ? '已配置' : `缺少 ${item.missing.length} 项`}
              </Pill>
            </header>
            {item.error && <div className="form-error">{item.error}</div>}
            <div className="capability-config-fields">
              {item.fields.map(field => {
                const configured = item.configured.includes(field.env);
                return (
                  <label className="capability-config-field" key={field.env}>
                    <span><strong>{field.label}</strong><code>{field.env}</code></span>
                    <input
                      className="input"
                      type={field.secret ? 'password' : 'text'}
                      autoComplete="off"
                      placeholder={configured ? '已保存，留空则保持不变' : field.env}
                      value={values[`${key}:${field.env}`] ?? ''}
                      data-testid={`capability-config-${item.id}-${field.env}`}
                      onChange={event => setValues(current => ({ ...current, [`${key}:${field.env}`]: event.target.value }))}
                    />
                    <small>{field.reason}{configured ? ' · 已配置' : ''}</small>
                  </label>
                );
              })}
            </div>
            <div className="capability-config-actions">
              <span className="muted">{bridge ? '保存到本机钥匙串，并立即验证连接。' : '浏览器模式：请先设置对应环境变量。'}</span>
              <Button size="sm" icon="check" disabled={busy === key} onClick={() => void saveAndTest(item)}>
                {busy === key ? '验证中…' : '保存并验证'}
              </Button>
            </div>
            {result && (
              <div className={result.ok ? 'capability-config-result is-ok' : 'capability-config-result is-error'} data-testid={`capability-config-result-${item.id}`}>
                {result.message}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function AgentCombinationEditor(input: {
  capabilities: CapabilityRecord[];
  combinations: AgentCombinationView[];
  initial?: AgentCombinationView;
  onClose(): void;
  onSaved(): void;
}) {
  const promptCapabilities = input.capabilities.filter(item => item.status === 'available' && item.kind === 'prompt' && item.role === 'agent');
  const skills = input.capabilities.filter(item => item.status === 'available' && item.kind === 'skill');
  const mcp = input.capabilities.filter(item => item.status === 'available' && item.kind === 'mcp');
  const extensions = input.capabilities.filter(item => item.status === 'available' && (item.kind === 'pi-extension' || item.kind === 'extension'));
  const [id, setId] = useState(input.initial?.id ?? '');
  const [name, setName] = useState(input.initial?.name ?? '');
  const [description, setDescription] = useState(input.initial?.description ?? '');
  const [grade, setGrade] = useState(input.initial?.recommendedGrade ?? 'medium');
  const [review, setReview] = useState(input.initial?.review ?? false);
  const [tags, setTags] = useState((input.initial?.tags ?? []).join(', '));
  const mode = input.initial?.mode;
  const main = mode === 'main';
  const selected = (role: AgentCombination['resources'][number]['role']) => new Set(
    (input.initial?.resources ?? [])
      .filter(member => member.role === role)
      .map(member => `${member.resourceId}@${member.version ?? 'current'}`),
  );
  const firstIdentity = selected('identity').values().next().value as string | undefined;
  const [identity, setIdentity] = useState(firstIdentity ?? '');
  const [skillKeys, setSkillKeys] = useState(() => selected('skill'));
  const [mcpKeys, setMcpKeys] = useState(() => selected('mcp'));
  const [extensionKeys, setExtensionKeys] = useState(() => new Set([
    ...selected('pi-extension'),
    ...selected('extension'),
  ]));
  const [capabilityQuery, setCapabilityQuery] = useState('');
  const [capabilitySort, setCapabilitySort] = useState<CapabilitySort>('alphabetical');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const usage = capabilityUsage(input.combinations);

  const toggle = (setter: (value: Set<string>) => void, current: Set<string>, key: string) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  };
  const binding = (key: string) => {
    const [resourceId, version] = key.split('@');
    return {
      resourceId: resourceId!,
      ...(version && version !== 'current' ? { version } : {}),
      required: true,
    };
  };
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const resources: AgentCombination['resources'] = [];
      if (identity) resources.push({ ...binding(identity), role: 'identity' });
      for (const key of skillKeys) resources.push({ ...binding(key), role: 'skill' });
      for (const key of mcpKeys) resources.push({ ...binding(key), role: 'mcp' });
      for (const key of extensionKeys) {
        const kind = extensions.find(item => `${item.id}@${item.version}` === key)?.kind;
        resources.push({ ...binding(key), role: kind === 'extension' ? 'extension' : 'pi-extension' });
      }
      await api<AgentCombinationView>('/api/catalog/combinations', {
        method: 'POST',
        body: JSON.stringify({
          combination: {
            id, name, description, ...(mode ? { mode } : {}), recommendedGrade: grade, review: main ? false : review,
            tags: tags.split(',').map(tag => tag.trim()).filter(Boolean),
            resources,
          },
        }),
      });
      input.onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const picker = (
    testid: string,
    items: CapabilityRecord[],
    keys: Set<string>,
    setter: (value: Set<string>) => void,
  ) => {
    const visible = orderedCapabilities({ items, selected: keys, query: capabilityQuery, sort: capabilitySort, usage });
    return (
    <div className="recipe-picker" data-testid={testid}>
      {visible.length ? visible.map(item => {
        const key = `${item.id}@${item.version}`;
        return (
          <label key={key} className="recipe-option" data-testid={`recipe-option-${item.kind}-${item.id}`}>
            <input type="checkbox" checked={keys.has(key)} onChange={() => toggle(setter, keys, key)} />
            <span>
              <strong>{item.name ?? item.id}</strong>
              <small>{item.id}@{item.version} · {usage.get(item.id) ?? 0} 个配方</small>
            </span>
          </label>
        );
      }) : <p className="muted">{items.length ? '没有匹配的能力。' : '暂无可选能力。'}</p>}
    </div>
    );
  };
  return createPortal(
    <div className="resource-detail-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) input.onClose(); }}>
      <aside className="resource-detail-drawer recipe-editor" role="dialog" aria-modal="true" aria-label="Agent 配方编辑器">
        <header className="resource-detail-head">
          <div><h2>{input.initial ? '编辑 Agent 配方' : '新建 Agent 配方'}</h2><p>配方只组合已有能力，编译后直接生成可派发定义。显示名称建议采用“名字_角色”。</p></div>
          <button type="button" className="icon-button" onClick={input.onClose} aria-label="关闭"><Icon name="close" size={16} /></button>
        </header>
        <div className="resource-detail-body recipe-form">
          <div className="form-grid">
            <label><span>ID</span><input data-testid="agent-recipe-id" value={id} disabled={main} onChange={event => setId(event.target.value)} placeholder="coder" /></label>
            <label>
              <span>显示名称</span>
              <input data-testid="agent-recipe-name" value={name} onChange={event => setName(event.target.value)} placeholder={id.trim() ? `Bob_${id.trim()}` : 'Bob_coder'} />
              <small>使用“名字_角色”，例如 Bob_coder、Alice_reviewer。</small>
            </label>
          </div>
          <label>
            <span>Agent 简介</span>
            <textarea
              data-testid="agent-recipe-description"
              value={description}
              onChange={event => setDescription(event.target.value)}
              rows={3}
              placeholder="简述这个 Agent 的用途、适合的任务范围与关键边界。"
            />
            <small>显示在 Agent 组合库中，帮助用户在派发前快速判断它适合做什么。</small>
          </label>
          {main && (
            <div className="recipe-main-note" data-testid="main-agent-recipe-note">
              Main Agent 的系统能力由 `master` 角色固定启用，不能从配方移除。下方配置的是它额外可用的 Skills、MCP、Pi extensions 和 Agent.md。
            </div>
          )}
          <div className="form-grid">
            <label><span>模型等级</span><select value={grade} onChange={event => setGrade(event.target.value as typeof grade)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="highest">最高</option></select></label>
            <label className="recipe-check"><input type="checkbox" disabled={main} checked={main ? false : review} onChange={event => setReview(event.target.checked)} /><span>作为独立审查 Agent</span></label>
          </div>
          <label><span>标签</span><input value={tags} onChange={event => setTags(event.target.value)} placeholder="编码, 实现" /></label>
          <section className="recipe-section">
            <h3>身份 Prompt</h3>
            <select value={identity} onChange={event => setIdentity(event.target.value)}>
              <option value="">不绑定身份 Prompt</option>
              {promptCapabilities.map(item => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>{item.name ?? item.id} · {item.id}@{item.version}</option>)}
            </select>
          </section>
          <div className="recipe-picker-toolbar">
            <label className="recipe-search">
              <Icon name="search" size={14} />
              <input
                type="search"
                data-testid="recipe-capability-search"
                value={capabilityQuery}
                onChange={event => setCapabilityQuery(event.target.value)}
                placeholder="检索 Skills、MCP、Pi extensions…"
                aria-label="检索配方能力"
              />
            </label>
            <label className="recipe-sort">
              <span>排序</span>
              <select
                data-testid="recipe-capability-sort"
                value={capabilitySort}
                onChange={event => setCapabilitySort(event.target.value as CapabilitySort)}
                aria-label="能力排序"
              >
                <option value="alphabetical">名称 A→Z</option>
                <option value="enabled">已开启优先</option>
                <option value="popular">热门优先</option>
              </select>
            </label>
          </div>
          <section className="recipe-section"><h3>Skills</h3>{picker('recipe-picker-skills', skills, skillKeys, setSkillKeys)}</section>
          <section className="recipe-section"><h3>MCP</h3>{picker('recipe-picker-mcp', mcp, mcpKeys, setMcpKeys)}</section>
          <section className="recipe-section"><h3>Pi / Graph extensions</h3>{picker('recipe-picker-extensions', extensions, extensionKeys, setExtensionKeys)}</section>
          {error && <div className="form-error">{error}</div>}
          <div className="recipe-actions">
            <Button variant="ghost" onClick={input.onClose}>取消</Button>
            <Button disabled={saving || !id.trim() || !name.trim() || !description.trim()} onClick={() => void save()}>{saving ? '保存中…' : '保存配方'}</Button>
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

export function ResourceLibrary({ settings, section }: { settings: ResourceSettings | null; section?: string | undefined }) {
  const [selected, setSelected] = useState<CapabilityRecord | null>(null);
  const [editing, setEditing] = useState<AgentCombinationView | null | undefined>(undefined);
  const [resourceQuery, setResourceQuery] = useState('');
  const [resourceLimits, setResourceLimits] = useState<Record<string, number>>({});
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
  const visible = filtered.slice(0, resourceLimits[active.id] ?? 40);
  const countFor = (id: string) => id === 'config' ? settings?.capabilityConfig?.length ?? 0
    : id === 'architectures' ? GRAPH_ARCHITECTURES.length
    : id === 'prompts' ? 6
    : id === 'agents' ? agentCombinations.length
      : sections.find(item => item.id === id)?.items.length ?? 0;
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
  const compile = async (id: string) => {
    try {
      const result = await api<{ definitionVersion: string }>(`/api/catalog/combinations/${encodeURIComponent(id)}/compile`, { method: 'POST' });
      toast(`已编译为 ${result.definitionVersion}`, 'success');
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
  return (
    <div className="stagger resource-library" data-testid="catalog">
      <div className="resource-layout">
        <nav className="resource-nav" aria-label="资源库导航">
          {sections.map(item => <a key={item.id} href={`#/catalog/${item.id}`} data-active={item.id === active.id} data-testid={`resource-nav-${item.id}`}><Icon name={item.icon} size={15} /><span>{item.title}</span><span className="resource-nav-count">{countFor(item.id)}</span></a>)}
        </nav>
        <section className="resource-main">
          <Card
            testid={`resource-section-${active.id}`}
            title={active.title}
            icon={active.icon}
            subtitle={`${countFor(active.id)} 项`}
            actions={(
              <div className="row" style={{ gap: 4 }}>
                {active.id === 'agents' && <button type="button" className="icon-button" onClick={() => setEditing(null)} title="新建 Agent 配方" aria-label="新建 Agent 配方"><Icon name="plus" size={16} /></button>}
                <button type="button" className="icon-button" onClick={refresh} title="重新扫描能力目录" aria-label="重新扫描能力目录"><Icon name="refresh" size={16} /></button>
                {active.id !== 'agents' && active.id !== 'architectures' && active.id !== 'config' && <button type="button" className="icon-button" data-testid={`resource-open-${active.id}`} onClick={() => void openResource(active.id as 'skills' | 'mcp' | 'pi-extensions' | 'agent-md' | 'prompts')} title="在访达中打开目录" aria-label="在访达中打开目录"><Icon name="folder" size={16} /></button>}
              </div>
            )}
          >
            {active.id === 'agents' ? (
              settings?.agentCombinationError ? <div className="form-error">配方文件无法读取：{settings.agentCombinationError}</div>
              : agentCombinations.length ? (
                <>
                  <div className="resource-section-toolbar"><p>{active.description}</p><label className="resource-search"><Icon name="search" size={15} /><input value={resourceQuery} onChange={event => setResourceQuery(event.target.value)} placeholder="搜索 Agent 配方或能力" /><span className="faint">{filteredAgents.length}</span></label></div>
                  <div className="agent-combination-list" data-testid="agent-combination-list">
                    {visibleAgents.map(item => (
                      <article className="agent-combination-item" key={item.id} data-testid={`agent-combination-${item.id}`}>
                        <header>
                          <div className="agent-combination-title">
                            <strong>{item.name}</strong>
                            <span>Agent 配方 · {item.recommendedGrade}{item.tags.length ? ` · ${item.tags.join(' · ')}` : ''}</span>
                          </div>
                          <code>{item.id}</code>
                        </header>
                        <p className="agent-combination-description">
                          <Icon name="message" size={13} />
                          <span>{item.description}</span>
                        </p>
                        <div className="chip-row">
                          <Pill tone={item.status === 'valid' ? 'success' : 'danger'}>{item.status === 'valid' ? '可编译' : '引用有误'}</Pill>
                          {item.mode === 'main' && <Pill tone="accent">Main Agent</Pill>}
                          <Pill tone="neutral">{item.recommendedGrade}</Pill>
                          {item.review && <Pill tone="warn">独立审查</Pill>}
                        </div>
                        {item.mode === 'main' && (
                          <section className="recipe-capability-group" data-testid="main-agent-system-capabilities">
                            <h4>系统能力</h4>
                            <div className="chip-row">
                              {MAIN_AGENT_SYSTEM_CAPABILITIES.map(capability => <span className="capability-chip" key={capability}>{capability}</span>)}
                            </div>
                          </section>
                        )}
                        <div className="recipe-capability-groups">
                          {capabilityGroups(item).map(group => (
                            <section className="recipe-capability-group" key={group.id} data-testid={`agent-capabilities-${item.id}-${group.id}`}>
                              <h4>{group.label}</h4>
                              <div className="chip-row">
                                {group.resources.map(resource => (
                                  <button
                                    key={`${resource.role}:${resource.resourceId}:${resource.version}`}
                                    type="button"
                                    className="capability-chip"
                                    data-testid={`agent-capability-${item.id}-${resource.resourceId}`}
                                    onClick={() => openResolvedCapability(resource.resourceId, resource.version)}
                                  >
                                    {resource.name}
                                  </button>
                                ))}
                              </div>
                            </section>
                          ))}
                        </div>
                        {item.issues.map(issue => <div className="form-error" key={issue}>{issue}</div>)}
                        <div className="recipe-card-actions">
                          <Button size="sm" disabled={item.status !== 'valid'} onClick={() => void compile(item.id)}>编译</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(item)}>编辑</Button>
                          <Button size="sm" variant="danger" disabled={item.mode === 'main'} onClick={() => void remove(item.id)}>删除</Button>
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              ) : <Empty icon="catalog" title="暂无 Agent 配方" hint="点击右上角 + 创建配方。" />
            ) : active.id === 'prompts' ? (
              <div className="prompt-library-summary" data-testid="prompt-library-summary">
                <p>{active.description} 对话顶部的“Agent 上下文”可以直接查看和编辑；这里可以打开固定文件夹做批量维护。</p>
                <Button size="sm" icon="folder" onClick={() => void openResource('prompts')}>打开 Prompt 文件夹</Button>
              </div>
            ) : active.id === 'config' ? (
              <CapabilityConfigPanel items={settings?.capabilityConfig ?? []} />
            ) : active.id === 'architectures' ? (
              <div className="architecture-list" data-testid="architecture-library">{GRAPH_ARCHITECTURES.map(item => <article className="architecture-item" key={item.name}><div className="architecture-flow mono">{item.flow}</div><div><strong>{item.name}</strong><p>{item.description}</p></div></article>)}</div>
            ) : active.items.length ? (
              <>
                <div className="resource-section-toolbar"><p>{active.description}</p><label className="resource-search"><Icon name="search" size={15} /><input value={resourceQuery} onChange={event => setResourceQuery(event.target.value)} placeholder="搜索能力或路径" data-testid="resource-catalog-search" /><span className="faint">{filtered.length}</span></label></div>
                {visible.length ? <div className="resource-candidate-list">{visible.map(item => <button key={`${item.id}@${item.version}`} type="button" className="resource-candidate-row" data-testid={`resource-entry-${item.id}`} onClick={() => setSelected(item)}><Icon name={active.icon} size={15} /><span className="resource-candidate-copy"><span>{item.name ?? item.id}</span><small>{item.status === 'invalid' ? item.error : item.description || item.source}</small></span><Icon name="chevron" size={14} /></button>)}</div> : <p className="muted">没有匹配的能力。</p>}
                {filtered.length > visible.length && <Button size="sm" data-testid={`resource-more-${active.id}`} onClick={() => setResourceLimits(current => ({ ...current, [active.id]: (current[active.id] ?? 40) + 40 }))}>显示更多（{visible.length} / {filtered.length}）</Button>}
              </>
            ) : <p className="muted">{active.id === 'agent-md' ? '暂无 Agent.md 能力' : `暂无 ${active.title.replace(' 库', '')} 能力`}</p>}
          </Card>
        </section>
      </div>
      {selected && createPortal(
        <div className="resource-detail-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setSelected(null); }}>
          <aside className="resource-detail-drawer" data-testid="resource-detail-drawer" role="dialog" aria-modal="true" aria-label={`能力详情 ${selected.name ?? selected.id}`}>
            <header className="resource-detail-head"><div><h2>{selected.name ?? selected.id}</h2><p>能力详情</p></div><button type="button" className="icon-button" data-testid="resource-detail-close" onClick={() => setSelected(null)} aria-label="关闭详情"><Icon name="close" size={16} /></button></header>
            <div className="resource-detail-body"><CapabilityDetail item={selected} /></div>
          </aside>
        </div>,
        document.body,
      )}
      {editing !== undefined && <AgentCombinationEditor capabilities={capabilities} combinations={agentCombinations} {...(editing ? { initial: editing } : {})} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); window.dispatchEvent(new Event('graph:settings-changed')); toast('配方已保存', 'success'); }} />}
    </div>
  );
}
