


import { useEffect,useState } from 'react';

import { AgentNodeChat } from './AgentNodeChat.tsx';












import { formatTokens } from './insights.ts';


import './conversation-drawer.css';

import { NODE_LABEL } from './labels.ts';

import { GraphCanvas } from './GraphCanvas.tsx';




import { Button,Icon,Pill,Spinner,StatusDot } from './ui.tsx';


import type { DraftGraph,ProposalDetail,ProposalVersion } from "./conversation-types.tsx";
import { NODE_TONE } from "./conversation-types.tsx";

export function DraftVersionToc({ history, selectedVersion, onSelectVersion }: {
  history: ProposalVersion[];
  selectedVersion: number | null;
  onSelectVersion: (version: number) => void;
}) {
  if (history.length <= 1) return null;
  return (
    <div className="draft-toc" data-testid="drawer-draft-toc" aria-label="草稿版本">
      <span className="draft-toc-label">草稿</span>
      <div className="draft-toc-scroll">
        {history.map(item => (
          <button
            key={item.version}
            type="button"
            className="draft-toc-item"
            data-testid={`drawer-draft-version-${item.version}`}
            data-active={item.version === selectedVersion}
            onClick={() => onSelectVersion(item.version)}
            title={item.summary}
            aria-pressed={item.version === selectedVersion}
          >
            v{item.version}
            {item.stale && <span className="draft-toc-state">过期</span>}
            {item.accepted && <span className="draft-toc-state">已确认</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function graphDuration(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未记录';
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
}

export function graphCapabilityLabel(kind: string | null) {
  if (kind === 'skill') return 'Skills';
  if (kind === 'mcp') return 'MCP';
  if (kind === 'pi-extension' || kind === 'extension') return 'Pi extensions';
  if (kind === 'prompt') return 'Agent.md';
  return '能力';
}

export function ConversationGraphBoard({
  proposal,
  graph,
  graphLoading,
  selectedNodeId,
  runtimeTaskId,
  state,
  onSelectNode,
}: {
  proposal: ProposalDetail;
  graph: DraftGraph | null;
  graphLoading: boolean;
  selectedNodeId: string | null;
  runtimeTaskId: string | null;
  state: { taskCount: number; evidenceCount: number; used: number; budget: number | null; unlimited?: boolean; openQuestions: number };
  onSelectNode: (nodeId: string | null) => void;
}) {
  const selectedNode = graph?.nodes.find(node => node.id === selectedNodeId) ?? null;
  const [chatNodeId, setChatNodeId] = useState<string | null>(null);
  const chatNode = graph?.nodes.find(node => node.id === chatNodeId) ?? null;

  useEffect(() => {
    setChatNodeId(null);
  }, [selectedNodeId]);

  return (
    <div className="conversation-graph-main" data-testid="conversation-graph">
      <header className="conversation-graph-header">
        <div className="conversation-graph-heading">
          <div className="drawer-eyebrow">草稿任务图</div>
          <h2 data-testid="conversation-graph-title">{proposal.spec.summary}</h2>
          <div className="conversation-graph-meta">
            <span>v{proposal.version}</span>
            <span>{graph?.nodes.length ?? (Object.keys(proposal.spec.definition.nodes).length + Object.keys(proposal.spec.definition.modules).length)} 个节点</span>
            <span>{proposal.spec.acceptance.length} 个验收项</span>
            {proposal.stale && <Pill tone="warn">需求已变化</Pill>}
          </div>
        </div>
      </header>
      <div className="conversation-graph-stage">
        <aside
          className="graph-state-summary"
          data-testid="graph-state-summary"
          title="任务级权威状态保存在 SQLite 账本中；节点通过具名接口接收投递，共享产物按已发布版本读取。"
        >
          <span className="graph-state-symbol">S</span>
          <div className="graph-state-copy">
            <strong>任务状态</strong>
            <span>
              {state.taskCount} 个任务 · {state.evidenceCount} 条有效证据 · {formatTokens(state.used)} tokens · 预算 {state.unlimited || state.budget === null ? '不限' : formatTokens(state.budget)}
              {state.openQuestions > 0 ? ` · ${state.openQuestions} 个等你回答` : ''}
            </span>
          </div>
        </aside>
        {graphLoading && <div className="drawer-loading conversation-graph-empty"><Spinner label="正在加载任务图…" /></div>}
        {!graphLoading && graph && graph.nodes.length > 0 && (
          <div className="conversation-graph-canvas" data-testid="draft-graph-detail">
            <GraphCanvas
              taskId={runtimeTaskId}
              graph={{ nodes: graph.nodes, containers: graph.containers, layout: graph.layout, ...(graph.interfaces ? { interfaces: graph.interfaces } : {}) }}
              collapsed={{}}
              selected={selectedNodeId}
              onSelect={id => onSelectNode(id === selectedNodeId ? null : id)}
            />
          </div>
        )}
        {!graphLoading && (!graph || graph.nodes.length === 0) && (
          <div className="conversation-graph-empty" data-testid="draft-graph-empty">
            <Icon name="graph" size={22} />
            <strong>暂无任务图</strong>
            <span>这个草稿还没有可展示的节点。</span>
          </div>
        )}
        {selectedNode && (
          <aside className="graph-node-inspector" data-testid="conversation-node-detail">
            <div className="graph-node-inspector-head">
              <div className="grow">
                <div className="drawer-eyebrow">{selectedNode.kind === 'agent' ? 'Agent 节点' : selectedNode.kind === 'module' ? '功能模块' : '程序节点'}</div>
                <h3>{selectedNode.id}</h3>
              </div>
              {selectedNode.kind === 'agent' && selectedNode.agent && (
                <Button
                  size="sm"
                  icon="message"
                  data-testid="open-agent-chat"
                  onClick={() => setChatNodeId(selectedNode.id)}
                >
                  对话
                </Button>
              )}
              <button type="button" className="icon-button" onClick={() => onSelectNode(null)} title="关闭节点详情" aria-label="关闭节点详情">
                <Icon name="close" size={15} />
              </button>
            </div>
            <div className="row" style={{ marginBottom: 12 }}>
              <StatusDot tone={NODE_TONE[selectedNode?.status ?? ''] ?? 'neutral'} />
              <span>{NODE_LABEL[selectedNode?.status ?? ''] ?? selectedNode?.status ?? '草稿'}</span>
            </div>
            {selectedNode.inputs && <section><h4>传入接口</h4><pre>{JSON.stringify(selectedNode.inputs, null, 2)}</pre></section>}
            {selectedNode.outputs && <section><h4>传出接口</h4><pre>{JSON.stringify(selectedNode.outputs, null, 2)}</pre></section>}
            {selectedNode.kind === 'agent' && selectedNode.agent ? (
              <>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  <Pill tone="accent">独立会话</Pill>
                  <Pill tone="neutral">{selectedNode.agent.recommendedGrade}</Pill>
                  {selectedNode.agent.review && <Pill tone="warn">独立审查</Pill>}
                </div>
                <dl className="kv">
                  <dt>Subagent</dt><dd>{selectedNode.agent.name} <span className="muted mono">{selectedNode.agent.id}@{selectedNode.agent.version}</span></dd>
                  <dt>动作</dt><dd className="mono">{selectedNode.action ?? '—'}</dd>
                  <dt>模型</dt><dd className="mono">{selectedNode.model ?? '—'}</dd>
                  <dt>容器</dt><dd className="mono">{selectedNode.container ?? '—'}</dd>
                </dl>
                <section className="graph-agent-detail-section" data-testid="graph-agent-capabilities">
                  <h4>能力</h4>
                  {['prompt', 'skill', 'mcp', 'pi-extension'].map(kind => {
                    const resources = selectedNode.agent!.capabilities.filter(item =>
                      kind === 'pi-extension' ? item.kind === 'pi-extension' || item.kind === 'extension' : item.kind === kind);
                    if (!resources.length) return null;
                    return (
                      <div className="graph-agent-capability-group" key={kind}>
                        <span className="faint">{graphCapabilityLabel(kind)}</span>
                        <div className="chip-row">
                          {resources.map(resource => <Pill key={`${resource.id}@${resource.version}`} tone="neutral">{resource.name}</Pill>)}
                        </div>
                      </div>
                    );
                  })}
                  {!selectedNode.agent.capabilities.length && <p className="muted">未绑定能力。</p>}
                </section>
                <section className="graph-agent-detail-section" data-testid="graph-agent-experience">
                  <h4>工作经历</h4>
                  <p className="muted">
                    平均消耗 {selectedNode.agent.experience.task.token.mean === null
                      ? '未知'
                      : `${formatTokens(selectedNode.agent.experience.task.token.mean)} tokens`}
                    {' · '}
                    平均耗时 {graphDuration(selectedNode.agent.experience.task.runMs.mean)}
                    {' · '}
                    {selectedNode.agent.experience.task.totalSamples} 次任务样本
                  </p>
                  {selectedNode.agent.experience.samples.length > 0 && (
                    <ul className="list compact-list">
                      {selectedNode.agent.experience.samples.map(sample => (
                        <li className="list-item" key={`${sample.taskId}:${sample.nodeId}`}>
                          <span className="grow truncate">{sample.request ?? sample.nodeId}</span>
                          <span className="muted">{sample.status} · {sample.tokens === null ? 'token 未知' : `${formatTokens(sample.tokens)} tokens`} · {graphDuration(sample.runMs)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="graph-agent-detail-section" data-testid="graph-agent-instructions">
                  <h4>灌输的指令</h4>
                  <p>{selectedNode.action}</p>
                  <p className="muted">节点首次接收输入时开始执行；后续投递排队执行，沿用自己的聊天历史。</p>
                  {selectedNode.agent.capabilities.filter(item => item.role === 'agent' || item.role === 'tool').length > 0 && (
                    <p className="muted">Prompt：{selectedNode.agent.capabilities.filter(item => item.role === 'agent' || item.role === 'tool').map(item => item.name).join('、')}</p>
                  )}
                </section>
              </>
            ) : (
              <>
                <dl className="kv">
                  <dt>类型</dt><dd>{selectedNode.kind}</dd>
                  <dt>动作</dt><dd className="mono">{selectedNode.action ?? '—'}</dd>
                  <dt>定义</dt><dd className="mono">{selectedNode.definitionVersion ?? '—'}</dd>
                  <dt>模型</dt><dd className="mono">{selectedNode.model ?? '—'}</dd>
                  <dt>容器</dt><dd className="mono">{selectedNode.container ?? '—'}</dd>
                </dl>
              </>
            )}
          </aside>
        )}
        {chatNode?.agent && (
          <AgentNodeChat
            taskId={runtimeTaskId}
            nodeId={chatNode.id}
            agentName={chatNode.agent.name}
            onClose={() => setChatNodeId(null)}
          />
        )}
      </div>
    </div>
  );
}
