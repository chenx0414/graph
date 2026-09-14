import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { NODE_LABEL, TASK_LABEL, describeQuestion, when } from './labels.ts';
import { GraphCanvas } from './GraphCanvas.tsx';
import { QuestionReply } from './Questions.tsx';
import { ErrorBox, useAsync, useEventStream } from './shared.tsx';

type Settings = { projects: { id: string; root: string }[]; models: { id: string; grade: string; credentialId?: string }[] };
type ConversationSummary = {
  id: string; title: string; projectId: string | null; anchorTaskId: string; createdAt: number; updatedAt: number | null;
  openQuestions: number; taskCount: number; status: string;
};
type ConversationMessage = {
  id: string; seq: number; role: string; kind: string; text: string; data: Record<string, unknown> | null;
  state: string; operationId: string | null; turn: number; createdAt: number; updatedAt: number;
};
type ConversationNode = { id: string; kind: string; role: string | null; status: string; used: number | null; budget: number | null; model: string | null; definitionVersion: string | null; stallCount: number; outputVersion: number };
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
  proposal: { version: number; requirementVersion: number; stale: boolean; spec: { summary: string; acceptance: { id: string; description: string; checkNode: string }[]; nodes: { id: string; kind: string; action?: string; definitionVersion?: string; model?: string; dependsOn?: string[] }[]; loops?: { from: string; to: string }[] } } | null;
  accepted: { proposalVersion: number; taskId: string; targetBranch: string; acceptedAt: number }[];
  master: { nodeId: string; status: string; model: string | null; used: number | null; budget: number | null; definitionVersion: string | null; cost: { unknown?: boolean; amount?: number } } | null;
  cost: { unknown?: boolean; amount?: number };
  usage: { used: number; budget: number };
  tasks: ConversationTask[];
  cursor: number;
};
type LiveTool = { toolCallId: string; name: string; summary: string; done: boolean };

const bubble: React.CSSProperties = { border: '1px solid #d8d8d8', padding: '8px 10px', margin: '6px 0', whiteSpace: 'pre-wrap' };

/** Home entry: start a conversation before any project or feature task exists. */
export function ConversationList({ settings }: { settings: Settings | null }) {
  const { data: conversations, error, loading, reload } = useAsync(() => api<ConversationSummary[]>('/api/conversations'), []);
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  async function start() {
    if (!text.trim()) { setFormError('先用一句话说说你想解决什么；之后可以随时补充。'); return; }
    setBusy(true);
    setFormError('');
    try {
      const created = await api<{ conversationId: string }>('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ ...(projectId ? { projectId } : {}), text, requestId: `conv-${crypto.randomUUID()}` }),
      });
      location.hash = `#/conversations/${created.conversationId}`;
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section data-testid="conversations">
      <h2>与主 Agent 对话</h2>
      <p>像聊天一样说清目标；主 Agent 会先调查、追问、给出方案草稿，你确认后才会开始执行。也可以先不选项目。</p>
      <textarea data-testid="new-conversation-input" value={text} onChange={event => setText(event.target.value)} placeholder="例如：这个项目很乱，先帮我看看能从哪里改进。" style={{ width: '100%', minHeight: 60 }} />
      <div>
        <label>项目（可留空）
          <select data-testid="new-conversation-project" value={projectId} onChange={event => setProjectId(event.target.value)}>
            <option value="">暂不选择</option>
            {(settings?.projects ?? []).map(project => <option key={project.id} value={project.id}>{project.id}</option>)}
          </select>
        </label>
        <button type="button" data-testid="new-conversation-start" disabled={busy} onClick={() => void start()}>{busy ? '创建中…' : '发起对话'}</button>
      </div>
      {formError && <ErrorBox message={formError} />}
      {error && <ErrorBox message={error} onRetry={reload} />}
      {loading && !conversations && <p>加载中…</p>}
      {conversations && !conversations.length && <p data-testid="conversation-empty">还没有对话。输入第一句话即可开始。</p>}
      {!!conversations?.length && (
        <ul data-testid="conversation-list">
          {[...conversations].reverse().map(conversation => (
            <li key={conversation.id}>
              <a href={`#/conversations/${conversation.id}`}><strong>{conversation.title}</strong></a>
              {' '}· {conversation.status === 'blocked' ? `${conversation.openQuestions} 个待处理问题` : conversation.taskCount ? `${conversation.taskCount} 个执行任务` : '对话中'}
              {conversation.projectId ? ` · ${conversation.projectId}` : ' · 未绑定项目'}
              {' '}· {when(conversation.updatedAt)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MessageRow({ message }: { message: ConversationMessage }) {
  if (message.role === 'user') {
    return (
      <div data-testid="message-user" data-state={message.state} style={{ ...bubble, background: '#eef3fb' }}>
        <strong>你</strong>
        {message.state === 'pending' && <small> · 已接收，等待主 Agent 处理</small>}
        <p style={{ margin: '4px 0 0' }}>{message.text}</p>
      </div>
    );
  }
  if (message.role === 'assistant') {
    return (
      <div data-testid="message-assistant" style={bubble}>
        <strong>主 Agent</strong>
        <p style={{ margin: '4px 0 0' }}>{message.text}</p>
      </div>
    );
  }
  if (message.role === 'tool') {
    return <div data-testid="message-tool" style={{ ...bubble, color: '#555', fontSize: 13 }}>工具 · {message.text}</div>;
  }
  return <div data-testid="message-system" style={{ ...bubble, color: '#666', fontStyle: 'italic' }}>{message.text}</div>;
}

export function ConversationPanel({ id, settings }: { id: string; settings: Settings | null }) {
  const { data: view, error, loading, reload } = useAsync(() => api<ConversationView>(`/api/conversations/${id}`), [id]);
  const { data: draftGraph } = useAsync(() => api<DraftGraph>(`/api/conversations/${id}/draft-graph`), [id, view?.proposal?.version]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState('');
  const [bindId, setBindId] = useState('');
  const [branch, setBranch] = useState('main');
  const [liveText, setLiveText] = useState<Record<string, string>>({});
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [older, setOlder] = useState<ConversationMessage[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
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
      if (message?.role === 'assistant' && message.operationId) setLiveText(current => { const next = { ...current }; delete next[message.operationId!]; return next; });
      if (message?.role === 'tool' && typeof message.data?.toolCallId === 'string') setLiveTools(current => current.filter(tool => tool.toolCallId !== message.data!.toolCallId));
    }
    refresh();
  });
  useEffect(() => {
    const latest = view?.accepted.at(-1);
    if (latest?.targetBranch) setBranch(latest.targetBranch);
  }, [view?.accepted]);
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
    try { await action(); after?.(); reload(); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function send() {
    const outgoing = text;
    if (!outgoing.trim()) return;
    setSending(true);
    setActionError('');
    try {
      await api(`/api/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: outgoing, requestId: `msg-${crypto.randomUUID()}` }) });
      // A message typed while this send was in flight must survive.
      setText(current => current === outgoing ? '' : current);
      reload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  }

  const masterQuestions = (view.questions ?? []).filter(question => question.status === 'open');
  const mergedMessages = [...older, ...view.messages].filter((message, index, list) => list.findIndex(candidate => candidate.id === message.id) === index);
  const currentMessages = view.messages;
  const oldestSeq = currentMessages[0]?.seq;
  const hasOlder = typeof oldestSeq === 'number' && oldestSeq > 1;
  async function loadOlder() {
    if (typeof oldestSeq !== 'number' || loadingOlder) return;
    setLoadingOlder(true);
    setActionError('');
    try {
      const page = await api<ConversationView>(`/api/conversations/${id}?before=${oldestSeq}&limit=200`);
      setOlder(current => {
        const seen = new Set([...current, ...currentMessages].map(message => message.id));
        return [...page.messages.filter(message => !seen.has(message.id)), ...current];
      });
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingOlder(false);
    }
  }
  return (
    <section data-testid="conversation">
      <h2 data-testid="conversation-title">{view.title}</h2>
      <p>
        {view.projectId ? <span data-testid="conversation-project">项目 {view.projectId}（{view.projectRoot}）</span> : <span data-testid="conversation-project">未绑定项目</span>}
        {' · '}主 Agent：<span data-testid="master-status">{view.paused ? '已暂停' : busy ? '正在处理…' : view.master ? NODE_LABEL[view.master.status] ?? view.master.status : '未配置'}</span>
        {' · '}<span data-testid="conversation-connection">{connected ? '已连接' : '重连中…'}</span>
        {' · '}已计量 {view.usage.used} tokens{view.cost.unknown ? ' · 费用未知' : ` · 费用 ${view.cost.amount ?? 0}`}
      </p>
      <p>
        <button type="button" data-testid="conversation-pause" onClick={() => void act(() => api(`/api/conversations/${id}/pause`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) }))}>暂停主 Agent</button>
        <button type="button" data-testid="conversation-resume" onClick={() => void act(() => api(`/api/conversations/${id}/resume`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) }))}>继续</button>
      </p>
      {!view.projectId && (
        <section data-testid="bind-project">
          <label>把这次对话绑定到项目
            <select data-testid="bind-select" value={bindId} onChange={event => setBindId(event.target.value)}>
              <option value="">选择项目…</option>
              {(settings?.projects ?? []).map(project => <option key={project.id} value={project.id}>{project.id}</option>)}
            </select>
          </label>
          <button type="button" data-testid="bind-submit" disabled={!bindId} onClick={() => void act(() => api(`/api/conversations/${id}/bind`, { method: 'POST', body: JSON.stringify({ projectId: bindId, requestId: crypto.randomUUID() }) }))}>绑定</button>
          <p style={{ color: '#666' }}>未绑定项目时主 Agent 无法读取代码；可以先聊天再选择项目。</p>
        </section>
      )}

      {masterQuestions.length > 0 && (
        <section data-testid="master-questions" style={{ border: '1px solid #e7c66b', background: '#fff9e8', padding: '8px 12px', margin: '8px 0' }}>
          <h3 style={{ margin: '0 0 6px' }}>主 Agent 需要你的处理</h3>
          <ul data-testid="master-questions-list">
            {masterQuestions.map(question => <QuestionReply key={question.id} taskId={question.taskId} question={question} onDone={() => void reload()} />)}
          </ul>
        </section>
      )}

      <div data-testid="message-list">
        {hasOlder && <button type="button" data-testid="load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? '加载中…' : '载入更早消息'}</button>}
        {mergedMessages.map(message => <MessageRow key={message.id} message={message} />)}
        {liveEntries.map(([operationId, chunk]) => (
          <div key={operationId} data-testid="streaming" style={bubble}>
            <strong>主 Agent</strong> <small>正在输入…</small>
            <p style={{ margin: '4px 0 0' }}>{chunk}</p>
          </div>
        ))}
        {liveTools.filter(tool => !durableToolIds.has(tool.toolCallId)).map(tool => (
          <div key={tool.toolCallId} data-testid="tool-activity" style={{ ...bubble, color: '#555', fontSize: 13 }}>
            工具 · {tool.name} {tool.summary} {tool.done ? '（完成）' : '（进行中）'}
          </div>
        ))}
      </div>

      <div>
        <textarea data-testid="chat-input" value={text} onChange={event => setText(event.target.value)} placeholder={busy ? '主 Agent 正在处理；继续输入会排队，不会被丢掉。' : '继续交流，或追问执行进度…'} style={{ width: '100%', minHeight: 60 }} />
        <button type="button" data-testid="chat-send" disabled={sending || !text.trim()} onClick={() => void send()}>{sending ? '发送中…' : '发送'}</button>
        {busy && <span data-testid="queued-hint" style={{ marginLeft: 8, color: '#666' }}>主 Agent 正在处理，消息会排队。</span>}
      </div>
      {actionError && <ErrorBox message={actionError} />}

      <section data-testid="strategy">
        <h3>策略与图</h3>
        {!proposal && <p data-testid="no-draft">还没有草稿。继续讨论，主 Agent 认为可行时会提出可确认的草稿。</p>}
        {proposal && (
          <div data-testid="proposal-draft">
            <h4>草稿 v{proposal.version}{proposal.stale ? '（已过期）' : ''}</h4>
            <p>{proposal.spec.summary}</p>
            <h5>验收项</h5>
            <ul>{proposal.spec.acceptance.map(item => <li key={item.id}>{item.id}：{item.description}（检查节点 {item.checkNode}）</li>)}</ul>
            <h5>节点</h5>
            <ul>{proposal.spec.nodes.map(node => (
              <li key={node.id}>{node.id} · {node.kind}{node.action ? ` · ${node.action}` : ''}{node.model ? ` · 模型 ${node.model}` : ''}{node.definitionVersion ? ` · ${node.definitionVersion}` : ''}{node.dependsOn?.length ? ` · 依赖 ${node.dependsOn.join(',')}` : ''}</li>
            ))}</ul>
            {draftGraph && draftGraph.nodes.length > 0 && (
              <div data-testid="draft-graph" style={{ height: 480, border: '1px solid #d8d8d8', marginTop: 8, position: 'relative' }}>
                <GraphCanvas graph={{ nodes: draftGraph.nodes, containers: draftGraph.containers, layout: draftGraph.layout }} collapsed={{}} onSelect={() => undefined} />
              </div>
            )}
            {(proposal.spec.loops?.length ?? 0) > 0 && (
              <p data-testid="draft-loops">返工回边：{proposal.spec.loops!.map(loop => `${loop.from} → ${loop.to}`).join('，')}</p>
            )}
            {proposal.stale && <p data-testid="draft-stale">需求已变化，这个草稿不能执行；请让主 Agent 针对最新需求重新提案。</p>}
            {acceptedVersions.has(proposal.version) && <p data-testid="draft-accepted">此草稿已确认，执行任务见下方。</p>}
            {confirmable && !view.projectId && <p data-testid="draft-needs-project">确认前需要先绑定项目。</p>}
            {confirmable && view.projectId && (
              <div>
                <label>目标分支 <input data-testid="accept-branch" value={branch} onChange={event => setBranch(event.target.value)} /></label>
                <button type="button" data-testid="confirm-draft" onClick={() => void act(() => api(`/api/conversations/${id}/confirm`, { method: 'POST', body: JSON.stringify({ proposalVersion: proposal.version, targetBranch: branch, requestId: `confirm-${crypto.randomUUID()}` }) }))}>确认草稿并开始执行</button>
              </div>
            )}
          </div>
        )}
      </section>

      <section data-testid="conversation-tasks">
        <h3>执行中的功能任务</h3>
        {!view.tasks.length && <p data-testid="no-conversation-tasks">尚无功能任务。确认草稿后才会创建并开始执行。</p>}
        {view.tasks.map(task => (
          <div key={task.id} data-testid={`conversation-task-${task.id}`}>
            <h4><a href={`#/tasks/${task.id}`}>{task.request}</a> · {TASK_LABEL[task.status] ?? task.status}</h4>
            <p>{task.targetBranch ? `目标分支 ${task.targetBranch}` : '目标分支未确认'}{task.integrationSha ? ` · 集成提交 ${task.integrationSha.slice(0, 10)}` : ''} · {task.cost.unknown ? '费用未知' : `费用 ${task.cost.amount ?? 0}`}{task.paused ? ' · 已暂停' : ''}</p>
            <ul data-testid={`conversation-nodes-${task.id}`}>
              {task.nodes.map(node => (
                <li key={node.id} data-node={node.id} data-status={node.status}>{node.id} · {NODE_LABEL[node.status] ?? node.status}{node.used != null ? ` · 用量 ${node.used}` : ''}{node.model ? ` · ${node.model}` : ''}</li>
              ))}
            </ul>
            {task.openQuestions.length > 0 && (
              <ul data-testid={`conversation-questions-${task.id}`}>
                {task.openQuestions.map(question => <QuestionReply key={question.id} taskId={task.id} question={question} onDone={() => void reload()} />)}
              </ul>
            )}
            {task.openQuestions.length > 0 && <p style={{ color: '#8a6d00' }}>{task.openQuestions.map(question => describeQuestion(question.kind)).join('、')}</p>}
          </div>
        ))}
      </section>
    </section>
  );
}
