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
  capabilityRoot?: string | null;
  agentCombinationFile?: string | null;
  agentCombinationError?: string | null;
}

const AGENT_COMBINATION_LABEL: Record<string, string> = {
  code: '代码实现',
  test: '测试编写',
  review: '代码审查',
  'e2e-test': '端到端测试',
  security: '安全检查',
  gate: '目标把关',
  ship: '上线与运维',
  'literature-search': '文献检索',
  'paper-writing': '论文写作',
  'paper-polish': '论文润色',
};

function capabilityKindLabel(item: CapabilityRecord) {
  if (item.kind === 'prompt') return item.role === 'tool' ? 'Tool.md' : 'Agent.md';
  if (item.kind === 'pi-extension') return 'Pi extension';
  if (item.kind === 'extension') return 'Graph extension';
  return item.kind === 'mcp' ? 'MCP' : 'Skill';
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

function AgentCombinationEditor(input: {
  capabilities: CapabilityRecord[];
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

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
            id, name, description, recommendedGrade: grade, review,
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
  const picker = (items: CapabilityRecord[], keys: Set<string>, setter: (value: Set<string>) => void) => (
    <div className="recipe-picker">
      {items.length ? items.map(item => {
        const key = `${item.id}@${item.version}`;
        return (
          <label key={key} className="recipe-option">
            <input type="checkbox" checked={keys.has(key)} onChange={() => toggle(setter, keys, key)} />
            <span><strong>{item.name ?? item.id}</strong><small>{item.id}@{item.version}</small></span>
          </label>
        );
      }) : <p className="muted">暂无可选能力。</p>}
    </div>
  );
  return createPortal(
    <div className="resource-detail-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) input.onClose(); }}>
      <aside className="resource-detail-drawer recipe-editor" role="dialog" aria-modal="true" aria-label="Agent 配方编辑器">
        <header className="resource-detail-head">
          <div><h2>{input.initial ? '编辑 Agent 配方' : '新建 Agent 配方'}</h2><p>配方只组合已有能力，编译后直接生成可派发定义。</p></div>
          <button type="button" className="icon-button" onClick={input.onClose} aria-label="关闭"><Icon name="close" size={16} /></button>
        </header>
        <div className="resource-detail-body recipe-form">
          <div className="form-grid">
            <label><span>ID</span><input value={id} onChange={event => setId(event.target.value)} placeholder="code" /></label>
            <label><span>名称</span><input value={name} onChange={event => setName(event.target.value)} placeholder="代码实现" /></label>
          </div>
          <label><span>说明</span><textarea value={description} onChange={event => setDescription(event.target.value)} rows={3} /></label>
          <div className="form-grid">
            <label><span>模型等级</span><select value={grade} onChange={event => setGrade(event.target.value as typeof grade)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="highest">最高</option></select></label>
            <label className="recipe-check"><input type="checkbox" checked={review} onChange={event => setReview(event.target.checked)} /><span>作为独立审查 Agent</span></label>
          </div>
          <label><span>标签</span><input value={tags} onChange={event => setTags(event.target.value)} placeholder="编码, 实现" /></label>
          <section className="recipe-section">
            <h3>身份 Prompt</h3>
            <select value={identity} onChange={event => setIdentity(event.target.value)}>
              <option value="">不绑定身份 Prompt</option>
              {promptCapabilities.map(item => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>{item.name ?? item.id} · {item.id}@{item.version}</option>)}
            </select>
          </section>
          <section className="recipe-section"><h3>Skills</h3>{picker(skills, skillKeys, setSkillKeys)}</section>
          <section className="recipe-section"><h3>MCP</h3>{picker(mcp, mcpKeys, setMcpKeys)}</section>
          <section className="recipe-section"><h3>Pi / Graph extensions</h3>{picker(extensions, extensionKeys, setExtensionKeys)}</section>
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
    { id: 'agents', title: 'Agent 组合库', icon: 'catalog' as const, description: '引用已有能力的配方；编译后直接成为可派发定义。', items: [] as CapabilityRecord[] },
    { id: 'architectures', title: '架构库', icon: 'graph' as const, description: 'Graph 支持并可组合使用的经典任务图架构。', items: [] as CapabilityRecord[] },
  ];
  const active = sections.find(item => item.id === section) ?? sections[0]!;
  const query = resourceQuery.trim().toLowerCase();
  const filtered = active.items.filter(item => !query || [item.id, item.name, item.description, item.source, item.kind, item.role].some(value => value?.toLowerCase().includes(query)));
  const filteredAgents = agentCombinations.filter(item => !query || [
    item.id, item.name, item.description, AGENT_COMBINATION_LABEL[item.id], item.recommendedGrade, ...item.tags,
    ...item.resources.map(resource => resource.resourceId),
  ].some(value => value?.toLowerCase().includes(query)));
  const visibleAgents = filteredAgents.slice(0, resourceLimits.agents ?? 40);
  const visible = filtered.slice(0, resourceLimits[active.id] ?? 40);
  const countFor = (id: string) => id === 'architectures' ? GRAPH_ARCHITECTURES.length
    : id === 'agents' ? agentCombinations.length
      : sections.find(item => item.id === id)?.items.length ?? 0;
  const refresh = () => {
    void api('/api/catalog/refresh', { method: 'POST' }).then(() => {
      window.dispatchEvent(new Event('graph:settings-changed'));
      toast('已重新扫描能力目录', 'success');
    }).catch(cause => toast(cause instanceof Error ? cause.message : String(cause), 'danger'));
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
  async function openResource(kind: 'skills' | 'mcp' | 'pi-extensions' | 'agent-md') {
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
                {active.id !== 'agents' && active.id !== 'architectures' && <button type="button" className="icon-button" data-testid={`resource-open-${active.id}`} onClick={() => void openResource(active.id as 'skills' | 'mcp' | 'pi-extensions' | 'agent-md')} title="在访达中打开能力目录" aria-label="在访达中打开能力目录"><Icon name="folder" size={16} /></button>}
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
                        <header><strong>{AGENT_COMBINATION_LABEL[item.id] ?? item.name}</strong><code>{item.id}</code></header>
                        <p>{item.description}</p>
                        <div className="chip-row">
                          <Pill tone={item.status === 'valid' ? 'success' : 'danger'}>{item.status === 'valid' ? '可编译' : '引用有误'}</Pill>
                          <Pill tone="neutral">{item.recommendedGrade}</Pill>
                          {item.review && <Pill tone="warn">独立审查</Pill>}
                          {item.resources.map(member => <Pill key={`${member.role}:${member.resourceId}:${member.version ?? ''}`} tone={member.required ? 'info' : 'neutral'}>{member.resourceId}{member.version ? `@${member.version}` : ''}</Pill>)}
                        </div>
                        {item.issues.map(issue => <div className="form-error" key={issue}>{issue}</div>)}
                        <div className="recipe-card-actions">
                          <Button size="sm" disabled={item.status !== 'valid'} onClick={() => void compile(item.id)}>编译</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(item)}>编辑</Button>
                          <Button size="sm" variant="danger" onClick={() => void remove(item.id)}>删除</Button>
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              ) : <Empty icon="catalog" title="暂无 Agent 配方" hint="点击右上角 + 创建配方。" />
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
      {editing !== undefined && <AgentCombinationEditor capabilities={capabilities} {...(editing ? { initial: editing } : {})} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); window.dispatchEvent(new Event('graph:settings-changed')); toast('配方已保存', 'success'); }} />}
    </div>
  );
}
