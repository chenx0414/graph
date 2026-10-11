import { createPortal } from 'react-dom';
import { WindowDrawer } from './WindowDrawer.tsx';
import { TaskDrawerSection } from './TaskDrawerSection.tsx';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgentNodeChat } from './AgentNodeChat.tsx';
import { type AgentContextView } from './AgentContext.tsx';
import { api } from './api.ts';
import type { ArtifactRecord } from '../core/artifact-workspace.ts';
import type { GraphDefinition, ProtocolRef } from '../core/interface-spec.ts';
import { ChatComposer, type ChatAttachment } from './ChatComposer.tsx';
import { attachmentPayload, attachmentImageSource } from './attachments.ts';
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
  DRAWER_ENTRY_LINKS,
  defaultDrawerOpen,
  drawerEntryAriaLabel,
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
import { NODE_LABEL, TASK_LABEL } from './labels.ts';
import { GraphCanvas } from './GraphCanvas.tsx';
import { QuestionReply } from './Questions.tsx';
import { ErrorBox, costText, useAsync, useEventStream, useTargetBranch } from './shared.tsx';
import { TranscriptRowView } from './TranscriptRows.tsx';
import { Button, Icon, Pill, Spinner, StatusDot, toast } from './ui.tsx';
import { buildTranscriptRows } from './transcript-model.ts';
import { useTranscriptFollow } from './use-transcript-follow.ts';

type Settings = { projects: { id: string; root: string; branch?: string | null; preparation?: { branch?: string | null } | null }[]; models: { id: string; grade: string; credentialId?: string; reasoning?: boolean; thinkingOptions?: { level: string; label: string }[] }[] };
export type ConversationSummary = {
  id: string; title: string; projectId: string | null; anchorTaskId: string; createdAt: number; updatedAt: number | null;
  openQuestions: number; taskCount: number; status: string;
};
type ConversationNode = { id: string; kind: string; role: string | null; status: string; used: number | null; budget: number | null; unlimited?: boolean; model: string | null; definitionVersion: string | null; stallCount: number; outputVersion: number };
type ConversationTask = {
  id: string; request: string; phase: string; status: string; paused: boolean; targetBranch: string | null; createdAt: number;
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
export type DraftGraph = {
  nodes: {
    id: string; kind: string; status: string; container?: string;
    action?: string; definitionVersion?: string; model?: string;
    agent?: GraphAgentDetail | null;
    inputs?: Record<string, ProtocolRef>;
    outputs?: Record<string, ProtocolRef>;
  }[];
  interfaces?: { edgeId: string; from: string; to: string; enabled: boolean; protocol: string | null; latest: unknown; deliveries: { id: string; value: unknown; protocol: string; revisionVersion: number; createdAt: number; source?: string; sourceExecutionId?: string | null; artifacts?: { taskId: string; artifactId: string; version: number; digest: string | null }[]; receiver?: { kind: string; state: string; operationId: string | null; reason: string | null } }[] }[];
  containers: { id: string; parent?: string }[];
  loops: { from: string; to: string }[];
  layout: { positions: Record<string, { x: number; y: number; width: number; height: number }>; edges: { id: string; source: string; target: string }[]; branches?: { id: string; source: string; target: string; case: string }[] };
};
export type ProposalDetail = {
  version: number;
  requirementVersion: number;
  stale: boolean;
  decisions: string | null;
  spec: import('../core/types.ts').NativeProposal;
  draftRevision?: number;
  draftDigest?: string;
  archived?: boolean;
};
type ProposalVersion = {
  version: number;
  requirementVersion: number;
  stale: boolean;
  summary: string;
  accepted: boolean;
  draftRevision?: number;
  archived?: boolean;
};
type DrawerPage = ConversationDrawerPage;

/** `data-resident` marker for a main-column entry that stays visible even with
 * the drawer shut. Keeps the resident list single-sourced in the policy module. */
function residentFlag(id: string): 'true' | undefined {
  return isResidentPanel(id) ? 'true' : undefined;
}
type AnchorQuestion = { id: string; nodeId: string; operationId: string | null; kind: string; status: string; owner?: string; data: Record<string, unknown>; answer: Record<string, unknown> | null; taskId: string };
type ConversationView = {
  eventCursor?: number;
  continuations?: { operationId: string; resumedOperationId: string | null }[];
  id: string; title: string; projectId: string | null; projectRoot: string | null; workspaceProjectId: string; anchorTaskId: string;
  createdAt: number; requirementVersion: number; paused: boolean;
  messages: ConversationMessage[]; messageCount: number;
  streams: {
    operationId: string; entryId: string; partId: string; ordinal: number; text: string; length: number; updatedAt: number;
  }[];
  questions: AnchorQuestion[];
  proposal: ProposalDetail | null;
  proposalHistory: ProposalVersion[];
  archivedProposals: ProposalVersion[];
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
              {state.openQuestions > 0 ? ` · ${state.openQuestions} 个待处理问题` : ''}
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

export function ConversationPanel({ id, settings, onChanged, drawerOpen = defaultDrawerOpen(), onDrawerOpenChange }: {
  id: string;
  settings: Settings | null;
  onChanged?: () => void;
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
    // The credential is part of the identity of a draft: editing the same version
    // in place must re-read the preview instead of showing the previous content.
    [id, selectedProposalVersion, view?.proposal?.draftRevision, view?.proposal?.draftDigest],
  );
  const { data: draftGraph, loading: draftGraphLoading } = useAsync(
    () => selectedProposalVersion
      ? api<DraftGraph>(`/api/conversations/${id}/draft-graph?version=${selectedProposalVersion}`)
      : Promise.resolve(null),
    [id, selectedProposalVersion, view?.proposal?.draftRevision, view?.proposal?.draftDigest],
  );
  const [text, setText] = useState(() => readComposerDraft(composerStorage(), id));
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [steering, setSteering] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [bindId, setBindId] = useState('');
  const { branch, setBranch } = useTargetBranch(settings?.projects ?? null, view?.projectId ?? null);
  const { preferences } = usePreferences();
  const [projection, setProjection] = useState(createConversationProjection);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderPending = useRef(false);
  const historyAnchor = useRef<{ height: number; top: number } | null>(null);
  const [drawerSection, setDrawerSection] = useState<ConversationDrawerSection>('draft');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  const [pauseAction, setPauseAction] = useState<'pause' | 'resume' | null>(null);
  const [pausedOverride, setPausedOverride] = useState<boolean | null>(null);
  const [dismissedQueue, setDismissedQueue] = useState<string[]>([]);
  const busy = view?.master?.status === 'preparing' || view?.master?.status === 'running';
  const interruptTurn = useCallback(async () => {
    if (interrupting) return;
    setInterrupting(true);
    setActionError('');
    try {
      await api(`/api/conversations/${id}/interrupt`, {
        method: 'POST',
        body: JSON.stringify({ requestId: `interrupt-${crypto.randomUUID()}` }),
      });
      toast('已打断当前模型思考和工具调用。', 'info');
      reload();
      onChanged?.();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setActionError(message);
      toast(message, 'danger');
    } finally {
      setInterrupting(false);
    }
  }, [id, interrupting, onChanged, reload]);
  useEffect(() => {
    if (!busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      void interruptTurn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, interruptTurn]);
  const transcriptFollow = useTranscriptFollow(view?.id ?? null, Boolean(busy));
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
    setProjection(current => applyConversationEvent(current, { type: event.type, cursor: event.cursor, ...(data ? { data } : {}) }));
    if (event.type !== 'message.delta') refresh();
  }, view?.eventCursor ?? 0);
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
    // Selecting a card that is no longer active (archived or deleted) must not
    // survive a reload: fall back to the current draft, then to the newest active
    // card.
    const active = view?.proposalHistory ?? [];
    setSelectedProposalVersion(current => {
      if (current !== null && active.some(item => item.version === current)) return current;
      return view?.proposal?.version ?? active[0]?.version ?? null;
    });
  }, [view?.proposal?.version, view?.proposal?.draftRevision, view?.proposalHistory]);
  useEffect(() => {
    setSelectedGraphNodeId(null);
  }, [selectedProposalVersion]);
  useEffect(() => {
    if (!view || !drawerOpen) return;
    // The draft page owns its cards whether they are active or archived, so only
    // an empty draft page falls back to the task section. A page that still has
    // something to manage stays where the user put it.
    const activeDraft = Boolean(view.proposal && !view.accepted.some(item => item.proposalVersion === view.proposal!.version));
    const draftCards = activeDraft || (view.archivedProposals ?? []).length > 0;
    const resolved = resolveDrawerSection({
      current: drawerSection,
      selectedTaskId,
      taskIds: view.tasks.map(task => task.id),
      hasProposal: draftCards,
    });
    // A live draft always surfaces, so an overturned draft replaces the old one on
    // screen. Archived-only content must not hijack the task section (the entry
    // point for it is openDrawerRoot), and nothing else overrides the user choice.
    if (activeDraft) resolved.section = 'draft';
    else if (!draftCards) resolved.section = 'task';
    if (resolved.section !== drawerSection) setDrawerSection(resolved.section);
    if (resolved.taskId !== selectedTaskId) setSelectedTaskId(resolved.taskId);
  }, [view, drawerOpen, drawerSection, selectedTaskId]);
  useEffect(() => {
    if (view) setProjection(current => observeConversationView(current, view));
  }, [view]);
  const snapshot = useMemo(() => conversationProjectionSnapshot(projection, { busy: Boolean(busy) }), [projection, busy]);
  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    const thread = transcriptFollow.threadRef.current;
    if (!anchor || !thread) return;
    thread.scrollTop = anchor.top + thread.scrollHeight - anchor.height;
    historyAnchor.current = null;
  }, [snapshot.messages]);
  const displayMessages = useMemo(() => visibleTranscriptMessages(snapshot.messages), [snapshot.messages]);
  const composerHistory = useMemo(() => sentUserPrompts(displayMessages), [displayMessages]);
  const transcriptRows = useMemo(() => buildTranscriptRows({
    messages: displayMessages,
    continuations: view?.continuations ?? [],
    liveTools: snapshot.liveTools,
    streaming: snapshot.streaming,
    busy: Boolean(busy),
  }), [displayMessages, view?.continuations, snapshot.liveTools, snapshot.streaming, busy]);
  useEffect(() => {
    if (snapshot.streamNeedsResync) reload();
  }, [reload, snapshot.streamNeedsResync]);
  // Entering a conversation (or reopening the window) starts at the newest
  // message once the transcript window has rendered. Leaving and re-entering
  // the chat tab re-arms the jump without yanking a reader on new arrivals.
  const enteredScrollRef = useRef(false);
  useEffect(() => {
    const jump = shouldScrollToLatest({
      tab: 'chat',
      hasMessages: snapshot.messages.length > 0,
      alreadyJumped: enteredScrollRef.current,
    });
    if (!jump) return;
    enteredScrollRef.current = true;
    const frame = requestAnimationFrame(() => transcriptFollow.scrollToLatest('auto'));
    return () => cancelAnimationFrame(frame);
  }, [snapshot.messages.length, transcriptFollow.scrollToLatest]);
  if (loading && !view) return <div role="status" className="conversation-loading"><Spinner label="正在加载会话…" /></div>;
  if (error && !view) return <ErrorBox message={error} onRetry={reload} />;
  if (!view) return <div role="status" className="conversation-loading"><Spinner label="正在加载会话…" /></div>;

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
          ? '主 Agent 对话已暂停：正在跑的回合会在当前工具调用收尾后停下，不再发起新的模型请求；新消息会保留并排队。'
          : '主 Agent 对话已继续：会接着跑刚才被停下的那个回合，排队消息随后按序处理。',
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
    if (steering || interrupting || !queuedMessages.length) return;
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
    if (sending || steering || interrupting) return;
    if (text.trim() || attachments.length) return send();
    if (busy && queuedMessages.length) return steerQueued();
    if (!busy && promptSuggestion) return send(promptSuggestion);
  }

  /** The context-sensitive primary button: pause while the master is
   * outputting, resume when paused, and send + auto-continue when paused with
   * something to send. */
  async function submitPrimary() {
    if (sending || steering || interrupting || pauseAction) return;
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
    if (olderPending.current) return;
    const request = snapshot.historyRequest;
    if (!request) return;
    olderPending.current = true;
    setLoadingOlder(true);
    setActionError('');
    try {
      const page = await api<{ messages: ConversationMessage[] }>(
        `/api/conversations/${id}/history?${request.direction}=${request.cursor}&limit=200`,
      );
      const thread = transcriptFollow.threadRef.current;
      if (thread && request.direction === 'before') historyAnchor.current = { height: thread.scrollHeight, top: thread.scrollTop };
      setProjection(current => observeConversationHistory(current, { request, messages: page.messages }));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      olderPending.current = false;
      setLoadingOlder(false);
    }
  }
  const tasks = view.tasks;
  const taskQuestions = tasks.filter(task => task.openQuestions.length > 0);
  const detailTask = tasks.find(task => task.id === selectedTaskId) ?? tasks[0] ?? null;
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
  const hasDrawerContent = drawerSection === 'draft'
    ? Boolean(activeProposal) || (view.archivedProposals ?? []).length > 0
    : Boolean(detailTask);
  const activeProposalVersion = selectedProposalVersion ?? activeProposal?.version ?? null;
  const graphRuntimeTaskId = activeProposalVersion === null
    ? null
    : view.accepted.find(item => item.proposalVersion === activeProposalVersion)?.taskId ?? null;
  const graphState = {
    taskCount: tasks.length,
    evidenceCount: tasks.reduce((count, task) => count + task.evidence.filter(item => item.valid).length, 0),
    used: view.usage.used,
    budget: view.usage.budget,
    unlimited: Boolean(view.usage.unlimited),
    openQuestions: masterQuestions.length + tasks.reduce((count, task) => count + task.openQuestions.length, 0),
  };
  /** The header entry: one click opens the drawer on the draft, or on the first
   * task when there is no draft to show. */
  function openDrawerRoot() {
    // The draft page owns the draft cards, including the archived ones: with every
    // card archived there is still something to see and restore, so the task
    // section must not swallow it.
    const archived = (view?.archivedProposals ?? []).length > 0;
    if (archived || (proposal && !acceptedVersions.has(proposal.version))) {
      setDrawerSection('draft');
    } else {
      // No draft to show: the drawer opens on the task section, which always has something to
      // offer - the shared artifacts exist whether or not a task does.
      setDrawerSection('task');
      if (tasks[0]) setSelectedTaskId(tasks[0].id);
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
      {document.getElementById('conversation-toolbar') && createPortal(<div className="conversation-toolbar-content">
        <div className="conversation-heading">
          <h1 data-testid="conversation-title">{view.title}</h1>
          <div className="conversation-meta" title={`已计量 ${formatTokens(view.usage.used)} tokens · ${costText(view.cost)}`}>
            {view.projectId ? <span data-testid="conversation-project">项目 {view.projectId}</span> : <span data-testid="conversation-project">未绑定项目</span>}
            <span>·</span>
            <span data-testid="master-status" className="master-work-status">{busy && !paused && <span className="spinner" aria-hidden="true" />}{paused ? '已暂停' : busy ? '正在处理…' : view.master ? NODE_LABEL[view.master.status] ?? view.master.status : '未配置'}</span>
            <span>·</span>
            <span data-testid="conversation-connection">{connected ? '已连接' : '重连中…'}</span>

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
            onClick={() => drawerOpen ? onDrawerOpenChange(false) : openDrawerRoot()}
            title={drawerEntryAriaLabel(entryState)}
            aria-label={drawerEntryAriaLabel(entryState)}
            aria-expanded={drawerOpen}
            aria-controls="conversation-detail-drawer"
          >
            <Icon name="panel-right" size={15} />
            <span className="drawer-entry-label" data-testid="drawer-entry-label">{proposal && !acceptedVersions.has(proposal.version) ? `草稿 v${proposal.version}` : `任务 ${view.tasks.length}`}</span>
            {(draftStatus === 'pending' || draftStatus === 'stale') && <span className="drawer-entry-dot" data-tone={draftStatus === 'stale' ? 'warn' : 'accent'} aria-hidden="true" />}
          </button>
          {/* The pause/resume control lives on the composer's primary button
              (same action, same flag); the header no longer repeats it. */}

        </div>
      </div>, document.getElementById('conversation-toolbar')!)}

      {paused && (
        <section className="conversation-alert" data-testid="conversation-paused-notice">
          <div className="conversation-pause-note">
            <Icon name="pause" size={15} />
            <span><strong>主 Agent 对话已暂停。</strong> 正在跑的回合会在当前工具调用收尾后停下，不再发起新的模型请求；新消息会保留并排队。继续后会接着跑被停下的那个回合。</span>
          </div>
        </section>
      )}

      {/* The chat column is the conversation: its artifacts live in the drawer, and a single
          artifact opens as its own tab. */}
      <div className="conversation-body" data-drawer={drawerOpen} data-view="chat" data-resident-panels={residentPanelIds().join(' ')}>
        <div className="conversation-main">
          <div className="conversation-thread-shell">
          <div
            className="conversation-thread"
            data-testid="message-list"
            data-pinned={transcriptFollow.pinned}
            ref={transcriptFollow.threadRef}
            onScroll={() => {
              transcriptFollow.onScroll();
              const thread = transcriptFollow.threadRef.current;
              if (thread && thread.scrollTop < 160 && !transcriptFollow.pinned) void loadOlder();
            }}
            onWheel={transcriptFollow.onWheel}
            onTouchStart={transcriptFollow.onTouchStart}
          >
          <div className="conversation-thread-inner" ref={transcriptFollow.contentRef}>
          {snapshot.historyRequest && <button type="button" className="btn btn-sm" data-testid="load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? '加载中…' : '载入更早消息'}</button>}
          {transcriptRows.map(row => <TranscriptRowView key={row.id} row={row} markdown={markdownEnabled(preferences)} />)}

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
                                {attachmentImageSource(attachment) ? <img className="message-attachment-image" src={attachmentImageSource(attachment)} alt={attachment.name} /> : <Icon name="paperclip" size={11} />}
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
            {(masterQuestions.length > 0 || taskQuestions.length > 0) ? (
              <section className="conversation-question-composer" data-testid="conversation-questions" data-resident={residentFlag('conversation-questions')} aria-label="等待你确认">
                <div className="thread-card-title">需要你的答复</div>
                <ul className="list" data-testid="master-questions-list">
                  {masterQuestions.map(question => <QuestionReply key={question.id} taskId={question.taskId} question={question} onDone={() => { void reload(); onChanged?.(); }} />)}
                  {taskQuestions.map(task => <li key={task.id} className="conversation-question-group" data-testid={`conversation-questions-${task.id}`}>
                    <div className="muted">{task.request}</div>
                    <ul className="list">{task.openQuestions.map(question => <QuestionReply key={question.id} taskId={task.id} question={question} onDone={() => { void reload(); onChanged?.(); }} />)}</ul>
                  </li>)}
                </ul>
              </section>
            ) : <ChatComposer
              className="conversation-composer"
              value={text}
              onChange={setText}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              projectId={view.projectId}
              placeholder={busy ? '继续输入，消息会排队…' : '发送消息，@ 引用文件…'}
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
            />}
            {masterQuestions.length === 0 && taskQuestions.length === 0 && <div className="composer-footer">
              <span className="composer-note">
                {busy
                  ? <span data-testid="queued-hint">{queuedMessages.length ? `${queuedMessages.length} 条消息等待处理` : '可继续输入'}</span>
                  : 'Enter 发送，Shift + Enter 换行'}
              </span>
              <ComposerTelemetry
                telemetry={view.telemetry}
                models={settings?.models ?? []}
                onSelect={selectMasterModel}
              />
            </div>}
          </div>
        </div>

        <WindowDrawer open={drawerOpen}>
        <aside
          id="conversation-detail-drawer"
          className="detail-drawer"
          data-testid="detail-drawer"
          data-open={drawerOpen}
          data-section={drawerSection}
          data-page={drawerSection === 'draft' ? 'card' : 'task'}
          data-drawer-panels={drawerPanelIds().join(' ')}
          aria-hidden={!drawerOpen}
          inert={!drawerOpen}
        >
          <div className="drawer-inner">
            {drawerSection === 'draft' && <div className="drawer-head"><div className="grow"><h2>{`草稿 v${proposal?.version ?? ""}`}</h2></div></div>}

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
                <div className="drawer-draft-head">
                      <div className="grow">
                        <div className="drawer-draft-title">草稿 v{activeProposal.version}</div>
                        <div className="drawer-draft-summary" data-testid="drawer-draft-summary">{activeProposal.spec.summary}</div>
                      </div>
                      <Pill tone={activeProposal.stale ? 'warn' : acceptedVersions.has(activeProposal.version) ? 'success' : 'info'}>
                        {activeProposal.stale ? '需重新讨论' : acceptedVersions.has(activeProposal.version) ? `已确认草稿 v${activeProposal.version}` : '待确认'}
                      </Pill>
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
                          <Button variant="primary" icon="check" data-testid="confirm-draft" data-resident={residentFlag('confirm-draft')} onClick={() => void act(() => api(`/api/conversations/${id}/confirm`, { method: 'POST', body: JSON.stringify({ proposalVersion: activeProposal.version, draftRevision: activeProposal.draftRevision, targetBranch: branch, requestId: `confirm-${crypto.randomUUID()}` }) }))}>确认草稿并开始执行</Button>
                        </div>
                      </>
                    )}
                <div className="row">
                  <Button size="sm" data-testid="archive-draft" onClick={() => void act(() => api(`/api/conversations/${id}/drafts/archive`, { method: 'POST', body: JSON.stringify({ proposalVersion: activeProposal.version, requestId: `archive-${crypto.randomUUID()}` }) }), () => setSelectedProposalVersion(null))}>归档草稿</Button>
                  <Button size="sm" variant="danger" data-testid="delete-draft" onClick={() => void act(() => api(`/api/conversations/${id}/drafts/delete`, { method: 'POST', body: JSON.stringify({ proposalVersion: activeProposal.version, requestId: `delete-${crypto.randomUUID()}` }) }), () => setSelectedProposalVersion(null))}>删除草稿</Button>
                </div>
                {/* The drawer names the windows; it does not render them. */}
                <div className="drawer-entry-links" data-testid="drawer-entry-links">
                  {DRAWER_ENTRY_LINKS.map(entry => (
                    <a
                      key={entry.id}
                      className="btn btn-sm"
                      data-testid={`drawer-entry-${entry.id}`}
                      href={entry.id === 'graph'
                        ? `#/conversations/${id}/graph?v=${selectedProposalVersion ?? activeProposal.version}`
                        : `#/artifacts${view.projectId ? `?project=${encodeURIComponent(view.projectId)}` : ''}`}
                    >
                      <Icon name={entry.id === 'graph' ? 'graph' : 'box'} size={14} />
                      <span style={{ marginLeft: 6 }}>{entry.label}</span>
                    </a>
                  ))}
                </div>
              </section>
            )}
            {drawerOpen && drawerSection === 'draft' && (proposalHistory.length > 0 || (view.archivedProposals ?? []).length > 0) && (
              <section className="drawer-section" data-testid="draft-cards">
                {proposalHistory.length > 0 && <DraftVersionToc history={proposalHistory} selectedVersion={selectedProposalVersion ?? proposal?.version ?? null} onSelectVersion={setSelectedProposalVersion} />}
                {(view.archivedProposals ?? []).length > 0 && (
                  <div data-testid="archived-drafts">
                    <p className="muted">已归档草稿（默认列表不显示）</p>
                    {(view.archivedProposals ?? []).map(item => (
                      <div key={item.version} className="row" data-testid={`archived-draft-${item.version}`}>
                        <span className="grow">{`v${item.version} · ${item.summary}`}</span>
                        <Button size="sm" data-testid={`restore-draft-${item.version}`} onClick={() => void act(() => api(`/api/conversations/${id}/drafts/restore`, { method: 'POST', body: JSON.stringify({ proposalVersion: item.version, requestId: `restore-${crypto.randomUUID()}` }) }))}>恢复</Button>
                        <Button size="sm" variant="danger" data-testid={`delete-archived-draft-${item.version}`} onClick={() => void act(() => api(`/api/conversations/${id}/drafts/delete`, { method: 'POST', body: JSON.stringify({ proposalVersion: item.version, requestId: `delete-${crypto.randomUUID()}` }) }))}>删除</Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
            {drawerOpen && drawerSection === 'draft' && drawerLoading && (
              <div className="drawer-loading"><Spinner label="正在加载草稿…" /></div>
            )}

            {drawerOpen && <TaskDrawerSection tasks={tasks} selectedId={selectedTaskId} onSelect={setSelectedTaskId} projectId={view.projectId} origin="conversation" />}

            {drawerOpen && !hasDrawerContent && !drawerLoading && (
              <div className="drawer-empty" data-testid="detail-empty">
                <strong>暂无详情</strong>
                <span>出现草稿详情或执行进度后，详情会显示在这里。</span>
              </div>
            )}
          </div>
        </aside>
        </WindowDrawer>
      </div>
    </section>
  );
}
