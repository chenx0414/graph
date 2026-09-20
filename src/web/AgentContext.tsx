import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.ts';
import { Button, Icon, Pill, Spinner, toast } from './ui.tsx';

export interface AgentPromptView {
  key: string;
  title: string;
  description: string;
  file: string;
  content: string;
  customized: boolean;
}

export interface AgentToolView {
  name: string;
  description: string;
  source: string;
  enabled: boolean;
}

export interface AgentContextView {
  root: string;
  definitionVersion: string | null;
  prompts: AgentPromptView[];
  disabledTools: string[];
  tools: AgentToolView[];
}

export function AgentContextBar({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'prompts' | 'tools'>('prompts');
  const [data, setData] = useState<AgentContextView | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [disabled, setDisabled] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
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
  };

  useEffect(() => {
    let active = true;
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
    return () => { active = false; };
  }, [conversationId]);

  const selected = data?.prompts.find(prompt => prompt.key === selectedPrompt) ?? null;
  const enabledTools = useMemo(() => data?.tools.filter(tool => !disabled.includes(tool.name)).length ?? 0, [data, disabled]);
  const customized = data?.prompts.filter(prompt => prompt.customized).length ?? 0;

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
      setData(current => current ? { ...current, disabledTools: saved.disabledTools, tools: current.tools.map(tool => ({ ...tool, enabled: !saved.disabledTools.includes(tool.name) })) } : current);
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
      <section className="agent-context-bar" data-testid="agent-context-bar">
        <button
          type="button"
          className="agent-context-summary"
          data-testid="agent-context-open"
          onClick={() => setOpen(true)}
        >
          <span className="agent-context-summary-icon"><Icon name="spark" size={14} /></span>
          <span>
            <strong>Agent 上下文</strong>
            <small>
              {data ? `${data.prompts.length} 层 Prompt · ${enabledTools}/${data.tools.length} 个工具可用` : '正在读取…'}
              {customized ? ` · ${customized} 个自定义` : ''}
            </small>
          </span>
          <Icon name="chevron" size={14} />
        </button>
      </section>

      {open && createPortal(
        <div className="agent-context-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
          <aside className="agent-context-drawer" role="dialog" aria-modal="true" aria-label="Agent Prompt 与工具" data-testid="agent-context-drawer">
            <header className="agent-context-head">
              <div>
                <h2>Agent Prompt 与工具</h2>
                <p>统一管理注入给 Main Agent 和 Pi 的指令。保存后从下一轮开始生效。</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="关闭"><Icon name="close" size={16} /></button>
            </header>
            <div className="agent-context-body">
              <nav className="agent-context-tabs" role="tablist" aria-label="Agent 上下文页面">
                <button type="button" role="tab" data-active={tab === 'prompts'} aria-selected={tab === 'prompts'} onClick={() => setTab('prompts')}>
                  Prompt <span>{data?.prompts.length ?? 0}</span>
                </button>
                <button type="button" role="tab" data-testid="agent-context-tab-tools" data-active={tab === 'tools'} aria-selected={tab === 'tools'} onClick={() => setTab('tools')}>
                  工具 <span>{data?.tools.length ?? 0}</span>
                </button>
              </nav>
              {error && <div className="form-error">{error}</div>}
              {loading ? <Spinner label="正在读取 Agent 上下文…" /> : tab === 'prompts' ? (
                <div className="agent-prompt-layout">
                  <div className="agent-prompt-list" data-testid="agent-prompt-list">
                    {data?.prompts.map(prompt => (
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
                          <span className="muted">支持 `{'{{models}}'}`、`{'{{requirementVersion}}'}`、`{'{{selfModelSection}}'}` 等运行时变量。</span>
                          <Button variant="primary" size="sm" icon="check" disabled={saving || !draft.trim()} onClick={() => void savePrompt()}>
                            {saving ? '保存中…' : '保存 Prompt'}
                          </Button>
                        </div>
                      </>
                    ) : <p className="muted">没有可编辑的 Prompt。</p>}
                  </div>
                </div>
              ) : (
                <div className="agent-tool-panel" data-testid="agent-tool-panel">
                  <div className="agent-tool-panel-head">
                    <p>关闭工具只会从 Main Agent 的工具清单中移除；权限、预算和审计规则保持不变。</p>
                    <Button size="sm" variant="primary" icon="check" disabled={saving} onClick={() => void saveTools()}>保存工具选择</Button>
                  </div>
                  <div className="agent-tool-list">
                    {data?.tools.map(tool => (
                      <label className="agent-tool-row" key={tool.name} data-enabled={!disabled.includes(tool.name)}>
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
                        </span>
                        <Pill tone="neutral">{tool.source}</Pill>
                      </label>
                    ))}
                    {!data?.tools.length && <p className="muted">首次运行 Main Agent 后会显示完整工具清单。</p>}
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
