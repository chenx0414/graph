/**
 * The node chat tab: one graph node's subagent, opened as its own window.
 *
 * Two things live here and nothing else: what the node was actually told (its
 * injected system prompt and the briefing its session carries, both read back
 * from the ledger and the session file rather than recomputed), and its own
 * transcript. Usage, capability lists, context provenance and the
 * operation ledger used to sit next to them; they are deliberately gone - the
 * graph and the task records are where that belongs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.ts';
import { AgentNodeChat } from './AgentNodeChat.tsx';
import { NODE_LABEL } from './labels.ts';
import type { NodeConfigurations } from './kernel-view-types.ts';
import { RecordedPromptPanel } from './PromptPanel.tsx';
import { Button, Icon, Pill, Spinner, Stat, toast } from './ui.tsx';

interface NodePromptView {
  nodeId: string;
  kind: string;
  action: string;
  role: string | null;
  definitionVersion: string | null;
  model: string | null;
  status: string;
  configurations?: NodeConfigurations;
  recorded: { operationId: string; at: number; text: string; tools: string | null } | null;
  briefing: { text: string; sessionFile: string } | null;
  notes: string[];
}

type NodeEnvironment = { revision: number; workspace: string; base: string;
  access: { mode: string; network: string; filesystem: { read: string; write: string } } };

/** What the overview reads: enough to say who this node is and how it is doing. */
interface NodeOverview {
  toolCallCount?: number;
  environment?: NodeEnvironment | null;
  node: { id: string; kind: string; action: string; status: string; definitionVersion?: string };
  instance: { model: string | null; used: number; budget: number | null; unlimited: boolean; authorizedBudget?: { budget: number; unlimited: boolean } | null } | null;
  timing?: { totalMs: number | null; runMs: number | null; waitingMs?: number | null; inProgress?: boolean } | null;
  entryCount: number;
}

/** One transcript entry, as the node's session records it. */
export type { Entry } from './node-transcript.ts';
import type { Entry } from './node-transcript.ts';

/** The node-run payload the transcript reader consumes. */
export interface NodeRun {
  environment?: NodeEnvironment | null;
  taskId: string; nodeId: string;
  node: { id: string; kind: string; action: string; role: string | null; status: string; definitionVersion?: string; input?: unknown };
  instance: { id: string; model: string | null; definitionVersion: string | null; used: number; budget: number | null; unlimited: boolean; modelsUsed: string[] } | null;
  session: { sessionId: string; sessionFile: string | null } | null;
  operations: unknown[]; invocations: unknown[]; questions: unknown[]; evidence: unknown[];
  /** Messages typed while this node was busy, oldest first. */
  queued?: { seq: number; text: string; createdAt?: number }[];
  /** The node's newest settled request: what it wrote and how long the provider took. */
  throughput?: { outputTokens?: number | null; latencyMs?: number | null; tokensPerSecond?: number | null } | undefined;
  entries: Entry[]; entryCount: number; hasOlder: boolean; hasNewer: boolean; phase: string;
}

function roleLabel(role: string | null): string {
  if (role === 'main') return 'main Agent';
  if (role === 'reviewer') return 'reviewer';
  if (role === 'worker') return 'worker';
  return '程序节点';
}

export function NodeChatTab({ taskId, nodeId, agentName }: {
  taskId: string;
  nodeId: string;
  agentName?: string | null;
}) {
  // Display actual send records separately from the next configured turn.
  const [prompt, setPrompt] = useState<NodePromptView | null>(null);
  // The window is named after the agent that runs the node, and only the graph knows that name.
  const [named, setNamed] = useState<string | null>(agentName ?? null);
  const [overview, setOverview] = useState<NodeOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const promptRequest = useRef(0);
  const refreshPrompt = useCallback(async () => {
    const request = ++promptRequest.current;
    try {
      const view = await api<NodePromptView>(`/api/tasks/${taskId}/nodes/${encodeURIComponent(nodeId)}/prompt`);
      if (request === promptRequest.current) { setPrompt(view); setError(''); }
    } catch (reason) {
      if (request === promptRequest.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request === promptRequest.current) setLoading(false);
    }
  }, [taskId, nodeId]);
  const updateRun = useCallback((run: NodeRun) => {
    setOverview(run);
    void refreshPrompt();
  }, [refreshPrompt]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void api<NodeOverview>(`/api/tasks/${taskId}/nodes/${encodeURIComponent(nodeId)}/run`)
      .then(view => { if (!cancelled) setOverview(view); })
      .catch(() => { if (!cancelled) setOverview(null); });
    if (!agentName) {
      void api<{ nodes: { id: string; agent?: { name?: string } }[] }>(`/api/tasks/${taskId}/graph`)
        .then(payload => {
          const name = payload.nodes.find(node => node.id === nodeId)?.agent?.name;
          if (!cancelled && name) setNamed(name);
        })
        .catch(() => {});
    }
    void refreshPrompt();
    return () => { cancelled = true; promptRequest.current += 1; };
  }, [taskId, nodeId, refreshPrompt]);

  async function copyBriefing() {
    if (!prompt?.briefing) return;
    try {
      await navigator.clipboard.writeText(prompt.briefing.text);
      toast('简报已复制', 'success');
    } catch (reason) {
      toast(`复制失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    }
  }

  const duration = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value)
    ? '未记录'
    : value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;

  const contextControl = (
      <details className="node-prompt-card node-prompt-popover" data-testid="node-context">
        <summary className="node-prompt-summary" title="节点上下文" aria-label="节点上下文"><Icon name="overview" size={16} /></summary>
        <div className="node-prompt-popover-panel">
        <div className="node-prompt-popover-heading"><strong>节点上下文</strong><span>身份、环境与运行数据</span></div>
        {overview ? (
          <section className="stack node-overview" data-testid="node-overview" style={{ gap: 8 }}>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <Pill tone="accent">{overview.node.kind}</Pill>
              <span className="muted mono" data-testid="node-identity">{overview.node.id}</span>
              <Pill tone={overview.node.status === 'succeeded' ? 'success' : overview.node.status === 'failed' ? 'danger' : overview.node.status === 'running' ? 'accent' : 'neutral'}>
                {NODE_LABEL[overview.node.status] ?? overview.node.status}
              </Pill>
              {overview.node.definitionVersion && <span className="muted">{overview.node.definitionVersion}</span>}
              {overview.instance?.model && <span className="muted mono">{overview.instance.model}</span>}
            </div>
            {overview.node.action && <p className="node-action" data-testid="node-action">{overview.node.action}</p>}
            {overview.environment && <div className="stack" data-testid="node-environment">
              <span>工作目录：<span className="mono">{overview.environment.workspace}</span></span>
              <span className="muted">实际权限：{overview.environment.access.mode === 'full' ? '完全访问' : '受限访问'} · 读取 {overview.environment.access.filesystem.read} · 写入 {overview.environment.access.filesystem.write} · 网络 {overview.environment.access.network} · 配置 v{overview.environment.revision}</span>
            </div>}
            <div className="stat-grid">
              <Stat label="运行" value={duration(overview.timing?.runMs ?? null)} hint="执行时段之和（不含名额等待）" />
              <Stat label="等待名额" value={duration(overview.timing?.waitingMs ?? null)} hint="凭据与执行名额等待之和" />
              <Stat label="工具调用" value={overview.toolCallCount === undefined ? '未记录' : overview.toolCallCount.toLocaleString('en-US')} hint="累计实际调用次数（含失败调用）" />
              <Stat label="总历时" value={duration(overview.timing?.totalMs ?? null)} hint="已结算执行的历时之和" />
              <Stat
                label="用量"
                value={overview.instance ? overview.instance.used.toLocaleString('en-US') : '未记录'}
                hint={overview.instance?.unlimited ? '额度不限' : overview.instance?.budget === null || overview.instance?.budget === undefined ? '预算尚无记录' : `预算 ${overview.instance.budget.toLocaleString('en-US')}`}
              />
              <Stat label="用户授权" value={overview.instance?.authorizedBudget ? overview.instance.authorizedBudget.unlimited ? '不限' : overview.instance.authorizedBudget.budget.toLocaleString('en-US') : '继承默认'} hint="下次执行重新校验" />
              <Stat label="记录" value={overview.entryCount} hint="该节点会话条目数" />
            </div>
          </section>
        ) : <span className="muted">{loading ? '正在读取…' : '没有这个节点的运行记录。'}</span>}
        </div>
      </details>
  );

  const promptControl = (
      <details className="node-prompt-card node-prompt-popover" data-testid="node-prompt">
        <summary className="icon-button node-prompt-summary" title="System prompt" aria-label="System prompt"><Icon name="spark" size={16} /></summary>
        <div className="node-prompt-popover-panel">
        <div className="node-prompt-popover-heading"><strong>System prompt</strong><span>该节点实际注入的上下文与简报</span></div>
        {loading && !prompt ? <Spinner label="正在读取…" />
          : error ? <div className="form-error" data-testid="node-prompt-error">{error}</div>
            : prompt ? (
              <div className="stack" style={{ gap: 8 }}>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <span data-testid="node-prompt-role">
                    <Pill tone="accent">{roleLabel(prompt.role)}</Pill>
                  </span>
                  {prompt.definitionVersion && <span className="muted">{prompt.definitionVersion}</span>}
                  {prompt.model && <span className="muted">{prompt.model}</span>}
                </div>
                {prompt.configurations && (
                  <div className="stack" data-testid="node-configurations">
                    <span>当前执行配置：{prompt.configurations.current?.definition.recipe ?? '尚未执行'}</span>
                    <span>下一次执行配置：{prompt.configurations.next?.definition.recipe ?? '节点已移除'}{prompt.configurations.pending ? '（有待生效修改）' : ''}</span>
                    {prompt.configurations.pending && <details><summary>下一次执行的声明</summary><pre>{JSON.stringify(prompt.configurations.next, null, 2)}</pre></details>}
                  </div>
                )}
                {prompt.notes.length > 0 && (
                  <ul className="list" data-testid="node-prompt-notes">
                    {prompt.notes.map(note => <li key={note} className="muted">{note}</li>)}
                  </ul>
                )}
                <RecordedPromptPanel
                  testId="node-prompt-sent"
                  text={prompt.recorded?.text ?? null}
                  tools={prompt.recorded?.tools ?? null}
                  emptyText="台账里没有这个节点的发送记录。"
                />
                {prompt.briefing && (
                  <div className="agent-preview-panel" data-testid="node-briefing">
                    <div className="agent-preview-meta">
                      <strong>简报（该节点会话的第一条 user 消息）</strong>
                      <span>{`${prompt.briefing.text.length.toLocaleString()} 字符`}</span>
                      <Button size="sm" icon="file" onClick={() => void copyBriefing()}>复制简报</Button>
                    </div>

                    <pre className="agent-preview-markdown" data-testid="node-briefing-text">{prompt.briefing.text}</pre>
                  </div>
                )}
              </div>
            ) : null}
        </div>
      </details>
  );
  return (
    <div className="conversation-page window-fill" data-testid="node-chat-tab">
      {/* The tab bar owns the title; the prompt lives in its top-right control. */}
      {document.getElementById('conversation-toolbar') && createPortal(<div className="conversation-toolbar-content">{contextControl}{promptControl}</div>, document.getElementById('conversation-toolbar')!)}
      <div className="conversation-body" data-view="node">
        <div className="conversation-main">
      <AgentNodeChat taskId={taskId} nodeId={nodeId} agentName={named ?? nodeId} onRunUpdate={updateRun} page />
        </div>
      </div>
    </div>
  );
}
