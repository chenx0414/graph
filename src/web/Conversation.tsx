import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AgentNodeChat } from './AgentNodeChat.tsx';
import { AgentContextBar, type AgentContextView } from './AgentContext.tsx';
import { api } from './api.ts';
import { ArtifactWorkspace } from './ArtifactWorkspace.tsx';
import { ChatComposer, type ChatAttachment } from './ChatComposer.tsx';
import { attachmentPayload } from './attachments.ts';
import {
  cancelQueuedMessage,
  composerPrimaryDisabled,
  composerPrimaryState,
  readComposerDraft,
  shouldScrollToLatest,
  visibleTranscriptMessages,
  writeComposerDraft,
  type ComposerStorage,
} from './composer-state.ts';
import { markdownEnabled, usePreferences, visibleSuggestion } from './preferences.ts';
import { ComposerTelemetry, type ThinkingLevel } from './ComposerTelemetry.tsx';
import { composeSlashDirective, extractSlashTargets } from './SlashCommands.tsx';
import {
  applyConversationEvent,
  conversationProjectionSnapshot,
  createConversationProjection,
  messageAttachments,
  observeConversationHistory,
  observeConversationView,
  type ConversationMessage,
} from '../core/conversation-projection.ts';
import { formatTokens } from './insights.ts';
import {
  DRAWER_DRAFT_PAGES,
  defaultDrawerOpen,
  defaultDrawerPage,
  drawerEntryAriaLabel,
  drawerEntryLabel,
  drawerInitPanelIds,
  drawerPanelIds,
  draftStatusLabel,
  isResidentPanel,
  residentPanelIds,
  resolveDrawerSection,
  type ConversationDrawerPage,
  type ConversationDrawerSection,
  type DraftStatus,
} from './conversation-drawer.ts';
import './conversation-drawer.css';
import { NODE_LABEL, TASK_LABEL, describeQuestion } from './labels.ts';
import { GraphCanvas } from './GraphCanvas.tsx';
import { QuestionReply } from './Questions.tsx';
import { ErrorBox, costText, useAsync, useEventStream, useTargetBranch } from './shared.tsx';
import { TranscriptRowView } from './TranscriptRows.tsx';
import { Button, Icon, Pill, Spinner, StatusDot, toast } from './ui.tsx';
import { buildTranscriptRows } from './transcript-model.ts';
import { useTranscriptFollow } from './use-transcript-follow.ts';

type Settings = { projects: { id: string; root: string; branch?: string | null; preparation?: { branch?: string | null } | null }[]; models: { id: string; grade: string; credentialId?: string; reasoning?: boolean }[] };
export type ConversationSummary = {
  id: string; title: string; projectId: string | null; anchorTaskId: string; createdAt: number; updatedAt: number | null;
  openQuestions: number; taskCount: number; status: string;
};
type ConversationNode = { id: string; kind: string; role: string | null; status: string; used: number | null; budget: number | null; unlimited?: boolean; model: string | null; definitionVersion: string | null; stallCount: number; outputVersion: number };
type ConversationTask = {
  id: string; request: string; phase: string; status: string; paused: boolean; targetBranch: string | null;
  acceptedProposalVersion: number | null; integrationSha: string | null;
  openQuestions: { id: string; nodeId: string; kind: string; data: Record<string, unknown> }[];
  nodes: ConversationNode[];
  cost: { unknown?: boolean; amount?: number };
  evidence: { acceptanceId: string; valid: boolean }[];
};
export type GraphAgentDetail = {
  id: string;
  version: number;
  name: string;
  description: string | null;
  recommendedGrade: string;
  review: boolean;
  capabilities: {
    id: string;
    version: string;
    role: string;
    kind: string | null;
    name: string;
    status: string;
    source: string | null;
  }[];
  experience: {
    task: {
      token: { mean: number | null; samples: number; unknown: number; unfinished: number; failed: number };
      runMs: { mean: number | null; samples: number; unknown: number; unfinished: number; failed: number };
      totalSamples: number;
    };
    samples: {
      taskId: string; nodeId: string; request: string | null; status: string;
      tokens: number | null; runMs: number | null; reworkRounds: number; failed: boolean;
    }[];
  };
};
type DraftGraph = {
  nodes: {
    id: string; kind: string; status: string; container?: string;
    action?: string; definitionVersion?: string; model?: string; dependsOn?: string[];
    context?: {
      purpose?: string; sourceNode?: string; independence?: string; reason?: string;
      requiredFacts?: { kind?: string }[];
      predecessors?: { source?: string; mode?: string }[];
    } | null;
    contextMode?: 'fresh' | 'fork' | null;
    agent?: GraphAgentDetail | null;
  }[];
  containers: { id: string; parent?: string }[];
  loops: { from: string; to: string }[];
  layout: { positions: Record<string, { x: number; y: number; width: number; height: number }>; edges: { id: string; source: string; target: string }[] };
};
type ProposalDetail = {
  version: number;
  requirementVersion: number;
  stale: boolean;
  decisions: string | null;
  spec: {
    summary: string;
    acceptance: { id: string; description: string; checkNode: string }[];
    nodes: { id: string; kind: string; action?: string; definitionVersion?: string; model?: string; dependsOn?: string[]; container?: string; input?: unknown }[];
    loops?: { from: string; to: string }[];
  };
};
type ProposalVersion = {
  version: number;
  requirementVersion: number;
  stale: boolean;
  summary: string;
  accepted: boolean;
};
type DrawerPage = ConversationDrawerPage;
type ConversationTab = 'chat' | 'artifacts';

/** `data-resident` marker for a main-column entry that stays visible even with
 * the drawer shut. Keeps the resident list single-sourced in the policy module. */
function residentFlag(id: string): 'true' | undefined {
  return isResidentPanel(id) ? 'true' : undefined;
}
type AnchorQuestion = { id: string; nodeId: string; operationId: string | null; kind: string; status: string; owner?: string; data: Record<string, unknown>; answer: Record<string, unknown> | null; taskId: string };
type ConversationView = {
  id: string; title: string; projectId: string | null; projectRoot: string | null; workspaceProjectId: string; anchorTaskId: string;
  createdAt: number; requirementVersion: number; paused: boolean;
  messages: ConversationMessage[]; messageCount: number;
  streams: {
    operationId: string; entryId: string; partId: string; text: string; length: number; updatedAt: number;
  }[];
  questions: AnchorQuestion[];
  proposal: ProposalDetail | null;
  proposalHistory: ProposalVersion[];
  accepted: { proposalVersion: number; taskId: string; targetBranch: string; acceptedAt: number }[];
  master: { nodeId: string; status: string; model: string | null; used: number | null; budget: number | null; unlimited?: boolean; definitionVersion: string | null; cost: { unknown?: boolean; amount?: number } } | null;
  cost: { unknown?: boolean; amount?: number };
  usage: { used: number; budget: number | null; unlimited?: boolean };
  telemetry?: {
    model: string | null;
    thinkingLevel: string;
    cacheHitRate: number | null;
    cachedInput: number;
    cacheInput: number;
    contextTokens: number | null;
    contextLimit: number | null;
    contextPercent: number | null;
  };
  tasks: ConversationTask[];
  cursor: number;
};
const TASK_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'> = {
  discussing: 'info', running: 'accent', queued: 'neutral', paused: 'warn', pausing: 'warn',
  blocked: 'warn', completed: 'success', failed: 'danger', skipped: 'neutral', abandoned: 'danger',
};
const NODE_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'> = {
  pending: 'neutral', ready: 'info', preparing: 'accent', running: 'accent',
  succeeded: 'success', failed: 'danger', blocked: 'warn', skipped: 'neutral',
};

/** `window.localStorage` can throw when the host blocks storage. */
function composerStorage(): ComposerStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Already-sent user prompts of a conversation, oldest first, for the composer's
 * ↑/↓ history. Briefings and messages that were queued or cancelled were never
 * sent by hand; an immediately repeated prompt collapses into one entry.
 */
function sentUserPrompts(messages: ConversationMessage[]): string[] {
  const prompts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (message.kind === 'briefing') continue;
    if (message.state === 'queued' || message.state === 'cancelled') continue;
    const text = message.text.trim();
    if (!text) continue;
    if (prompts[prompts.length - 1] === text) continue;
    prompts.push(text);
  }
  return prompts;
}

function DraftVersionToc({ history, selectedVersion, onSelectVersion }: {
  history: ProposalVersion[];
  selectedVersion: number;
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

function ProposalDrawer({
  proposal,
  history,
  page,
  selectedVersion,
  graphPanel,
  onSelectVersion,
  onSelectPage,
}: {
  proposal: ProposalDetail;
  history: ProposalVersion[];
  page: Exclude<DrawerPage, 'task'>;
  selectedVersion: number;
  graphPanel: ReactNode;
  onSelectVersion: (version: number) => void;
  onSelectPage: (page: Exclude<DrawerPage, 'task'>) => void;
}) {
  const countFor: Record<Exclude<DrawerPage, 'task'>, number> = {
    acceptance: proposal.spec.acceptance.length,
    nodes: proposal.spec.nodes.length,
    decisions: proposal.decisions?.trim() ? 1 : 0,
    graph: proposal.spec.nodes.length,
  };
  // Tab set and order come from the drawer policy module so the two cannot
  // drift apart.
  const pages = DRAWER_DRAFT_PAGES.map(item => ({ ...item, count: countFor[item.id] }));
  const noDecisions = proposal.decisions === null || !proposal.decisions.trim();
  return (
    <>
      <DraftVersionToc history={history} selectedVersion={selectedVersion} onSelectVersion={onSelectVersion} />
      <nav className="drawer-page-tabs" data-testid="draft-page-tabs" aria-label="草稿详情页面">
        {pages.map(item => (
          <button
            key={item.id}
            type="button"
            className="drawer-page-tab"
            data-testid={`draft-tab-${item.id}`}
            data-active={page === item.id}
            onClick={() => onSelectPage(item.id)}
            aria-current={page === item.id ? 'page' : undefined}
          >
            <span>{item.label}</span>
            {item.count > 0 && <span className="drawer-page-count">{item.count}</span>}
          </button>
        ))}
      </nav>
      <div className="drawer-page-content" data-testid="draft-page-content" data-page={page}>
        {page === 'graph' && (
          <section className="drawer-section drawer-graph-section" data-testid="draft-page-graph">
            {graphPanel}
          </section>
        )}
        {page === 'acceptance' && (
          <section className="drawer-section" data-testid="draft-page-acceptance">
            <div className="drawer-section-head">
              <h3>验收项</h3>
              <span>{proposal.spec.acceptance.length} 项</span>
            </div>
            <ul className="list">
              {proposal.spec.acceptance.map(item => (
                <li className="list-item" key={item.id}>
                  <span className="grow"><strong>{item.id}</strong>：{item.description}</span>
                  <small>检查节点 {item.checkNode}</small>
                </li>
              ))}
            </ul>
          </section>
        )}
        {page === 'nodes' && (
          <section className="drawer-section" data-testid="draft-page-nodes">
            <div className="drawer-section-head">
              <h3>节点</h3>
              <span>{proposal.spec.nodes.length} 个</span>
            </div>
            <ul className="list">
              {proposal.spec.nodes.map(node => (
                <li className="list-item" key={node.id}>
                  <span className="grow">{node.id} · {node.kind}{node.action ? ` · ${node.action}` : ''}</span>
                  <small>{node.model ?? ''}{node.definitionVersion ? ` · ${node.definitionVersion}` : ''}{node.dependsOn?.length ? ` · 依赖 ${node.dependsOn.join(',')}` : ''}</small>
                </li>
              ))}
            </ul>
          </section>
        )}
        {page === 'decisions' && (
          <section className="drawer-section" data-testid="draft-page-decisions">
            <div className="drawer-section-head">
              <h3>决策与约束</h3>
            </div>
            {noDecisions
              ? <p data-testid="draft-decisions-empty" className="muted">主管已声明本任务没有需要传递的决策或约束。</p>
              : <pre>{proposal.decisions}</pre>}
          </section>
        )}
      </div>
    </>
  );
}

function graphDuration(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未记录';
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
}

function graphCapabilityLabel(kind: string | null) {
  if (kind === 'skill') return 'Skills';
  if (kind === 'mcp') return 'MCP';
  if (kind === 'pi-extension' || kind === 'extension') return 'Pi extensions';
  if (kind === 'prompt') return 'Agent.md';
  return '能力';
}

function ConversationGraphBoard({
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
            <span>{proposal.spec.nodes.length} 个节点</span>
            <span>{proposal.spec.acceptance.length} 个验收项</span>
            {proposal.stale && <Pill tone="warn">需求已变化</Pill>}
          </div>
        </div>
      </header>
      <div className="conversation-graph-stage">
        <aside
          className="graph-state-summary"
          data-testid="graph-state-summary"
          title="任务级权威状态保存在 SQLite 账本中；节点通过依赖输入获取状态快照，不共享可变对象。"
        >
          <span className="graph-state-symbol">S</span>
          <div className="graph-state-copy">
            <strong>任务状态</strong>
            <span>
              {state.taskCount} 个任务 · {state.evidenceCount} 条有效证据 · {formatTokens(state.used)} tokens · 预算 {state.unlimited || state.budget === null ? '不限' : formatTokens(state.budget)}
              {state.openQuestions > 0 ? ` · ${state.openQuestions} 个待处理问题` : ''}
            </span>
          </div>
        </aside>
        {graphLoading && <div className="drawer-loading conversation-graph-empty"><Spinner label="正在加载任务图…" /></div>}
        {!graphLoading && graph && graph.nodes.length > 0 && (
          <div className="conversation-graph-canvas" data-testid="draft-graph-detail">
            <GraphCanvas
              graph={{ nodes: graph.nodes, containers: graph.containers, layout: graph.layout }}
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
                <div className="drawer-eyebrow">{selectedNode.kind === 'agent' ? 'Agent 节点' : '程序节点'}</div>
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
            {selectedNode.kind === 'agent' && selectedNode.agent ? (
              <>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  <Pill tone={selectedNode.contextMode === 'fork' ? 'warn' : 'accent'}>{selectedNode.contextMode === 'fork' ? 'Fork' : 'Fresh'}</Pill>
                  <Pill tone="neutral">{selectedNode.agent.recommendedGrade}</Pill>
                  {selectedNode.agent.review && <Pill tone="warn">独立审查</Pill>}
                </div>
                <dl className="kv">
                  <dt>Subagent</dt><dd>{selectedNode.agent.name} <span className="muted mono">{selectedNode.agent.id}@{selectedNode.agent.version}</span></dd>
                  <dt>动作</dt><dd className="mono">{selectedNode.action ?? '—'}</dd>
                  <dt>模型</dt><dd className="mono">{selectedNode.model ?? '—'}</dd>
                  <dt>容器</dt><dd className="mono">{selectedNode.container ?? '—'}</dd>
                  <dt>依赖</dt><dd className="mono">{selectedNode.dependsOn?.join(', ') || '—'}</dd>
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
                  <p className="muted">
                    用途 {selectedNode.context?.purpose ?? '未指定'}
                    {selectedNode.context?.independence ? ` · 独立性 ${selectedNode.context.independence}` : ''}
                    {selectedNode.context?.sourceNode ? ` · 来源 ${selectedNode.context.sourceNode}` : ''}
                  </p>
                  {selectedNode.context?.requiredFacts?.length
                    ? <p className="muted">继承事实：{selectedNode.context.requiredFacts.map(fact => fact.kind ?? '未知').join('、')}</p>
                    : <p className="muted">默认 Fresh 指令；不复制前驱 transcript。</p>}
                  {selectedNode.agent.capabilities.filter(item => item.role === 'agent' || item.role === 'tool').length > 0 && (
                    <p className="muted">Prompt：{selectedNode.agent.capabilities.filter(item => item.role === 'agent' || item.role === 'tool').map(item => item.name).join('、')}</p>
                  )}
                </section>
                <section className="graph-agent-detail-section" data-testid="graph-agent-handoff">
                  <h4>传递的 handoff</h4>
                  {selectedNode.context?.predecessors?.length
                    ? selectedNode.context.predecessors.map(policy => (
                      <p className="muted" key={`${policy.source}:${policy.mode}`}>
                        {policy.source ?? '—'} · {policy.mode === 'result_handoff' ? '结果交接' : '仅证据交接'}
                      </p>
                    ))
                    : <p className="muted">没有声明前驱交接边。</p>}
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
                  <dt>依赖</dt><dd className="mono">{selectedNode.dependsOn?.join(', ') || '—'}</dd>
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

export function ConversationPanel({ id, settings, onChanged, sidebarCollapsed, onSidebarToggle, drawerOpen = defaultDrawerOpen(), onDrawerOpenChange }: {
  id: string;
  settings: Settings | null;
  onChanged?: () => void;
  sidebarCollapsed: boolean;
  onSidebarToggle: () => void;
  drawerOpen?: boolean;
  onDrawerOpenChange: (open: boolean) => void;
}) {
  const { data: view, error, loading, reload } = useAsync(() => api<ConversationView>(`/api/conversations/${id}`), [id]);
  const { data: agentContext } = useAsync(
    () => api<AgentContextView>(`/api/agent-context?conversationId=${encodeURIComponent(id)}`),
    [id],
  );
  const [selectedProposalVersion, setSelectedProposalVersion] = useState<number | null>(null);
  const { data: selectedProposal } = useAsync(
    () => selectedProposalVersion
      ? api<ProposalDetail>(`/api/conversations/${id}/proposals/${selectedProposalVersion}`)
      : Promise.resolve(null),
    [id, selectedProposalVersion],
  );
  const { data: draftGraph, loading: draftGraphLoading } = useAsync(
    () => selectedProposalVersion
      ? api<DraftGraph>(`/api/conversations/${id}/draft-graph?version=${selectedProposalVersion}`)
      : Promise.resolve(null),
    [id, selectedProposalVersion],
  );
  const [text, setText] = useState(() => readComposerDraft(composerStorage(), id));
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [steering, setSteering] = useState(false);
  const [actionError, setActionError] = useState('');
  const [bindId, setBindId] = useState('');
  const { branch, setBranch } = useTargetBranch(settings?.projects ?? null, view?.projectId ?? null);
  const { preferences } = usePreferences();
  const [projection, setProjection] = useState(createConversationProjection);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [drawerSection, setDrawerSection] = useState<ConversationDrawerSection>('draft');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [drawerPage, setDrawerPage] = useState<DrawerPage>(() => defaultDrawerPage());
  const [conversationTab, setConversationTab] = useState<ConversationTab>('chat');
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  const [pauseAction, setPauseAction] = useState<'pause' | 'resume' | null>(null);
  const [pausedOverride, setPausedOverride] = useState<boolean | null>(null);
  const [dismissedQueue, setDismissedQueue] = useState<string[]>([]);
  const busy = view?.master?.status === 'preparing' || view?.master?.status === 'running';
  const transcriptFollow = useTranscriptFollow(conversationTab === 'chat' ? view?.id ?? null : null, Boolean(busy));
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(() => {
    // One event usually means several records changed; coalesce the refetches.
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => reload(), 150);
  }, [reload]);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
  useEffect(() => { writeComposerDraft(composerStorage(), id, text); }, [id, text]);
  const connected = useEventStream(view ? `/api/conversations/${view.id}/events/stream` : null, event => {
    const data = event.data as Parameters<typeof applyConversationEvent>[1]['data'];
    setProjection(current => applyConversationEvent(current, { type: event.type, ...(data ? { data } : {}) }));
    refresh();
  });
  useEffect(() => {
    const latest = view?.accepted.at(-1);
    if (latest?.targetBranch) setBranch(latest.targetBranch);
  }, [view?.accepted]);
  useEffect(() => {
    setPauseAction(null);
    setPausedOverride(null);
    setDismissedQueue([]);
  }, [id]);
  useEffect(() => {
    if (view && pausedOverride !== null && view.paused === pausedOverride) setPausedOverride(null);
  }, [view, pausedOverride]);
  useEffect(() => {
    if (view?.proposal) setSelectedProposalVersion(view.proposal.version);
  }, [view?.proposal?.version]);
  useEffect(() => {
    setSelectedGraphNodeId(null);
  }, [selectedProposalVersion]);
  useEffect(() => {
    if (!view || !drawerOpen) return;
    const resolved = resolveDrawerSection({
      current: drawerSection,
      selectedTaskId,
      taskIds: view.tasks.map(task => task.id),
      hasProposal: Boolean(view.proposal),
    });
    if (resolved.section !== drawerSection) setDrawerSection(resolved.section);
    if (resolved.taskId !== selectedTaskId) setSelectedTaskId(resolved.taskId);
  }, [view, drawerOpen, drawerSection, selectedTaskId]);
  useEffect(() => {
    if (view) setProjection(current => observeConversationView(current, view));
  }, [view]);
  const snapshot = conversationProjectionSnapshot(projection, { busy: Boolean(busy) });
  useEffect(() => {
    if (snapshot.streamNeedsResync) reload();
  }, [reload, snapshot.streamNeedsResync]);
  // Entering a conversation (or reopening the window) starts at the newest
  // message once the transcript window has rendered. Leaving and re-entering
  // the chat tab re-arms the jump without yanking a reader on new arrivals.
  const enteredScrollRef = useRef(false);
  useEffect(() => {
    const jump = shouldScrollToLatest({
      tab: conversationTab,
      hasMessages: snapshot.messages.length > 0,
      alreadyJumped: enteredScrollRef.current,
    });
    if (conversationTab !== 'chat') enteredScrollRef.current = false;
    if (!jump) return;
    enteredScrollRef.current = true;
    const frame = requestAnimationFrame(() => transcriptFollow.scrollToLatest('auto'));
    return () => cancelAnimationFrame(frame);
  }, [conversationTab, snapshot.messages.length, transcriptFollow.scrollToLatest]);
  if (loading && !view) return <p>加载中…</p>;
  if (error && !view) return <ErrorBox message={error} onRetry={reload} />;
  if (!view) return <p>加载中…</p>;

  const acceptedVersions = new Set(view.accepted.map(item => item.proposalVersion));
  const proposal = view.proposal;
  const confirmable = Boolean(proposal && !proposal.stale && !acceptedVersions.has(proposal.version));
  const paused = pausedOverride ?? view.paused;
  const queuedMessages = dismissedQueue.reduce(
    (list, messageId) => cancelQueuedMessage(list, messageId),
    snapshot.queuedMessages,
  );
  // Candidate prompts are an opt-in preference; when off, the composer never
  // shows (nor sends) a suggested next prompt.
  const promptSuggestion = visibleSuggestion(preferences, snapshot.promptSuggestion);
  const hasComposerInput = Boolean(text.trim() || attachments.length);
  const primaryState = composerPrimaryState({
    busy: Boolean(busy),
    paused,
    pending: pauseAction !== null,
    hasInput: hasComposerInput,
    queueLength: queuedMessages.length,
    hasSuggestion: Boolean(promptSuggestion),
  });

  async function act(action: () => Promise<unknown>, after?: () => void) {
    setActionError('');
    try { await action(); after?.(); reload(); onChanged?.(); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function changePaused(nextPaused: boolean) {
    if (pauseAction) return;
    const action = nextPaused ? 'pause' : 'resume';
    setPauseAction(action);
    setActionError('');
    try {
      await api(`/api/conversations/${id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ requestId: crypto.randomUUID() }),
      });
      setPausedOverride(nextPaused);
      toast(
        nextPaused
          ? '主 Agent 对话已暂停。已发出的调用会结束，新消息会排队保留。'
          : '主 Agent 对话已继续，排队消息会开始处理。',
        nextPaused ? 'info' : 'success',
      );
      reload();
      onChanged?.();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setActionError(message);
      toast(message, 'danger');
    } finally {
      setPauseAction(null);
    }
  }
  async function send(outgoingOverride?: string): Promise<boolean> {
    const rawOutgoing = (outgoingOverride ?? text).trim();
    const outgoing = composeSlashDirective(rawOutgoing, extractSlashTargets(
      rawOutgoing,
      agentContext?.tools ?? [],
      agentContext?.capabilities ?? [],
    ));
    const outgoingAttachments = outgoingOverride === undefined ? attachments : [];
    if (!outgoing && !outgoingAttachments.length) return false;
    setText('');
    setAttachments([]);
    setSending(true);
    setActionError('');
    try {
      await api(`/api/conversations/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text: outgoing, attachments: attachmentPayload(outgoingAttachments), requestId: `msg-${crypto.randomUUID()}` }),
      });
      transcriptFollow.scrollToLatest('smooth');
      reload();
      onChanged?.();
      return true;
    } catch (reason) {
      setText(current => current || rawOutgoing);
      setAttachments(current => current.length ? current : outgoingAttachments);
      setActionError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setSending(false);
    }
  }
  async function steerQueued() {
    if (steering || !queuedMessages.length) return;
    setSteering(true);
    setActionError('');
    try {
      const result = await api<{ state: 'empty' | 'queued' | 'steered'; steered: number }>(`/api/conversations/${id}/steer`, {
        method: 'POST',
        body: JSON.stringify({ requestId: `steer-${crypto.randomUUID()}` }),
      });
      if (result.state === 'steered') toast(`已将 ${result.steered} 条队列消息作为打断引导发送给主 Agent。`, 'success');
      else if (result.state === 'queued') toast('当前回复已经结束，队列消息会作为下一轮继续处理。', 'info');
      reload();
      onChanged?.();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setActionError(message);
      toast(message, 'danger');
    } finally {
      setSteering(false);
    }
  }
  async function submitEnter() {
    if (sending || steering) return;
    if (text.trim() || attachments.length) return send();
    if (busy && queuedMessages.length) return steerQueued();
    if (!busy && promptSuggestion) return send(promptSuggestion);
  }

  /** The context-sensitive primary button: pause while the master is
   * outputting, resume when paused, and send + auto-continue when paused with
   * something to send. */
  async function submitPrimary() {
    if (sending || steering || pauseAction) return;
    const action = primaryState.action;
    if (action === 'pause') { await changePaused(true); return; }
    if (action === 'resume') { await changePaused(false); return; }
    if (action === 'send-and-resume') {
      if (hasComposerInput && !(await send())) return;
      await changePaused(false);
      return;
    }
    if (action === 'send') { await send(); return; }
    if (action === 'steer') { await steerQueued(); return; }
    if (action === 'suggestion') { if (promptSuggestion) await send(promptSuggestion); return; }
  }

  async function cancelQueued(messageId: string) {
    setActionError('');
    setDismissedQueue(current => current.includes(messageId) ? current : [...current, messageId]);
    try {
      await api(`/api/conversations/${id}/messages/${encodeURIComponent(messageId)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ requestId: `cancel-${crypto.randomUUID()}` }),
      });
      reload();
      onChanged?.();
    } catch (reason) {
      setDismissedQueue(current => current.filter(id => id !== messageId));
      const message = reason instanceof Error ? reason.message : String(reason);
      setActionError(message);
      toast(message, 'danger');
    }
  }

  async function selectMasterModel(model: { id: string }, thinkingLevel: ThinkingLevel) {
    await api(`/api/conversations/${id}/model`, {
      method: 'POST',
      body: JSON.stringify({
        model: model.id,
        thinkingLevel,
        requestId: `model-${crypto.randomUUID()}`,
      }),
    });
    reload();
    onChanged?.();
  }

  async function compactConversation() {
    await api(`/api/conversations/${id}/compact`, {
      method: 'POST',
      body: JSON.stringify({ requestId: `compact-${crypto.randomUUID()}` }),
    });
    toast(
      busy ? '压缩请求已排队；主 Agent 完成当前轮后会执行。' : '已请求压缩当前会话上下文。',
      'success',
    );
    reload();
    onChanged?.();
  }

  const masterQuestions = (view.questions ?? []).filter(question => question.status === 'open' && (question.owner ?? 'user') === 'user');
  async function loadOlder() {
    if (loadingOlder) return;
    const request = snapshot.historyRequest;
    if (!request) return;
    setLoadingOlder(true);
    setActionError('');
    try {
      const page = await api<ConversationView>(
        `/api/conversations/${id}?${request.direction}=${request.cursor}&limit=200`,
      );
      setProjection(current => observeConversationHistory(current, { request, messages: page.messages }));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingOlder(false);
    }
  }
  const tasks = view.tasks;
  const taskQuestions = tasks.filter(task => task.openQuestions.length > 0);
  const detailTask = drawerSection === 'task'
    ? tasks.find(task => task.id === selectedTaskId) ?? tasks[0] ?? null
    : null;
  const proposalHistory = view.proposalHistory ?? [];
  const activeProposal = selectedProposalVersion !== null && selectedProposalVersion === proposal?.version
    ? proposal
    : selectedProposal;
  const activeProposalSummary = proposalHistory.find(item => item.version === selectedProposalVersion) ?? null;
  const drawerLoading = drawerSection === 'draft' && Boolean(proposal || activeProposalSummary) && !activeProposal;
  const draftStatus: DraftStatus = !proposal
    ? 'none'
    : proposal.stale
      ? 'stale'
      : acceptedVersions.has(proposal.version)
        ? 'accepted'
        : 'pending';
  const confirmableForActive = Boolean(activeProposal && proposal && activeProposal.version === proposal.version && confirmable);
  const drawerTitle = drawerSection === 'task'
    ? detailTask?.request ?? '任务'
    : activeProposal
      ? `草稿 v${activeProposal.version}`
      : activeProposalSummary ? `草稿 v${activeProposalSummary.version}` : '草稿';
  const hasDrawerContent = drawerSection === 'draft' ? Boolean(activeProposal) : Boolean(detailTask);
  const activeProposalVersion = selectedProposalVersion ?? activeProposal?.version ?? null;
  const graphRuntimeTaskId = activeProposalVersion === null
    ? null
    : view.accepted.find(item => item.proposalVersion === activeProposalVersion)?.taskId ?? null;
  const displayMessages = visibleTranscriptMessages(snapshot.messages);
  const composerHistory = sentUserPrompts(displayMessages);
  const transcriptRows = buildTranscriptRows({
    messages: displayMessages,
    liveTools: snapshot.liveTools,
    streaming: snapshot.streaming,
    busy: Boolean(busy),
  });
  const graphState = {
    taskCount: tasks.length,
    evidenceCount: tasks.reduce((count, task) => count + task.evidence.filter(item => item.valid).length, 0),
    used: view.usage.used,
    budget: view.usage.budget,
    unlimited: Boolean(view.usage.unlimited),
    openQuestions: masterQuestions.length + tasks.reduce((count, task) => count + task.openQuestions.length, 0),
  };
  function openProposalDrawer(page: Exclude<DrawerPage, 'task'>, version = proposal?.version) {
    setConversationTab('chat');
    setDrawerSection('draft');
    setDrawerPage(page);
    if (version) setSelectedProposalVersion(version);
    onDrawerOpenChange(true);
  }
  /** The header entry: one click opens the drawer on the draft, or on the first
   * task when there is no draft to show. */
  function openDrawerRoot() {
    setConversationTab('chat');
    if (proposal || activeProposal) {
      setDrawerSection('draft');
      setDrawerPage(defaultDrawerPage());
    } else if (tasks[0]) {
      setDrawerSection('task');
      setSelectedTaskId(tasks[0].id);
      setDrawerPage('task');
    } else {
      setDrawerSection('draft');
    }
    onDrawerOpenChange(true);
  }
  const entryState = {
    proposalVersion: proposal?.version ?? null,
    draftStatus,
    taskCount: tasks.length,
    projectBound: Boolean(view.projectId),
  };
  // The initialization panels (empty task list, project binding) are declared by
  // the policy module; the view only renders what the policy places in the drawer.
  const deferredInitPanelIds = drawerInitPanelIds();
  return (
    <section className="conversation-page" data-testid="conversation">
      <header className="conversation-header">
        <button
          type="button"
          className="icon-button drawer-toggle"
          data-testid="sidebar-toggle"
          onClick={onSidebarToggle}
          title={sidebarCollapsed ? '展开左侧抽屉' : '收起左侧抽屉'}
          aria-label={sidebarCollapsed ? '展开左侧抽屉' : '收起左侧抽屉'}
        >
          <Icon name="panel-left" size={16} />
        </button>
        <div className="conversation-heading">
          <h1 data-testid="conversation-title">{view.title}</h1>
          <div className="conversation-meta">
            {view.projectId ? <span data-testid="conversation-project">项目 {view.projectId}</span> : <span data-testid="conversation-project">未绑定项目</span>}
            <span>·</span>
            <span data-testid="master-status">{paused ? '已暂停' : busy ? '正在处理…' : view.master ? NODE_LABEL[view.master.status] ?? view.master.status : '未配置'}</span>
            <span>·</span>
            <span data-testid="conversation-connection">{connected ? '已连接' : '重连中…'}</span>
            <span>·</span>
            <span>已计量 {formatTokens(view.usage.used)} tokens · {costText(view.cost)}</span>
          </div>
        </div>
        <div className="conversation-actions">
          <button
            type="button"
            className="drawer-entry"
            data-testid="drawer-entry"
            data-open={drawerOpen}
            data-draft-status={draftStatus}
            data-task-count={tasks.length}
            onClick={openDrawerRoot}
            title={drawerEntryAriaLabel(entryState)}
            aria-label={drawerEntryAriaLabel(entryState)}
            aria-expanded={drawerOpen}
            aria-controls="conversation-detail-drawer"
          >
            <Icon name="panel-right" size={15} />
            <span className="drawer-entry-label" data-testid="drawer-entry-label">{drawerEntryLabel(entryState)}</span>
            {(draftStatus === 'pending' || draftStatus === 'stale') && <span className="drawer-entry-dot" data-tone={draftStatus === 'stale' ? 'warn' : 'accent'} aria-hidden="true" />}
          </button>
          <Button
            size="sm"
            icon={pauseAction ? 'refresh' : paused ? 'play' : 'pause'}
            variant={paused ? 'primary' : 'default'}
            data-testid={paused ? 'conversation-resume' : 'conversation-pause'}
            data-busy={pauseAction ? 'true' : 'false'}
            disabled={pauseAction !== null}
            onClick={() => void changePaused(!paused)}
            title={paused ? '继续主 Agent 的对话处理' : '暂停主 Agent 的对话处理，不影响正在执行的功能任务'}
          >
            {pauseAction === 'pause' ? '正在暂停…' : pauseAction === 'resume' ? '正在继续…' : paused ? '继续' : '暂停'}
          </Button>
          <button
            type="button"
            className="icon-button drawer-toggle detail-toggle"
            data-testid="detail-toggle"
            data-open={drawerOpen}
            onClick={() => onDrawerOpenChange(!drawerOpen)}
            title={drawerOpen ? '收起右侧抽屉' : '展开右侧抽屉'}
            aria-label={drawerOpen ? '收起右侧抽屉' : '展开右侧抽屉'}
            aria-expanded={drawerOpen}
          >
            <Icon name="panel-right" size={16} />
          </button>
        </div>
      </header>

      <nav className="conversation-tabs" data-testid="conversation-tabs" role="tablist" aria-label="对话页面">
        <button
          type="button"
          role="tab"
          className="conversation-tab"
          data-testid="conversation-tab-chat"
          data-active={conversationTab === 'chat'}
          aria-selected={conversationTab === 'chat'}
          onClick={() => setConversationTab('chat')}
        >
          <Icon name="message" size={15} />
          对话
        </button>
        <button
          type="button"
          role="tab"
          className="conversation-tab"
          data-testid="conversation-tab-artifacts"
          data-active={conversationTab === 'artifacts'}
          aria-selected={conversationTab === 'artifacts'}
          onClick={() => setConversationTab('artifacts')}
        >
          <Icon name="box" size={15} />
          共享产物
        </button>
      </nav>

      <AgentContextBar conversationId={id} />

      {paused && (
        <section className="conversation-alert" data-testid="conversation-paused-notice">
          <div className="conversation-pause-note">
            <Icon name="pause" size={15} />
            <span><strong>主 Agent 对话已暂停。</strong> 已发出的调用会结束，新消息会保留并排队；正在执行的功能任务仍按自身状态继续。继续后会处理排队消息。</span>
          </div>
        </section>
      )}

      {masterQuestions.length > 0 && (
        <section className="conversation-alert" data-testid="master-questions">
          <div className="thread-action-card" data-tone="warn" style={{ margin: 0 }}>
            <div className="thread-card-title">主 Agent 需要你的处理</div>
            <ul className="list" data-testid="master-questions-list">
              {masterQuestions.map(question => <QuestionReply key={question.id} taskId={question.taskId} question={question} onDone={() => { void reload(); onChanged?.(); }} />)}
            </ul>
          </div>
        </section>
      )}

      <div className="conversation-body" data-drawer={drawerOpen} data-view={conversationTab} data-resident-panels={residentPanelIds().join(' ')}>
        {conversationTab === 'chat' ? (
          <div className="conversation-main">
          <div className="conversation-thread-shell">
          <div
            className="conversation-thread"
            data-testid="message-list"
            data-pinned={transcriptFollow.pinned}
            ref={transcriptFollow.threadRef}
            onScroll={transcriptFollow.onScroll}
            onWheel={transcriptFollow.onWheel}
            onTouchStart={transcriptFollow.onTouchStart}
          >
          <div className="conversation-thread-inner" ref={transcriptFollow.contentRef}>
          {snapshot.historyRequest && <button type="button" className="btn btn-sm" data-testid="load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? '加载中…' : '载入更早消息'}</button>}
          {transcriptRows.map(row => <TranscriptRowView key={row.id} row={row} markdown={markdownEnabled(preferences)} />)}

          {taskQuestions.length > 0 && (
            <section
              className="conversation-question-region"
              data-testid="conversation-questions"
              data-resident={residentFlag('conversation-questions')}
              aria-label="等待你确认"
            >
              <div className="thread-card-title">等待你确认</div>
              {taskQuestions.map(task => (
                <div className="conversation-question-group" key={task.id} data-task={task.id}>
                  <div className="muted">{task.request} · {task.openQuestions.map(question => describeQuestion(question.kind)).join('、')}</div>
                  <ul className="list" data-testid={`conversation-questions-${task.id}`} data-resident={residentFlag('conversation-questions')}>
                    {task.openQuestions.map(question => <QuestionReply key={question.id} taskId={task.id} question={question} onDone={() => { void reload(); onChanged?.(); }} />)}
                  </ul>
                </div>
              ))}
            </section>
          )}

          <div className="conversation-runway" style={{ height: transcriptFollow.runway }} aria-hidden="true" />
          </div>
          </div>
          {transcriptFollow.showJump && (
            <button
              type="button"
              className="jump-to-latest"
              data-testid="jump-to-latest"
              onClick={() => transcriptFollow.scrollToLatest('smooth')}
            >
              <Icon name="chevron" size={13} />
              回到最新
            </button>
          )}
          </div>

          <div className="conversation-composer-wrap">
            {actionError && <ErrorBox message={actionError} />}
            {queuedMessages.length > 0 && (
              <div className="queued-messages" data-testid="queued-messages">
                {queuedMessages.map((message, index) => {
                  const attachments = messageAttachments(message);
                  return (
                    <div className="queued-message" data-testid="queued-message" key={message.id}>
                      <div className="queued-message-body">
                        {message.text && <p>{message.text}</p>}
                        {attachments.length > 0 && (
                          <div className="queued-message-attachments">
                            {attachments.map(attachment => (
                              <span key={`${attachment.name}:${attachment.size}`}>
                                <Icon name="paperclip" size={11} />
                                {attachment.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className="queued-message-order">{index + 1}</span>
                      <button
                        type="button"
                        className="queued-message-cancel"
                        data-testid="queued-message-cancel"
                        onClick={() => void cancelQueued(message.id)}
                        aria-label="取消这条排队消息"
                        title="取消这条排队消息"
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <ChatComposer
              className="conversation-composer"
              value={text}
              onChange={setText}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              projectId={view.projectId}
              placeholder={busy ? '主 Agent 正在处理；继续输入会排队，不会被丢掉。' : '继续交流，输入 @ 引用项目文件…'}
              suggestion={promptSuggestion}
              slashTools={agentContext?.tools ?? []}
              slashCapabilities={agentContext?.capabilities ?? []}
              slashModels={settings?.models ?? []}
              slashTelemetry={view.telemetry}
              onSlashModelSelect={selectMasterModel}
              onCompact={compactConversation}
              onSend={() => void submitPrimary()}
              onSubmit={() => void submitEnter()}
              history={composerHistory}
              busy={Boolean(busy)}
              paused={paused}
              pausePending={pauseAction !== null}
              queueLength={queuedMessages.length}
              hasSuggestion={Boolean(promptSuggestion)}
              sendDisabled={composerPrimaryDisabled({
                sending, steering,
                pending: pauseAction !== null,
                paused,
                busy: Boolean(busy),
                hasInput: hasComposerInput,
                hasSuggestion: Boolean(promptSuggestion),
              })}
            />
            <div className="composer-footer">
              <span className="composer-note">
                {busy
                  ? <span data-testid="queued-hint">主 Agent 正在处理，{queuedMessages.length ? `已有 ${queuedMessages.length} 条队列消息。` : '消息会排队。'}</span>
                  : 'Enter 发送，Shift + Enter 换行'}
              </span>
              <ComposerTelemetry
                telemetry={view.telemetry}
                models={settings?.models ?? []}
                onSelect={selectMasterModel}
              />
            </div>
          </div>
        </div>
        ) : (
          <ArtifactWorkspace conversationId={view.id} projectBound={Boolean(view.projectId)} />
        )}

        <aside
          id="conversation-detail-drawer"
          className="detail-drawer"
          data-testid="detail-drawer"
          data-open={drawerOpen}
          data-section={drawerSection}
          data-page={drawerSection === 'draft' ? drawerPage : 'task'}
          data-drawer-panels={drawerPanelIds().join(' ')}
          aria-hidden={!drawerOpen}
          inert={!drawerOpen}
        >
          <div className="drawer-inner">
            <div className="drawer-head">
              <div className="grow">
                <div className="drawer-eyebrow">{drawerSection === 'draft' ? '草稿详情' : '任务导航'}</div>
                <h2>{drawerTitle}</h2>
              </div>
            </div>

            {drawerOpen && (
              <nav className="drawer-mode-tabs" data-testid="drawer-mode-tabs" aria-label="抽屉内容">
                <button
                  type="button"
                  className="drawer-mode-tab"
                  data-testid="drawer-mode-draft"
                  data-active={drawerSection === 'draft'}
                  aria-selected={drawerSection === 'draft'}
                  onClick={() => { setDrawerSection('draft'); setDrawerPage(defaultDrawerPage()); }}
                >
                  {proposal ? `草稿 v${proposal.version} · ${draftStatusLabel(draftStatus)}` : '草稿'}
                </button>
                <button
                  type="button"
                  className="drawer-mode-tab"
                  data-testid="drawer-mode-tasks"
                  data-active={drawerSection === 'task'}
                  aria-selected={drawerSection === 'task'}
                  onClick={() => { setDrawerSection('task'); if (!selectedTaskId && tasks[0]) setSelectedTaskId(tasks[0].id); }}
                >
                  任务 {tasks.length}
                </button>
              </nav>
            )}

            {drawerOpen && !view.projectId && deferredInitPanelIds.includes('bind-project') && (
              <section className="drawer-section drawer-bind-card" data-testid="bind-project" data-panel="bind-project">
                <div className="drawer-section-head">
                  <h3>绑定项目</h3>
                </div>
                <p className="muted">未绑定项目时主 Agent 无法读取代码；可以先聊天再选择项目。</p>
                <div className="thread-card-actions">
                  <select className="select" style={{ width: 220 }} data-testid="bind-select" value={bindId} onChange={event => setBindId(event.target.value)}>
                    <option value="">选择项目…</option>
                    {(settings?.projects ?? []).map(project => <option key={project.id} value={project.id}>{project.id}</option>)}
                  </select>
                  <Button size="sm" data-testid="bind-submit" disabled={!bindId} onClick={() => void act(() => api(`/api/conversations/${id}/bind`, { method: 'POST', body: JSON.stringify({ projectId: bindId, requestId: crypto.randomUUID() }) }))}>绑定</Button>
                </div>
              </section>
            )}

            {drawerOpen && drawerSection === 'draft' && activeProposal && (
              <section className="drawer-section drawer-draft-card" data-testid="proposal-draft" data-resident={residentFlag('proposal-draft')}>
                {drawerPage !== 'graph' && (
                  <>
                    <div className="drawer-draft-head">
                      <div className="grow">
                        <div className="drawer-draft-title">草稿 v{activeProposal.version}</div>
                        <div className="drawer-draft-summary" data-testid="drawer-draft-summary">{activeProposal.spec.summary}</div>
                      </div>
                      <Pill tone={activeProposal.stale ? 'warn' : acceptedVersions.has(activeProposal.version) ? 'success' : 'info'}>
                        {activeProposal.stale ? '需重新讨论' : acceptedVersions.has(activeProposal.version) ? `已确认草稿 v${activeProposal.version}` : '待确认'}
                      </Pill>
                    </div>
                    <div className="thread-card-actions">
                      <button type="button" className="summary-graph-preview" data-testid="draft-graph" data-resident={residentFlag('draft-graph')} onClick={() => openProposalDrawer('graph')}>
                        <Icon name="graph" size={14} />
                        任务图 · {activeProposal.spec.nodes.length} 个节点
                      </button>
                      <button type="button" className="summary-graph-preview" data-testid="draft-acceptance" data-resident={residentFlag('draft-acceptance')} onClick={() => openProposalDrawer('acceptance')}>
                        <Icon name="check" size={14} />
                        验收项 · {activeProposal.spec.acceptance.length}
                      </button>
                    </div>
                    {activeProposal.stale && <p data-testid="draft-stale" className="muted">需求已变化，这个草稿不能执行；请让主 Agent 针对最新需求重新提案。</p>}
                    {acceptedVersions.has(activeProposal.version) && <p data-testid="draft-accepted" className="muted">已确认草稿 v{activeProposal.version}，执行状态见任务导航。</p>}
                    {confirmableForActive && !view.projectId && <p data-testid="draft-needs-project" className="muted">确认前需要先绑定项目。</p>}
                    {confirmableForActive && view.projectId && (
                      <>
                        <p data-testid="draft-budget" className="muted" style={{ fontSize: 12 }}>
                          主管已用 {formatTokens(view.master?.used ?? 0)} tokens；{!view.master || view.master.unlimited || view.master.budget === null ? '当前不设累计上限' : `当前上限 ${formatTokens(view.master.budget)}`}。
                        </p>
                        <div className="thread-card-actions">
                          <label className="row" style={{ gap: 6 }}>
                            <span className="muted">目标分支</span>
                            <input className="input" style={{ width: 150, maxWidth: 150 }} data-testid="accept-branch" data-resident={residentFlag('accept-branch')} value={branch} onChange={event => setBranch(event.target.value)} />
                          </label>
                          <Button variant="primary" icon="check" data-testid="confirm-draft" data-resident={residentFlag('confirm-draft')} onClick={() => void act(() => api(`/api/conversations/${id}/confirm`, { method: 'POST', body: JSON.stringify({ proposalVersion: activeProposal.version, targetBranch: branch, requestId: `confirm-${crypto.randomUUID()}` }) }))}>确认草稿并开始执行</Button>
                        </div>
                      </>
                    )}
                  </>
                )}
                <div className="drawer-draft-pages">
                  <ProposalDrawer
                    proposal={activeProposal}
                    history={proposalHistory}
                    page={drawerPage === 'task' ? 'acceptance' : drawerPage}
                    selectedVersion={selectedProposalVersion ?? activeProposal.version}
                    graphPanel={(
                      <ConversationGraphBoard
                        proposal={activeProposal}
                        graph={draftGraph}
                        graphLoading={draftGraphLoading}
                        selectedNodeId={selectedGraphNodeId}
                        runtimeTaskId={graphRuntimeTaskId}
                        state={graphState}
                        onSelectNode={setSelectedGraphNodeId}
                      />
                    )}
                    onSelectVersion={setSelectedProposalVersion}
                    onSelectPage={setDrawerPage}
                  />
                </div>
              </section>
            )}
            {drawerOpen && drawerSection === 'draft' && drawerLoading && (
              <div className="drawer-loading"><Spinner label="正在加载草稿…" /></div>
            )}

            {drawerOpen && drawerSection === 'task' && (
              <section className="drawer-section" data-testid="conversation-tasks">
                <div className="drawer-section-head">
                  <h3>任务导航</h3>
                  <span>{tasks.length} 个任务</span>
                </div>
                {tasks.length === 0 && deferredInitPanelIds.includes('task-empty') && (
                  <div className="drawer-init-note" data-testid="no-conversation-tasks" data-panel="task-empty">
                    <div className="thread-card-title">尚无功能任务</div>
                    <div className="thread-card-copy">确认草稿后才会创建并开始执行。</div>
                  </div>
                )}
                {tasks.length > 0 && (
                  <nav className="drawer-task-nav" data-testid="drawer-task-nav" aria-label="全部任务">
                    {tasks.map(task => (
                      <button
                        key={task.id}
                        type="button"
                        className="drawer-task-nav-item"
                        data-testid={`conversation-task-${task.id}`}
                        data-active={task.id === detailTask?.id}
                        aria-pressed={task.id === detailTask?.id}
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <span className="grow truncate">{task.request}</span>
                        <Pill tone={TASK_TONE[task.status] ?? 'neutral'}>{TASK_LABEL[task.status] ?? task.status}</Pill>
                      </button>
                    ))}
                  </nav>
                )}
                {detailTask && (
                  <div className="drawer-task-detail" data-testid="drawer-task-detail">
                    <dl className="kv">
                      <dt>状态</dt><dd>{TASK_LABEL[detailTask.status] ?? detailTask.status}</dd>
                      <dt>目标分支</dt><dd>{detailTask.targetBranch ?? '未确认'}</dd>
                      <dt>集成提交</dt><dd className="mono">{detailTask.integrationSha ?? '尚无'}</dd>
                      <dt>费用</dt><dd>{costText(detailTask.cost)}</dd>
                    </dl>
                    <ul className="node-summary-list" data-testid={`conversation-nodes-${detailTask.id}`} style={{ marginTop: 12 }}>
                      {detailTask.nodes.map(node => (
                        <li key={node.id} data-node={node.id} data-status={node.status}>
                          <span className="dot" data-tone={NODE_TONE[node.status] ?? 'neutral'} />
                          <a href={`#/tasks/${detailTask.id}/nodes/${node.id}`} data-testid={`conversation-node-link-${detailTask.id}-${node.id}`}>{node.id}</a>
                          <span>{NODE_LABEL[node.status] ?? node.status}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="row" style={{ marginTop: 12 }}>
                      <a className="btn btn-sm" href={`#/tasks/${detailTask.id}`}>打开任务</a>
                      <a className="btn btn-sm" href={`#/tasks/${detailTask.id}/graph`}>打开任务图</a>
                    </div>
                  </div>
                )}
              </section>
            )}

            {drawerOpen && !hasDrawerContent && !drawerLoading && (
              <div className="drawer-empty" data-testid="detail-empty">
                <strong>暂无详情</strong>
                <span>出现草稿详情或执行进度后，详情会显示在这里。</span>
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
