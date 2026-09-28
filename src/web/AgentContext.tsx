import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.ts';
import { RecordedPromptPanel } from './PromptPanel.tsx';
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
  defaultContent: string;
  customized: boolean;
  defaultCustomized: boolean;
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
  /** The exact system prompt the newest master turn sent, recorded at the provider call. */
  sent: { operationId: string; at: number; text: string; tools: string | null } | null;
}

const GROUP_LABELS: Record<AgentPromptView['group'], string> = {
  identity: '身份',
  tools: '工具指导',
  rules: '规则',
  runtime: '运行时',
};

function availabilityText(tool: AgentToolView) {
  if (!tool.enabled) return '已关闭';
  if (!tool.available) return '当前不可用';
  if (tool.runtimeAvailable === null) return '待 operation 确认';
  return '当前可用';
}

export function AgentContextPage({ conversationId }: { conversationId: string }) {
  const [tab, setTab] = useState<'sent' | 'prompts' | 'tools'>('sent');
  const initialized = useRef<string | null>(null);
  const [data, setData] = useState<AgentContextView | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
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
      draftRef.current = current.content;
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
        if (first && initialized.current !== conversationId) {
          initialized.current = conversationId;
          setSelectedPrompt(first.key);
          setDraft(first.content);
          draftRef.current = first.content;
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
  const definitionChanged = Boolean(
    data?.definitionVersion
    && data.latestDefinitionVersion
    && data.definitionVersion !== data.latestDefinitionVersion,
  );

  function selectPrompt(prompt: AgentPromptView) {
    setSelectedPrompt(prompt.key);
    setDraft(prompt.content);
    draftRef.current = prompt.content;
    setError('');
  }

  async function savePrompt() {
    if (!selected || saving) return;
    setSaving(true);
    setError('');
    try {
      const content = draftRef.current;
      await api('/api/agent-context/prompts', {
        method: 'PUT',
        body: JSON.stringify({ key: selected.key, content }),
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

  async function setPromptDefault() {
    if (!selected || saving) return;
    setSaving(true);
    setError('');
    try {
      const content = draftRef.current;
      await api('/api/agent-context/prompts/default', {
        method: 'PUT',
        body: JSON.stringify({ key: selected.key, content }),
      });
      await load();
      toast(`已将 ${selected.title} 设为默认；下一轮生效`, 'success');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function clearPromptDefault() {
    if (!selected || saving) return;
    setSaving(true);
    setError('');
    try {
      await api('/api/agent-context/prompts/default/reset', {
        method: 'POST',
        body: JSON.stringify({ key: selected.key }),
      });
      await load();
      toast(`已恢复 ${selected.title} 的内置默认`, 'success');
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
      <section className="agent-context-page" aria-label="Agent 上下文" data-testid="agent-context-drawer">
            <header className="agent-context-head">
              <div>
                <h2>Agent 上下文</h2>
                <p>这里展示模型实际收到的 system prompt（在发出请求时记录，不做二次渲染），以及可编辑来源与实际工具视图；保存后从下一轮生效。</p>
              </div>

            </header>
            <div className="agent-context-body">
              <nav className="agent-context-tabs" role="tablist" aria-label="Agent 上下文页面">
                <button type="button" role="tab" data-testid="agent-context-tab-sent" data-active={tab === 'sent'} aria-selected={tab === 'sent'} onClick={() => setTab('sent')}>
                  实际发出的 Prompt
                </button>
                <button type="button" role="tab" data-testid="agent-context-tab-prompts" data-active={tab === 'prompts'} aria-selected={tab === 'prompts'} onClick={() => setTab('prompts')}>
                  可编辑来源 <span>{data?.prompts.length ?? 0}</span>
                </button>
                <button type="button" role="tab" data-testid="agent-context-tab-tools" data-active={tab === 'tools'} aria-selected={tab === 'tools'} onClick={() => setTab('tools')}>
                  工具与能力 <span>{data?.tools.length ?? 0}</span>
                </button>
              </nav>
              {error && <div className="form-error">{error}</div>}
              <div className="agent-preview-panel" data-testid="agent-context-sent">
                <div className="agent-preview-meta">
                  <span>当前会话 <code>{data?.definitionVersion ?? '未配置'}</code></span>
                  {definitionChanged && <span>最新编译 <code>{data?.latestDefinitionVersion}</code></span>}
                  <span>源码 Docs <code>{data?.docsRoot}</code></span>
                </div>
                {definitionChanged && (
                  <div className="agent-preview-notice" data-testid="agent-preview-definition-notice">
                    当前会话已绑定 <code>{data?.definitionVersion}</code>；新编译的 <code>{data?.latestDefinitionVersion}</code> 会用于新建会话，不会热替换正在运行的 Pi session。
                  </div>
                )}
                <RecordedPromptPanel
                  testId="agent-context-sent"
                  text={data?.sent?.text ?? null}
                  tools={data?.sent?.tools ?? null}
                  emptyText="本次会话尚未记录到已发出的请求：只有真正发起过模型请求的会话才有这一份。"
                />
              </div>
              {loading ? <Spinner label="正在读取 Agent 上下文…" /> : tab === 'prompts' ? (
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
                            {prompt.customized
                              ? <Pill tone="accent">自定义</Pill>
                              : prompt.defaultCustomized
                                ? <Pill tone="success">自定义默认</Pill>
                                : null}
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
                          onChange={event => {
                            setDraft(event.target.value);
                            draftRef.current = event.target.value;
                          }}
                          rows={20}
                          spellCheck={false}
                        />
                        <div className="agent-context-actions">
                          <span className="muted">支持 `{'{{models}}'}`、`{'{{requirementVersion}}'}` 等运行时变量；实时系统状态通过 `read_system_capabilities` 按需读取。</span>
                          <span className="agent-context-action-buttons">
                            {selected.defaultCustomized && (
                              <Button size="sm" icon="refresh" disabled={saving} onClick={() => void clearPromptDefault()}>恢复内置</Button>
                            )}
                            <Button size="sm" icon="refresh" disabled={saving} onClick={() => void resetPrompt()}>恢复默认</Button>
                            <Button size="sm" icon="spark" disabled={saving} onClick={() => void setPromptDefault()}>设为默认</Button>
                            <Button variant="primary" size="sm" icon="check" disabled={saving} onClick={() => void savePrompt()}>
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
      </section>
    </>
  );
}
