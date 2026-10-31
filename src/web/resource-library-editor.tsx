import { ModelGradeOptions } from './model-grade-options.tsx';


import { useEffect,useRef,useState } from 'react';

import { createPortal } from 'react-dom';

import { api } from './api.ts';

import { Button,Icon } from './ui.tsx';


import type { CapabilityRecord,SavedAgentCombination } from './catalog-view-types.ts';

import type { AgentCombination,AgentCombinationView } from './catalog-view-types.ts';

import './setup.ts';

import type { CapabilitySort } from "./resource-library-entries.tsx";
import { capabilityUsage,orderedCapabilities } from "./resource-library-entries.tsx";
import './resource-library.css';

export function AgentCombinationEditor(input: {
  capabilities: CapabilityRecord[];
  combinations: AgentCombinationView[];
  initial?: AgentCombinationView;
  onClose(): void;
  onSaved(result: SavedAgentCombination): void;
  onDescriptionSaved?(combination: AgentCombinationView): void;
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
  const [systemPrompt, setSystemPrompt] = useState(input.initial?.systemPrompt ?? '');
  const [skillKeys, setSkillKeys] = useState(() => selected('skill'));
  const [mcpKeys, setMcpKeys] = useState(() => selected('mcp'));
  const [extensionKeys, setExtensionKeys] = useState(() => new Set([
    ...selected('pi-extension'),
    ...selected('extension'),
  ]));
  const [capabilityQuery, setCapabilityQuery] = useState('');
  const [capabilitySort, setCapabilitySort] = useState<CapabilitySort>('alphabetical');
  const [saving, setSaving] = useState(false);
  const [descriptionSaveState, setDescriptionSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const lastSavedDescription = useRef(input.initial?.description ?? '');
  const descriptionRef = useRef(description);
  const usage = capabilityUsage(input.combinations);
  descriptionRef.current = description;

  useEffect(() => {
    if (!input.initial || !description.trim() || description === lastSavedDescription.current) return;
    setDescriptionSaveState('saving');
    const timer = setTimeout(() => {
      void api<{ combination: AgentCombinationView }>(`/api/catalog/combinations/${encodeURIComponent(input.initial!.id)}/description`, {
        method: 'POST',
        body: JSON.stringify({ description }),
      }).then(result => {
        lastSavedDescription.current = result.combination.description;
        if (descriptionRef.current === result.combination.description) setDescriptionSaveState('saved');
        input.onDescriptionSaved?.(result.combination);
      }).catch(() => {
        if (descriptionRef.current === description) setDescriptionSaveState('error');
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [description, input.initial?.id, input.onDescriptionSaved]);

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
      if (identity && !systemPrompt.trim()) resources.push({ ...binding(identity), role: 'identity' });
      for (const key of skillKeys) resources.push({ ...binding(key), role: 'skill' });
      for (const key of mcpKeys) resources.push({ ...binding(key), role: 'mcp' });
      for (const key of extensionKeys) {
        const kind = extensions.find(item => `${item.id}@${item.version}` === key)?.kind;
        resources.push({ ...binding(key), role: kind === 'extension' ? 'extension' : 'pi-extension' });
      }
      const result = await api<SavedAgentCombination>('/api/catalog/combinations', {
        method: 'POST',
        body: JSON.stringify({
          combination: {
            id, name, description, ...(mode ? { mode } : {}), recommendedGrade: grade, review: main ? false : review,
            tags: tags.split(',').map(tag => tag.trim()).filter(Boolean),
            ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
            resources,
          },
        }),
      });
      lastSavedDescription.current = description;
      input.onSaved(result);
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
            {input.initial && (
              <small data-testid="agent-recipe-description-save-state">
                {descriptionSaveState === 'saving' ? '正在自动保存…' : descriptionSaveState === 'saved' ? '已自动保存' : descriptionSaveState === 'error' ? '自动保存失败，请手动保存或重试' : '修改后自动保存'}
              </small>
            )}
          </label>
          {main && (
            <div className="recipe-main-note" data-testid="main-agent-recipe-note">
              Main Agent 的系统能力由 `master` 角色固定启用，不能从配方移除。下方配置的是它额外可用的 Skills、MCP、Pi extensions 和 Agent.md。
            </div>
          )}
          <div className="form-grid">
            <label><span>模型等级</span><select value={grade} onChange={event => setGrade(event.target.value as typeof grade)}><ModelGradeOptions /></select></label>
            <label className="recipe-check"><input type="checkbox" disabled={main} checked={main ? false : review} onChange={event => setReview(event.target.checked)} /><span>作为独立审查 Agent</span></label>
          </div>
          <label><span>标签</span><input value={tags} onChange={event => setTags(event.target.value)} placeholder="编码, 实现" /></label>
          <section className="recipe-section">
            <h3>System Prompt</h3>
            <p className="muted">直接编写这个 Agent 的身份、专业知识、工作方式和输出要求。保存后生成新定义版本；Graph 的运行规则仍会自动附加。</p>
            <textarea data-testid="agent-recipe-system-prompt" value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} rows={14} maxLength={40000} placeholder="你是一名……\n专业领域：……\n工作方式：……\n输出要求：……" />
            <p className="muted">也可以选择现有 Prompt 库文件；填写上方文本时，以配方内文本为准。</p>
            <select value={identity} disabled={Boolean(systemPrompt.trim())} onChange={event => setIdentity(event.target.value)}>
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
