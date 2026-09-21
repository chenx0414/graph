import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.ts';
import { Button, Icon, Pill, Spinner, toast } from './ui.tsx';

type PromptOrigin = 'editable' | 'generated' | 'pi';

export interface AgentPromptPartView {
  id: string;
  title: string;
  origin: PromptOrigin;
  content: string;
  source?: string;
}

export interface AgentPromptSectionView {
  id: string;
  title: string;
  parts: AgentPromptPartView[];
}

export interface AgentPromptView {
  key: string;
  title: string;
  description: string;
  group: 'identity' | 'tools' | 'rules' | 'runtime';
  file: string;
  content: string;
  customized: boolean;
}

export interface AgentToolView {
  name: string;
  description: string;
  source: string;
  version: string | null;
  capabilityId: string | null;
  parameters: string[];
  permission: string;
  enabled: boolean;
  available: boolean;
  runtimeAvailable: boolean | null;
}

export interface AgentCapabilityView {
  id: string;
  version: string;
  kind: string;
  name: string;
  description?: string;
  tools: string[];
  networkDomains?: string[];
  reason?: string;
}

export interface AgentContextView {
  root: string;
  docsRoot: string;
  definitionVersion: string | null;
  latestDefinitionVersion: string | null;
  prompts: AgentPromptView[];
  disabledTools: string[];
  tools: AgentToolView[];
  capabilities: AgentCapabilityView[];
  preview: {
    sections: AgentPromptSectionView[];
    text: string;
  };
}

const GROUP_LABELS: Record<AgentPromptView['group'], string> = {
  identity: '身份',
  tools: '工具指导',
  rules: '规则',
  runtime: '运行时',
};

const ORIGIN_LABELS: Record<PromptOrigin, string> = {
  editable: '可编辑',
  generated: '动态生成',
  pi: 'Pi 自动追加',
};

function availabilityText(tool: AgentToolView) {
  if (!tool.enabled) return '已关闭';
  if (!tool.available) return '当前不可用';
  if (tool.runtimeAvailable === null) return '待 operation 确认';
  return '当前可用';
}

export function AgentContextBar({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'preview' | 'prompts' | 'tools'>('preview');
  const [data, setData] = useState<AgentContextView | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [disabled, setDisabled] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    const next = await api<AgentContextView>(`/api/agent-context?conversationId=${encodeURIComponent(conversationId)}`);
    setData(next);
    setDisabled(next.disabledTools);
    const current = next.prompts.find(prompt => prompt.key === selectedPrompt) ?? next.prompts[0];
    if (current) {
      setSelectedPrompt(current.key);
      setDraft(current.content);
    }
    setLoading(false);
  }

  useEffect(() => {
    let active = true;
    const onSettingsChanged = () => { void load(); };
    window.addEventListener('graph:settings-changed', onSettingsChanged);
    setLoading(true);
    api<AgentContextView>(`/api/agent-context?conversationId=${encodeURIComponent(conversationId)}`)
      .then(next => {
        if (!active) return;
        setData(next);
        setDisabled(next.disabledTools);
        const first = next.prompts[0];
        if (first) {
          setSelectedPrompt(first.key);
          setDraft(first.content);
        }
      })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      window.removeEventListener('graph:settings-changed', onSettingsChanged);
    };
  }, [conversationId]);

  const groupedPrompts = useMemo(() => {
    const groups = new Map<AgentPromptView['group'], AgentPromptView[]>();
    for (const prompt of data?.prompts ?? []) {
      const items = groups.get(prompt.group) ?? [];
      items.push(prompt);
      groups.set(prompt.group, items);
    }
    return groups;
  }, [data]);
  const selected = data?.prompts.find(prompt => prompt.key === selectedPrompt) ?? null;
  const enabledTools = useMemo(() => data?.tools.filter(tool => tool.enabled && tool.available).length ?? 0, [data]);
  const customized = data?.prompts.filter(prompt => prompt.customized).length ?? 0;
  const definitionChanged = Boolean(
    data?.definitionVersion
    && data.latestDefinitionVersion
    && data.definitionVersion !== data.latestDefinitionVersion,
  );

  function selectPrompt(prompt: AgentPromptView) {
    setSelectedPrompt(prompt.key);
    setDraft(prompt.content);
    setError('');
  }

  async function savePrompt() {
    if (!selected || saving) return;
    setSaving(true);
    setError('');
    try {
      await api('/api/agent-context/prompts', {
        method: 'PUT',
        body: JSON.stringify({ key: selected.key, content: draft }),
      });
      await load();
      toast(`已保存 ${selected.title}；下一轮生效`, 'success');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function resetPrompt() {
    if (!selected || saving) return;
    setSaving(true);
    setError('');
    try {
      await api('/api/agent-context/prompts/reset', {
        method: 'POST',
        body: JSON.stringify({ key: selected.key }),
      });
      await load();
      toast(`已恢复 ${selected.title} 的原始版本`, 'success');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function saveTools() {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const saved = await api<{ disabledTools: string[] }>('/api/agent-context/tools', {
        method: 'PUT',
        body: JSON.stringify({ disabled }),
      });
      setDisabled(saved.disabledTools);
      setData(current => current ? {
        ...current,
        disabledTools: saved.disabledTools,
        tools: current.tools.map(tool => ({
          ...tool,
          enabled: !saved.disabledTools.includes(tool.name),
          available: !saved.disabledTools.includes(tool.name) && tool.available,
        })),
      } : current);
      await load();
      toast('工具选择已保存；下一轮生效', 'success');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function copyPrompt() {
    const text = data?.preview.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('完整 Agent Prompt 已复制', 'success');
    } catch (reason) {
      toast(`复制失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    }
  }

  const openPromptsFolder = async () => {
    const bridge = window.graph;
    if (!bridge?.openResource) {
      toast('请在桌面 APP 中打开 Prompt 文件夹', 'info');
      return;
    }
    const result = await bridge.openResource('prompts');
    if (!result.opened) toast(`打开目录失败：${result.message ?? '系统未返回原因'}`, 'danger');
  };

  return (
    <>
      <section className="agent-context-bar" data-testid="agent-context-bar">
        <button
          type="button"
          className="agent-context-summary"
          data-testid="agent-context-open"
          onClick={() => {
            setOpen(true);
            void load().catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
          }}
        >
          <span className="agent-context-summary-icon"><Icon name="spark" size={14} /></span>
          <span>
            <strong>Agent 上下文</strong>
            <small>
              {data ? `${data.prompts.length} 个来源 · ${enabledTools}/${data.tools.length} 个工具可用` : '正在读取…'}
              {customized ? ` · ${customized} 个自定义` : ''}
            </small>
          </span>
          <Icon name="chevron" size={14} />
        </button>
      </section>

      {open && createPortal(
        <div className="agent-context-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
          <aside className="agent-context-drawer" role="dialog" aria-modal="true" aria-label="Agent 上下文" data-testid="agent-context-drawer">
            <header className="agent-context-head">
              <div>
                <h2>Agent 上下文</h2>
                <p>完整预览、可编辑来源和实际工具视图共用同一套组装规则；保存后从下一轮生效。</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="关闭"><Icon name="close" size={16} /></button>
            </header>
            <div className="agent-context-body">
              <nav className="agent-context-tabs" role="tablist" aria-label="Agent 上下文页面">
                <button type="button" role="tab" data-testid="agent-context-tab-preview" data-active={tab === 'preview'} aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>
                  最终 Prompt <span>{data?.preview.sections.length ?? 0}</span>
                </button>
                <button type="button" role="tab" data-testid="agent-context-tab-prompts" data-active={tab === 'prompts'} aria-selected={tab === 'prompts'} onClick={() => setTab('prompts')}>
                  可编辑来源 <span>{data?.prompts.length ?? 0}</span>
                </button>
                <button type="button" role="tab" data-testid="agent-context-tab-tools" data-active={tab === 'tools'} aria-selected={tab === 'tools'} onClick={() => setTab('tools')}>
                  工具与能力 <span>{data?.tools.length ?? 0}</span>
                </button>
              </nav>
              {error && <div className="form-error">{error}</div>}
              {loading ? <Spinner label="正在读取 Agent 上下文…" /> : tab === 'preview' ? (
                <div className="agent-preview-panel" data-testid="agent-context-preview">
                  <div className="agent-preview-meta">
                    <span>当前会话 <code>{data?.definitionVersion ?? '未配置'}</code></span>
                    {definitionChanged && <span>最新编译 <code>{data?.latestDefinitionVersion}</code></span>}
                    <span>源码 Docs <code>{data?.docsRoot}</code></span>
                    <span>{data?.preview.text.length.toLocaleString() ?? 0} 字符</span>
                    <Button size="sm" icon="file" disabled={!data?.preview.text} onClick={() => void copyPrompt()}>
                      复制完整 Prompt
                    </Button>
                  </div>
                  {definitionChanged && (
                    <div className="agent-preview-notice" data-testid="agent-preview-definition-notice">
                      当前会话已绑定 <code>{data?.definitionVersion}</code>；新编译的 <code>{data?.latestDefinitionVersion}</code> 会用于新建会话，不会热替换正在运行的 Pi session。
                    </div>
                  )}
                  <div className="agent-preview-section-map" aria-label="Prompt section sources" data-testid="agent-preview-section-map">
                    <span className="agent-preview-origin-legend">
                      <i data-origin="editable" />可编辑
                      <i data-origin="generated" />动态生成
                      <i data-origin="pi" />Pi 自动追加
                    </span>
                    {data?.preview.sections.map(section => (
                      <span className="agent-preview-section-source" key={section.id}>
                        <code>&lt;{section.id}&gt;</code>
                        <small>{[...new Set(section.parts.map(part => ORIGIN_LABELS[part.origin]))].join(' + ')}</small>
                      </span>
                    ))}
                  </div>
                  <pre className="agent-preview-markdown" data-testid="agent-context-preview-markdown">{data?.preview.text ?? ''}</pre>
                </div>
              ) : tab === 'prompts' ? (
                <div className="agent-prompt-layout">
                  <div className="agent-prompt-list" data-testid="agent-prompt-list">
                    {[...groupedPrompts.entries()].map(([group, prompts]) => (
                      <div className="agent-prompt-group" key={group}>
                        <span className="agent-prompt-group-label">{GROUP_LABELS[group]}</span>
                        {prompts.map(prompt => (
                          <button
                            type="button"
                            key={prompt.key}
                            data-testid={`agent-prompt-${prompt.key}`}
                            data-active={prompt.key === selectedPrompt}
                            onClick={() => selectPrompt(prompt)}
                          >
                            <span>
                              <strong>{prompt.title}</strong>
                              <small>{prompt.description}</small>
                            </span>
                            {prompt.customized && <Pill tone="accent">自定义</Pill>}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="agent-prompt-editor">
                    {selected ? (
                      <>
                        <div className="agent-prompt-editor-head">
                          <div>
                            <strong>{selected.title}</strong>
                            <code>{selected.file}</code>
                          </div>
                          <Button size="sm" icon="folder" onClick={() => void openPromptsFolder()}>打开文件夹</Button>
                        </div>
                        <p>{selected.description}</p>
                        <textarea
                          data-testid="agent-prompt-editor"
                          value={draft}
                          onChange={event => setDraft(event.target.value)}
                          rows={20}
                          spellCheck={false}
                        />
                        <div className="agent-context-actions">
                          <span className="muted">支持 `{'{{models}}'}`、`{'{{requirementVersion}}'}` 等运行时变量；实时系统状态通过 `read_system_capabilities` 按需读取。</span>
                          <span className="agent-context-action-buttons">
                            <Button size="sm" icon="refresh" disabled={saving} onClick={() => void resetPrompt()}>恢复默认</Button>
                            <Button variant="primary" size="sm" icon="check" disabled={saving || !draft.trim()} onClick={() => void savePrompt()}>
                              {saving ? '保存中…' : '保存 Prompt'}
                            </Button>
                          </span>
                        </div>
                      </>
                    ) : <p className="muted">没有可编辑的 Prompt。</p>}
                  </div>
                </div>
              ) : (
                <div className="agent-tool-panel" data-testid="agent-tool-panel">
                  <div className="agent-tool-panel-head">
                    <p>关闭工具会同时从实际工具 surface 和最终 Prompt 中移除；权限、预算和审计规则保持不变。</p>
                    <Button size="sm" variant="primary" icon="check" disabled={saving} onClick={() => void saveTools()}>保存工具选择</Button>
                  </div>
                  <div className="agent-tool-panel-body">
                    <div className="agent-tool-section">
                      <header><strong>Tools</strong><span>{data?.tools.length ?? 0}</span></header>
                      <div className="agent-tool-list">
                        {data?.tools.map(tool => (
                          <label className="agent-tool-row" key={tool.name} data-enabled={tool.enabled && tool.available}>
                            <input
                              type="checkbox"
                              data-testid={`agent-tool-${tool.name}`}
                              checked={!disabled.includes(tool.name)}
                              onChange={event => setDisabled(current => event.target.checked
                                ? current.filter(name => name !== tool.name)
                                : [...new Set([...current, tool.name])])}
                            />
                            <span>
                              <strong>{tool.name}</strong>
                              <small>{tool.description || '无说明'}</small>
                              <small>参数：{tool.parameters.length ? tool.parameters.join(', ') : '未声明'} · 权限：{tool.permission}</small>
                            </span>
                            <span className="agent-tool-status">
                              <Pill tone="neutral">{tool.source}{tool.version ? `@${tool.version}` : ''}</Pill>
                              <Pill tone={!tool.enabled || !tool.available ? 'warn' : 'accent'}>{availabilityText(tool)}</Pill>
                            </span>
                          </label>
                        ))}
                        {!data?.tools.length && <p className="muted">首次运行 Main Agent 后会显示实际工具清单。</p>}
                      </div>
                    </div>
                    <div className="agent-tool-section">
                      <header><strong>Capabilities</strong><span>{data?.capabilities.length ?? 0}</span></header>
                      <div className="agent-capability-list">
                        {data?.capabilities.map(capability => (
                          <div className="agent-capability-row" key={`${capability.id}@${capability.version}`}>
                            <span>
                              <strong>{capability.name}</strong>
                              <small>{capability.kind} · {capability.id}@{capability.version}</small>
                            </span>
                            <span>{capability.tools.length ? capability.tools.join(', ') : '无工具'}</span>
                            {capability.networkDomains?.length ? <small>Needs domains</small> : null}
                          </div>
                        ))}
                        {!data?.capabilities.length && <p className="muted">当前定义没有绑定额外能力。</p>}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>,
        document.body,
      )}
    </>
  );
}
