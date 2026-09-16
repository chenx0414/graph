import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { formatTokens } from './insights.ts';
import { NODE_LABEL, TASK_LABEL, describeQuestion } from './labels.ts';
import { GraphCanvas } from './GraphCanvas.tsx';
import { Markdown } from './Markdown.tsx';
import { QuestionReply } from './Questions.tsx';
import { ErrorBox, costText, useAsync, useEventStream } from './shared.tsx';
import { Button, Icon, Pill, StatusDot } from './ui.tsx';

type Settings = { projects: { id: string; root: string }[]; models: { id: string; grade: string; credentialId?: string }[] };
export type ConversationSummary = {
  id: string; title: string; projectId: string | null; anchorTaskId: string; createdAt: number; updatedAt: number | null;
  openQuestions: number; taskCount: number; status: string;
};
type ConversationMessage = {
  id: string; seq: number; role: string; kind: string; text: string; data: Record<string, unknown> | null;
  state: string; operationId: string | null; turn: number; createdAt: number; updatedAt: number;
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
type DraftGraph = {
  nodes: { id: string; kind: string; status: string; container?: string }[];
  containers: { id: string; parent?: string }[];
  loops: { from: string; to: string }[];
  layout: { positions: Record<string, { x: number; y: number; width: number; height: number }>; edges: { id: string; source: string; target: string }[] };
};
type AnchorQuestion = { id: string; nodeId: string; operationId: string | null; kind: string; status: string; data: Record<string, unknown>; answer: Record<string, unknown> | null; taskId: string };
type ConversationView = {
  id: string; title: string; projectId: string | null; projectRoot: string | null; workspaceProjectId: string; anchorTaskId: string;
  createdAt: number; requirementVersion: number; paused: boolean;
  messages: ConversationMessage[]; messageCount: number;
  questions: AnchorQuestion[];
  proposal: { version: number; requirementVersion: number; stale: boolean; decisions: string | null; spec: { summary: string; acceptance: { id: string; description: string; checkNode: string }[]; nodes: { id: string; kind: string; action?: string; definitionVersion?: string; model?: string; dependsOn?: string[] }[]; loops?: { from: string; to: string }[] } } | null;
  accepted: { proposalVersion: number; taskId: string; targetBranch: string; acceptedAt: number }[];
  master: { nodeId: string; status: string; model: string | null; used: number | null; budget: number | null; unlimited?: boolean; definitionVersion: string | null; cost: { unknown?: boolean; amount?: number } } | null;
  cost: { unknown?: boolean; amount?: number };
  usage: { used: number; budget: number | null; unlimited?: boolean };
  tasks: ConversationTask[];
  cursor: number;
};
type LiveTool = { toolCallId: string; name: string; summary: string; done: boolean };

const TASK_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'> = {
  discussing: 'info', running: 'accent', queued: 'neutral', paused: 'warn', pausing: 'warn',
  blocked: 'warn', completed: 'success', failed: 'danger', skipped: 'neutral',
};
const NODE_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'> = {
  pending: 'neutral', ready: 'info', preparing: 'accent', running: 'accent',
  succeeded: 'success', failed: 'danger', blocked: 'warn', skipped: 'neutral',
};

function MessageRow({ message }: { message: ConversationMessage }) {
  if (message.role === 'user') {
    return (
      <div className="message-row" data-role="user" data-testid="message-user" data-state={message.state}>
        <div className="message-stack">
          <div className="message-author">我{message.state === 'pending' && <span className="message-state"> · 等待处理</span>}</div>
          <div className="message-content"><p>{message.text}</p></div>
        </div>
      </div>
    );
  }
  if (message.role === 'assistant') {
    return (
      <div className="message-row" data-role="assistant" data-testid="message-assistant">
        <div className="message-stack">
          <div className="message-author">主 Agent</div>
          <div className="message-content"><Markdown text={message.text} /></div>
        </div>
      </div>
    );
  }
  if (message.role === 'tool') {
    return <div className="message-row" data-role="tool" data-testid="message-tool"><div className="message-stack"><div className="message-content">工具 · {message.text}</div></div></div>;
  }
  return <div className="message-row" data-role="system" data-testid="message-system"><div className="message-stack"><div className="message-content">{message.text}</div></div></div>;
}

/** Tool activity belongs to the assistant turn, but the final answer should
 * close that turn. Move adjacent tool records ahead of the answer they support
 * without changing the order of independent turns. */
function orderedMessages(messages: ConversationMessage[]) {
  const ordered: ConversationMessage[] = [];
  for (let index = 0; index < messages.length;) {
    if (messages[index]!.role !== 'assistant') {
      ordered.push(messages[index]!);
      index += 1;
      continue;
    }
    const answers: ConversationMessage[] = [];
    const tools: ConversationMessage[] = [];
    while (index < messages.length && (messages[index]!.role === 'assistant' || messages[index]!.role === 'tool')) {
      if (messages[index]!.role === 'assistant') answers.push(messages[index]!);
      else tools.push(messages[index]!);
      index += 1;
    }
    ordered.push(...tools, ...answers);
  }
  return ordered;
}

export function ConversationPanel({ id, settings, onChanged }: { id: string; settings: Settings | null; onChanged?: () => void }) {
  const { data: view, error, loading, reload } = useAsync(() => api<ConversationView>(`/api/conversations/${id}`), [id]);
  const { data: draftGraph } = useAsync(() => api<DraftGraph>(`/api/conversations/${id}/draft-graph`), [id, view?.proposal?.version]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState('');
  const [bindId, setBindId] = useState('');
  const [branch, setBranch] = useState('main');
  const [liveText, setLiveText] = useState<Record<string, string>>({});
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [cache, setCache] = useState<Record<string, ConversationMessage>>({});
  const [historyExhausted, setHistoryExhausted] = useState(false);
  const [forwardCursor, setForwardCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  // One stable, seq-ordered cache per mounted conversation. Every source
  // (latest window, history pages, streamed message records) merges by stable
  // ID and only newer records may replace older ones, so a late history
  // response cannot roll a state change back.
  const mergeMessages = useCallback((incoming: ConversationMessage[]) => {
    if (!incoming.length) return;
    setCache(current => {
      let changed = false;
      const next = { ...current };
      for (const message of incoming) {
        const previous = next[message.id];
        if (previous && message.updatedAt < previous.updatedAt) continue;
        if (!previous || previous.text !== message.text || previous.state !== message.state || previous.updatedAt !== message.updatedAt) {
          next[message.id] = message;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(() => {
    // One event usually means several records changed; coalesce the refetches.
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => reload(), 150);
  }, [reload]);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
  const connected = useEventStream(view ? `/api/conversations/${view.id}/events/stream` : null, event => {
    const data = event.data as { operationId?: string; text?: string; message?: ConversationMessage; phase?: string; toolCallId?: string; toolName?: string; summary?: string } | undefined;
    if (event.type === 'message.delta' && data?.text) {
      setLiveText(current => ({ ...current, [data.operationId ?? 'stream']: (current[data.operationId ?? 'stream'] ?? '') + data.text }));
    } else if (event.type === 'message.tool' && data?.toolCallId) {
      setLiveTools(current => {
        const next = current.filter(tool => tool.toolCallId !== data.toolCallId);
        return [...next, { toolCallId: data.toolCallId!, name: data.toolName ?? 'tool', summary: data.summary ?? '', done: data.phase === 'end' }];
      });
    } else if (event.type === 'message.created' || event.type === 'message.updated') {
      const message = data?.message;
      // Incremental contract: state changes always merge, while replayed or
      // historical created records must not bypass pagination (the latest
      // window plus explicit history pages own backfill). Only records newer
      // than everything cached extend the live window.
      if (message?.id) {
        const knownMax = Object.values(cache).reduce((max, candidate) => Math.max(max, candidate.seq), 0);
        if (event.type === 'message.updated' || message.seq > knownMax) mergeMessages([message]);
      }
      if (message?.role === 'assistant' && message.operationId) setLiveText(current => { const next = { ...current }; delete next[message.operationId!]; return next; });
      if (message?.role === 'tool' && typeof message.data?.toolCallId === 'string') setLiveTools(current => current.filter(tool => tool.toolCallId !== message.data!.toolCallId));
    }
    refresh();
  });
  useEffect(() => {
    const latest = view?.accepted.at(-1);
    if (latest?.targetBranch) setBranch(latest.targetBranch);
  }, [view?.accepted]);
  useEffect(() => {
    if (view) mergeMessages(view.messages);
  }, [view, mergeMessages]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const thread = threadRef.current;
      if (thread) thread.scrollTop = thread.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [view?.messages.length, liveText, view?.proposal?.version, view?.tasks.length]);
  if (loading && !view) return <p>加载中…</p>;
  if (error && !view) return <ErrorBox message={error} onRetry={reload} />;
  if (!view) return <p>加载中…</p>;

  const acceptedVersions = new Set(view.accepted.map(item => item.proposalVersion));
  const proposal = view.proposal;
  const confirmable = Boolean(proposal && !proposal.stale && !acceptedVersions.has(proposal.version));
  const busy = view.master?.status === 'preparing' || view.master?.status === 'running';
  const durableAssistantOps = new Set(view.messages.filter(message => message.role === 'assistant' && message.operationId).map(message => message.operationId!));
  const durableToolIds = new Set(view.messages.filter(message => message.role === 'tool' && typeof message.data?.toolCallId === 'string').map(message => String(message.data!.toolCallId)));
  const liveEntries = Object.entries(liveText).filter(([operationId]) => !durableAssistantOps.has(operationId));

  async function act(action: () => Promise<unknown>, after?: () => void) {
    setActionError('');
    try { await action(); after?.(); reload(); onChanged?.(); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function send() {
    const outgoing = text.trim();
    if (!outgoing) return;
    setText('');
    setSending(true);
    setActionError('');
    try {
      await api(`/api/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: outgoing, requestId: `msg-${crypto.randomUUID()}` }) });
      reload();
      onChanged?.();
    } catch (reason) {
      setText(current => current || outgoing);
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  }

  const masterQuestions = (view.questions ?? []).filter(question => question.status === 'open');
  const cachedMessages = Object.values(cache).sort((left, right) => left.seq - right.seq);
  const currentMessages = view.messages;
  const totalMessages = view.messageCount;
  const hasOlder = !historyExhausted && totalMessages > cachedMessages.length;
  async function loadOlder() {
    if (loadingOlder) return;
    if (totalMessages <= cachedMessages.length) { setHistoryExhausted(true); return; }
    setLoadingOlder(true);
    setActionError('');
    try {
      // `messages.seq` is a global sequence shared by every conversation, so a
      // step in the numbers is not evidence of a missing record here. History
      // is always fetched by the conversation's own filters: first older than
      // the earliest known record, and only once that is exhausted does a
      // forward cursor sweep any remaining middle/latest records.
      const earliest = cachedMessages[0]?.seq;
      if (earliest !== undefined && earliest > 1) {
        const older = await api<ConversationView>(`/api/conversations/${id}?before=${earliest}&limit=200`);
        if (older.messages.length) { mergeMessages(older.messages); return; }
      }
      // Start the sweep from the tail of the records known to precede the
      // latest window, so a burst fills its hole instead of re-walking the
      // whole conversation; the cursor then advances page by page.
      const windowStart = currentMessages[0]?.seq;
      const belowWindow = windowStart === undefined ? cachedMessages : cachedMessages.filter(message => message.seq < windowStart);
      const base = belowWindow.length ? belowWindow[belowWindow.length - 1]!.seq : (earliest ?? 0);
      const cursor = forwardCursor === null ? base : Math.max(forwardCursor, base);
      const forward = await api<ConversationView>(`/api/conversations/${id}?after=${cursor}&limit=200`);
      if (!forward.messages.length) { setHistoryExhausted(true); return; }
      mergeMessages(forward.messages);
      setForwardCursor(forward.messages[forward.messages.length - 1]!.seq);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingOlder(false);
    }
  }
  const tasks = view.tasks;
  const detailTask = tasks.find(task => task.id === drawer);
  const detailAvailable = Boolean(proposal || tasks.length);
  const displayMessages = orderedMessages(cachedMessages);
  function openDrawer(next: string) {
    setDrawer(next);
    setDrawerOpen(true);
  }
  function toggleDrawer() {
    if (drawerOpen) { setDrawerOpen(false); return; }
    const next = drawer === 'proposal' && proposal
      ? 'proposal'
      : drawer && tasks.some(task => task.id === drawer)
        ? drawer
        : proposal ? 'proposal' : tasks[0]?.id;
    if (next) openDrawer(next);
  }
  return (
    <section className="conversation-page" data-testid="conversation">
      <header className="conversation-header">
        <div className="conversation-heading">
          <h1 data-testid="conversation-title">{view.title}</h1>
          <div className="conversation-meta">
            {view.projectId ? <span data-testid="conversation-project">项目 {view.projectId}</span> : <span data-testid="conversation-project">未绑定项目</span>}
            <span>·</span>
            <span data-testid="master-status">{view.paused ? '已暂停' : busy ? '正在处理…' : view.master ? NODE_LABEL[view.master.status] ?? view.master.status : '未配置'}</span>
            <span>·</span>
            <span data-testid="conversation-connection">{connected ? '已连接' : '重连中…'}</span>
            <span>·</span>
            <span>已计量 {formatTokens(view.usage.used)} tokens · {costText(view.cost)}</span>
          </div>
        </div>
        <div className="conversation-actions">
          <Button size="sm" icon="pause" data-testid="conversation-pause" onClick={() => void act(() => api(`/api/conversations/${id}/pause`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) }))}>暂停</Button>
          <Button size="sm" icon="play" variant="primary" data-testid="conversation-resume" onClick={() => void act(() => api(`/api/conversations/${id}/resume`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) }))}>继续</Button>
          {detailAvailable && !drawerOpen && (
            <button type="button" className="icon-button" data-testid="detail-toggle" onClick={toggleDrawer} title="展开右侧抽屉" aria-label="展开右侧抽屉">
              <Icon name="panel-right" size={16} />
            </button>
          )}
        </div>
      </header>

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

      <div className="conversation-body" data-drawer={drawerOpen}>
        <div className="conversation-thread" data-testid="message-list" ref={threadRef}>
          {hasOlder && <button type="button" className="btn btn-sm" data-testid="load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? '加载中…' : '载入更早消息'}</button>}
          {displayMessages.map(message => <MessageRow key={message.id} message={message} />)}
          {liveTools.filter(tool => !durableToolIds.has(tool.toolCallId)).map(tool => (
            <div key={tool.toolCallId} className="message-row" data-role="tool" data-testid="tool-activity">
              <div className="message-stack"><div className="message-content">工具 · {tool.name} {tool.summary} {tool.done ? '（完成）' : '（进行中）'}</div></div>
            </div>
          ))}
          {liveEntries.map(([operationId, chunk]) => (
            <div key={operationId} className="message-row" data-role="assistant" data-testid="streaming">
              <div className="message-stack">
                <div className="message-author">主 Agent · 正在输入…</div>
                <div className="message-content streaming-card"><Markdown text={chunk} /></div>
              </div>
            </div>
          ))}

          {!view.tasks.length && (
            <div className="thread-action-card" data-testid="no-conversation-tasks">
              <div className="thread-card-title">尚无功能任务</div>
              <div className="thread-card-copy">确认草稿后才会创建并开始执行。</div>
            </div>
          )}

          {proposal && (
            <article className="thread-action-card" data-testid="proposal-draft">
              <div className="thread-card-head">
                <div className="grow">
                  <div className="thread-card-title">
                    草稿 v{proposal.version}
                    {proposal.stale ? '（已过期）' : acceptedVersions.has(proposal.version) ? '（已确认）' : ''}
                  </div>
                  <div className="thread-card-copy">{proposal.spec.summary}</div>
                </div>
                <Pill tone={proposal.stale ? 'warn' : acceptedVersions.has(proposal.version) ? 'success' : 'info'}>
                  {proposal.stale ? '需重新讨论' : acceptedVersions.has(proposal.version) ? `已确认草稿 v${proposal.version}` : '待确认'}
                </Pill>
              </div>
              <div className="thread-card-actions">
                <button type="button" className="summary-graph-preview" data-testid="draft-graph" onClick={() => openDrawer('proposal')}>
                  <Icon name="graph" size={14} />
                  任务图 · {proposal.spec.nodes.length} 个节点
                </button>
                <button type="button" className="summary-graph-preview" onClick={() => openDrawer('proposal')}>
                  <Icon name="check" size={14} />
                  验收项 · {proposal.spec.acceptance.length}
                </button>
              </div>
              {proposal.stale && <p data-testid="draft-stale" className="muted">需求已变化，这个草稿不能执行；请让主 Agent 针对最新需求重新提案。</p>}
              {acceptedVersions.has(proposal.version) && <p data-testid="draft-accepted" className="muted">已确认草稿 v{proposal.version}，执行状态见下方任务摘要。</p>}
              {confirmable && !view.projectId && <p data-testid="draft-needs-project" className="muted">确认前需要先绑定项目。</p>}
              {confirmable && view.projectId && (
                <>
                  <p data-testid="draft-budget" className="muted" style={{ fontSize: 12 }}>
                    主管已用 {formatTokens(view.master?.used ?? 0)} tokens；{!view.master || view.master.unlimited || view.master.budget === null ? '当前不设累计上限' : `当前上限 ${formatTokens(view.master.budget)}`}。
                  </p>
                  <div className="thread-card-actions">
                    <label className="row" style={{ gap: 6 }}>
                      <span className="muted">目标分支</span>
                      <input className="input" style={{ width: 150, maxWidth: 150 }} data-testid="accept-branch" value={branch} onChange={event => setBranch(event.target.value)} />
                    </label>
                    <Button variant="primary" icon="check" data-testid="confirm-draft" onClick={() => void act(() => api(`/api/conversations/${id}/confirm`, { method: 'POST', body: JSON.stringify({ proposalVersion: proposal.version, targetBranch: branch, requestId: `confirm-${crypto.randomUUID()}` }) }))}>确认草稿并开始执行</Button>
                  </div>
                </>
              )}
            </article>
          )}

          {view.tasks.map(task => (
            <article className="thread-action-card" key={task.id} data-testid={`conversation-task-${task.id}`}>
              <div className="thread-card-head">
                <div className="grow">
                  <div className="thread-card-title">{task.request}</div>
                  <div className="thread-card-copy">
                    {task.targetBranch ? `目标分支 ${task.targetBranch}` : '目标分支未确认'}
                    {task.integrationSha ? ` · 集成提交 ${task.integrationSha.slice(0, 10)}` : ''}
                    {' · '}{costText(task.cost)}{task.paused ? ' · 已暂停' : ''}
                  </div>
                </div>
                <Pill tone={TASK_TONE[task.status] ?? 'neutral'}>{TASK_LABEL[task.status] ?? task.status}</Pill>
                <button type="button" className="icon-button" onClick={() => openDrawer(task.id)} title="查看执行详情" aria-label="查看执行详情">
                  <Icon name="chevron" size={15} />
                </button>
              </div>
              <ul className="node-summary-list" data-testid={`conversation-nodes-${task.id}`}>
                {task.nodes.map(node => (
                  <li key={node.id} data-node={node.id} data-status={node.status}>
                    <span className="dot" data-tone={NODE_TONE[node.status] ?? 'neutral'} />
                    <a href={`#/tasks/${task.id}/nodes/${node.id}`} data-testid={`conversation-node-link-${task.id}-${node.id}`}>{node.id}</a>
                    <span>{NODE_LABEL[node.status] ?? node.status}</span>
                  </li>
                ))}
              </ul>
              {task.openQuestions.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div className="muted">{task.openQuestions.map(question => describeQuestion(question.kind)).join('、')}</div>
                  <ul className="list" data-testid={`conversation-questions-${task.id}`}>
                    {task.openQuestions.map(question => <QuestionReply key={question.id} taskId={task.id} question={question} onDone={() => { void reload(); onChanged?.(); }} />)}
                  </ul>
                </div>
              )}
            </article>
          ))}

          {!view.projectId && (
            <section className="thread-action-card binding-card" data-testid="bind-project">
              <div className="thread-card-title">绑定项目</div>
              <div className="thread-card-copy">未绑定项目时主 Agent 无法读取代码；可以先聊天再选择项目。</div>
              <div className="thread-card-actions">
                <select className="select" style={{ width: 220 }} data-testid="bind-select" value={bindId} onChange={event => setBindId(event.target.value)}>
                  <option value="">选择项目…</option>
                  {(settings?.projects ?? []).map(project => <option key={project.id} value={project.id}>{project.id}</option>)}
                </select>
                <Button size="sm" data-testid="bind-submit" disabled={!bindId} onClick={() => void act(() => api(`/api/conversations/${id}/bind`, { method: 'POST', body: JSON.stringify({ projectId: bindId, requestId: crypto.randomUUID() }) }))}>绑定</Button>
              </div>
            </section>
          )}
        </div>

        {drawerOpen && drawer && (
          <aside className="detail-drawer" data-testid="detail-drawer">
            <div className="drawer-head">
              <h2>{detailTask?.request ?? `草稿 v${proposal?.version ?? ''}`}</h2>
              <button type="button" className="icon-button" data-testid="detail-toggle-close" onClick={() => setDrawerOpen(false)} aria-label="收起右侧抽屉" title="收起右侧抽屉">
                <Icon name="panel-right" size={16} />
              </button>
            </div>
            {drawer === 'proposal' && proposal && (
              <>
                <section className="drawer-section" data-testid="strategy">
                  <h3>验收项</h3>
                  <ul className="list">
                    {proposal.spec.acceptance.map(item => <li className="list-item" key={item.id}>{item.id}：{item.description}<small>检查节点 {item.checkNode}</small></li>)}
                  </ul>
                  <h3 style={{ marginTop: 14 }}>节点</h3>
                  <ul className="list">
                    {proposal.spec.nodes.map(node => (
                      <li className="list-item" key={node.id}>
                        <span className="grow">{node.id} · {node.kind}{node.action ? ` · ${node.action}` : ''}</span>
                        <small>{node.model ?? ''}{node.definitionVersion ? ` · ${node.definitionVersion}` : ''}{node.dependsOn?.length ? ` · 依赖 ${node.dependsOn.join(',')}` : ''}</small>
                      </li>
                    ))}
                  </ul>
                  {draftGraph && draftGraph.nodes.length > 0 && (
                    <div className="drawer-graph" data-testid="draft-graph-detail">
                      <GraphCanvas graph={{ nodes: draftGraph.nodes, containers: draftGraph.containers, layout: draftGraph.layout }} collapsed={{}} onSelect={() => undefined} />
                    </div>
                  )}
                  {(proposal.spec.loops?.length ?? 0) > 0 && (
                    <p data-testid="draft-loops">返工回边：{proposal.spec.loops!.map(loop => `${loop.from} → ${loop.to}`).join('，')}</p>
                  )}
                  {proposal.decisions !== null && (
                    <div data-testid="draft-decisions">
                      <h3 style={{ marginTop: 14 }}>决策与约束</h3>
                      {proposal.decisions.trim()
                        ? <pre>{proposal.decisions}</pre>
                        : <p data-testid="draft-decisions-empty" className="muted">主管已声明本任务没有需要传递的决策或约束。</p>}
                    </div>
                  )}
                </section>
              </>
            )}
            {detailTask && (
              <section className="drawer-section" data-testid="conversation-tasks">
                <h3>执行详情</h3>
                <dl className="kv">
                  <dt>状态</dt><dd>{TASK_LABEL[detailTask.status] ?? detailTask.status}</dd>
                  <dt>目标分支</dt><dd>{detailTask.targetBranch ?? '未确认'}</dd>
                  <dt>集成提交</dt><dd className="mono">{detailTask.integrationSha ?? '尚无'}</dd>
                  <dt>费用</dt><dd>{costText(detailTask.cost)}</dd>
                </dl>
                <ul className="list" style={{ marginTop: 12 }}>
                  {detailTask.nodes.map(node => (
                    <li className="list-item" key={node.id}>
                      <StatusDot tone={NODE_TONE[node.status] ?? 'neutral'} />
                      <div className="grow">
                        <a href={`#/tasks/${detailTask.id}/nodes/${node.id}`}>{node.id}</a>
                        <div className="muted">{NODE_LABEL[node.status] ?? node.status}{node.used != null ? ` · 用量 ${node.used}` : ' · 用量未知'}{node.model ? ` · ${node.model}` : ''}</div>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="row" style={{ marginTop: 12 }}>
                  <a className="btn btn-sm" href={`#/tasks/${detailTask.id}`}>打开任务</a>
                  <a className="btn btn-sm" href={`#/tasks/${detailTask.id}/graph`}>打开任务图</a>
                </div>
              </section>
            )}
          </aside>
        )}
      </div>

      <div className="conversation-composer-wrap">
        {actionError && <ErrorBox message={actionError} />}
        <div className="conversation-composer">
          <textarea
            data-testid="chat-input"
            value={text}
            onChange={event => setText(event.target.value)}
            placeholder={busy ? '主 Agent 正在处理；继续输入会排队，不会被丢掉。' : '继续交流，或追问执行进度…'}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button type="button" className="icon-button primary" data-testid="chat-send" disabled={!text.trim()} aria-busy={sending} onClick={() => void send()} aria-label="发送消息">
            <Icon name="send" size={17} />
          </button>
        </div>
        <div className="composer-note">
          {busy ? <span data-testid="queued-hint">主 Agent 正在处理，消息会排队。</span> : 'Enter 发送，Shift + Enter 换行'}
        </div>
      </div>
    </section>
  );
}
