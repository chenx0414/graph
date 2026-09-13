import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { nextEventCursor } from './event-cursor.ts';
import { GraphCanvas } from './GraphCanvas.tsx';

type TaskSummary = {
  id: string; projectId: string; request: string; phase: string; status: string;
  acceptedProposalVersion: number | null; updatedAt: number | null;
};
type Startup = { mode: 'view' | 'execute'; configured: boolean; modelCount: number; enabledModelCount: number };
type TaskView = {
  id: string; projectId: string; request: string; phase: string; status: string; paused: boolean; proposalVersion: number;
  acceptedProposalVersion: number | null; targetBranch: string | null; updatedAt: number | null;
  messages: { cursor: number; text: string; requirementVersion: number }[];
  questions: { id: string; kind: string; status: string; nodeId: string; data: { prompt?: string; grant?: string } }[];
  nodes: NodeView[];
  evidence: { nodeId: string; acceptanceId: string; summary: string; valid: boolean; artifact?: { path: string; digest: string } }[];
  operations: { nodeId: string; state: string; result?: { output?: unknown } | null }[];
  cost: { unknown?: boolean; amount?: number };
  proposal: {
    summary?: string; acceptance: { id: string; description: string; checkNode: string }[];
    nodes: { id: string; kind: string; action?: string; definitionVersion?: string; model?: string; dependsOn?: string[] }[];
  } | null;
};
type NodeView = {
  id: string; kind: string; status: string; container?: string; used?: number | null; budget?: number | null;
  reserved?: number; instanceId?: string | null; selectedModel?: string; boundDefinition?: string;
  activationId?: string; outputVersion?: number; stallCount?: number;
};
type Settings = { projects: { id: string; root: string }[]; models: { id: string; grade: string }[]; definitions: { id: string; version: number }[]; capabilities: { id: string; version: string }[] };
type GraphPayload = {
  nodes: NodeView[];
  containers: { id: string; parent?: string; nodes: string[] }[];
  loops: { from: string; to: string; reason?: string }[];
  revisions: { version: number; reason: string }[];
  layout: { positions: Record<string, { x: number; y: number; width: number; height: number }>; edges: { id: string; source: string; target: string }[] };
  cost: { unknown?: boolean; amount?: number };
};

const TASK_LABEL: Record<string, string> = {
  discussing: '讨论中', running: '执行中', queued: '排队中', paused: '已暂停', pausing: '暂停中',
  blocked: '等待处理', completed: '已完成', failed: '失败', skipped: '已跳过',
};
const NODE_LABEL: Record<string, string> = {
  pending: '待执行', preparing: '执行中', succeeded: '已完成', failed: '失败', blocked: '被阻塞', skipped: '已跳过', ready: '就绪',
};
const QUESTION_LABEL: Record<string, string> = {
  waiting: '等待外部条件', human_check: '等待人工确认', reservation_exceeded: '预算不足',
  unknown_usage: '用量未知待核对', model_unavailable: '模型不可用', adapter_error: '适配器错误',
  execution_failed: '执行失败', git_conflict: 'Git 冲突', rework: '需要返工', stalled: '任务停滞',
  permission: '等待权限确认', budget: '预算不足', git_dirty: '工作区不干净',
};

function statusText(view: TaskView) {
  if (view.paused) return TASK_LABEL[view.status] ?? view.status;
  const open = view.questions.filter(question => question.status === 'open');
  if (open.length) return open.map(question => QUESTION_LABEL[question.kind] ?? question.kind).join('、');
  return TASK_LABEL[view.status] ?? view.status;
}

function when(timestamp: number | null) {
  if (!timestamp) return '—';
  return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toLocaleString();
}

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div data-testid="error" style={{ background: '#fde8e8', border: '1px solid #e0a0a0', padding: '8px 12px', margin: '8px 0' }}>
      <strong>加载失败：</strong>{message}
      {onRetry && <button type="button" style={{ marginLeft: 8 }} onClick={onRetry}>重试</button>}
    </div>
  );
}

function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  // A different key (task id) must not keep showing the previous record.
  useEffect(() => { setData(null); setError(null); }, deps);
  const reload = useCallback(() => {
    setLoading(true);
    loadRef.current()
      .then(value => { setData(value); setError(null); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload };
}

/** EventSource with an event cursor. Reconnects from the last applied cursor,
 * so a drop replays only what was missed and duplicate deliveries are ignored. */
export function useTaskStream(taskId: string, onEvent: (event: { cursor: number; type: string }) => void) {
  const [connected, setConnected] = useState(false);
  const cursor = useRef(0);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    cursor.current = 0;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const open = () => {
      if (closed) return;
      source = new EventSource(`/api/tasks/${taskId}/events/stream?after=${cursor.current}`);
      source.onopen = () => setConnected(true);
      source.onmessage = message => {
        try {
          const event = nextEventCursor(cursor.current, JSON.parse(message.data));
          if (!event) return;
          cursor.current = event.cursor;
          handler.current(event);
        } catch { /* keep the stream on malformed frames */ }
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        source = null;
        if (!closed) timer = setTimeout(open, 1000);
      };
    };
    open();
    return () => { closed = true; clearTimeout(timer); source?.close(); };
  }, [taskId]);
  return connected;
}

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  return hash;
}

export function App() {
  const [path, setPath] = useState(route);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [startup, setStartup] = useState<Startup | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  useEffect(() => {
    const onHash = () => setPath(route());
    window.addEventListener('hashchange', onHash);
    void api<Settings>('/api/settings').then(setSettings);
    void api<Startup>('/api/startup').then(setStartup);
    void api<TaskSummary[]>('/api/tasks').then(setTasks);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const taskMatch = /^\/tasks\/([^/]+)(\/graph)?$/.exec(path);
  return (
    <div>
      {startup && !startup.configured && (
        <div style={{ background: '#fff4d6', borderBottom: '1px solid #e7c66b', padding: '8px 12px' }}>
          {startup.modelCount === 0
            ? '首次运行：未配置模型，当前为仅查看模式，任务不会被派发。请在 graph.config.json 中添加模型与凭据后重启。'
            : '模型已配置但凭据未解析，当前为仅查看模式，任务不会被派发。请设置凭据引用的环境变量后重启。'}
        </div>
      )}
      {startup?.mode === 'view' && startup.configured && (
        <div style={{ background: '#eef3fb', borderBottom: '1px solid #b9cbe8', padding: '8px 12px' }}>
          仅查看模式：可浏览与配置，不派发模型请求。使用 --execute 启动以启用调度。
        </div>
      )}
      <nav>
        <a href="#/">概览</a>
        <a href="#/catalog">人才库</a>
      </nav>
      {path === '/' && <Overview settings={settings} tasks={tasks} onTasks={setTasks} />}
      {path === '/catalog' && <Catalog settings={settings} />}
      {taskMatch && !taskMatch[2] && <TaskPanel id={taskMatch[1]!} onTasks={setTasks} />}
      {taskMatch?.[2] && <GraphPanel id={taskMatch[1]!} />}
    </div>
  );
}

function Overview({ settings, tasks, onTasks }: { settings: Settings | null; tasks: TaskSummary[]; onTasks: (tasks: TaskSummary[]) => void }) {
  const [projectId, setProjectId] = useState('');
  const [request, setRequest] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!projectId && settings?.projects[0]) setProjectId(settings.projects[0].id);
  }, [settings, projectId]);
  async function begin() {
    if (!projectId || !request.trim()) { setError('请选择项目并填写需求'); return; }
    setBusy(true);
    setError('');
    try {
      await api('/api/tasks', { method: 'POST', body: JSON.stringify({ projectId, request, requestId: `begin-${crypto.randomUUID()}` }) });
      setRequest('');
      onTasks(await api<TaskSummary[]>('/api/tasks'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h1>Graph</h1>
      <section data-testid="settings">
        <h2>项目与模型</h2>
        <ul>{settings?.projects.map(project => <li key={project.id}>{project.id} {project.root}</li>)}</ul>
        <ul>{settings?.models.map(model => <li key={model.id}>{model.id} {model.grade}</li>)}</ul>
      </section>
      <section data-testid="queue">
        <h2>任务队列</h2>
        <label>项目
          <select data-testid="project-select" value={projectId} onChange={event => setProjectId(event.target.value)}>
            {(settings?.projects ?? []).map(project => <option key={project.id} value={project.id}>{project.id}</option>)}
          </select>
        </label>
        <input data-testid="request-input" placeholder="描述需求" value={request} onChange={event => setRequest(event.target.value)} />
        <button type="button" disabled={busy} onClick={() => void begin()}>{busy ? '提交中…' : '开始'}</button>
        {error && <ErrorBox message={error} />}
        {!tasks.length
          ? <p data-testid="empty">暂无任务。选择项目并提交需求即可开始。</p>
          : (
            <ul>
              {[...tasks].reverse().map(task => (
                <li key={task.id}>
                  <a href={`#/tasks/${task.id}`}><strong>{task.request.slice(0, 60)}</strong></a>
                  {' '}· {task.projectId} · {TASK_LABEL[task.status] ?? task.status} · {when(task.updatedAt)}
                </li>
              ))}
            </ul>
          )}
      </section>
    </section>
  );
}

function Catalog({ settings }: { settings: Settings | null }) {
  return (
    <section data-testid="catalog">
      <h2>Agent 库与能力库</h2>
      <ul>{settings?.definitions.map(item => <li key={item.id}>{item.id}@{item.version}</li>)}</ul>
      <ul>{settings?.capabilities.map(item => <li key={item.id}>{item.id}@{item.version}</li>)}</ul>
    </section>
  );
}

function QuestionReply({ taskId, question, onDone }: {
  taskId: string;
  question: { id: string; kind: string; data: { prompt?: string; grant?: string } };
  onDone: () => void;
}) {
  const [tokens, setTokens] = useState('100000');
  const [inputTokens, setInputTokens] = useState('0');
  const [outputTokens, setOutputTokens] = useState('0');
  const [value, setValue] = useState('');
  const [proof, setProof] = useState('');
  const [error, setError] = useState('');
  async function submit(answer: unknown) {
    try {
      await api(`/api/tasks/${taskId}/answer`, { method: 'POST', body: JSON.stringify({ questionId: question.id, answer, requestId: `ans-${question.id}-${crypto.randomUUID()}` }) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <li>
      {question.kind} {question.data.prompt}
      {question.kind === 'budget' && <input data-testid="budget-tokens" type="number" min={1} value={tokens} onChange={event => setTokens(event.target.value)} />}
      {question.kind === 'waiting' && <input data-testid="waiting-value" value={value} onChange={event => setValue(event.target.value)} />}
      {question.kind === 'unknown_usage' && <>
        <input data-testid="usage-input" type="number" min={0} value={inputTokens} onChange={event => setInputTokens(event.target.value)} placeholder="输入 token" />
        <input data-testid="usage-output" type="number" min={0} value={outputTokens} onChange={event => setOutputTokens(event.target.value)} placeholder="输出 token" />
        <input data-testid="usage-proof" value={proof} onChange={event => setProof(event.target.value)} placeholder="证据" />
      </>}
      {question.kind === 'rework' || question.kind === 'stalled' ? <>
        <button type="button" onClick={() => void submit({ type: 'retry' })}>重试</button>
        <button type="button" onClick={() => void submit({ type: 'respond', value })}>答复</button>
      </> : <button type="button" onClick={() => {
        if (question.kind === 'budget') return void submit({ type: 'add_budget', tokens: Number(tokens) });
        if (question.kind === 'waiting') return void submit({ type: 'respond', value });
        if (question.kind === 'unknown_usage') return void submit({ type: 'usage', usage: { input: Number(inputTokens), output: Number(outputTokens), cacheRead: 0, cacheWrite: 0 }, proof });
        if (question.kind === 'permission') return void submit({ type: 'grant', grant: question.data.grant });
        if (['adapter_error', 'execution_failed', 'model_unavailable', 'git_conflict'].includes(question.kind)) return void submit({ type: 'retry' });
        return void submit({ type: 'acknowledge' });
      }}>答复</button>}
      {error && <p data-testid="answer-error">{error}</p>}
    </li>
  );
}

function TaskPanel({ id, onTasks }: { id: string; onTasks: (tasks: TaskSummary[]) => void }) {
  const { data: view, error, loading, reload } = useAsync(() => api<TaskView>(`/api/tasks/${id}`), [id]);
  const [text, setText] = useState('');
  const [branch, setBranch] = useState('main');
  const [actionError, setActionError] = useState('');
  const connected = useTaskStream(id, () => reload());
  useEffect(() => {
    if (view?.targetBranch) setBranch(view.targetBranch);
  }, [view?.targetBranch]);
  useEffect(() => { void api<TaskSummary[]>('/api/tasks').then(onTasks).catch(() => undefined); }, [view?.status, onTasks]);
  if (loading && !view) return <p>加载中…</p>;
  if (error && !view) return <ErrorBox message={error} onRetry={reload} />;
  if (!view) return <p>加载中…</p>;
  const open = view.questions.filter(question => question.status === 'open');
  const accepted = view.acceptedProposalVersion === view.proposalVersion && view.proposalVersion > 0;
  async function act(action: () => Promise<unknown>) {
    setActionError('');
    try { await action(); reload(); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return (
    <section data-testid="task">
      <p data-testid="connection">{connected ? '已连接' : '重连中…'}</p>
      <h2 data-testid="request">{view.request}</h2>
      <p>项目 {view.projectId} · <span data-testid="status">{statusText(view)}</span> · 更新于 {when(view.updatedAt)}</p>
      <p data-testid="cost">{view.cost.unknown ? '费用未知' : `费用 ${view.cost.amount ?? 0}`}</p>
      {error && <ErrorBox message={error} onRetry={reload} />}
      <div data-testid="conversation">
        {view.messages.map(message => <p key={message.cursor}>需求（v{message.requirementVersion}）：{message.text}</p>)}
        {!view.messages.length && <p>暂无对话。</p>}
      </div>
      {view.proposal && (
        <section data-testid="proposal">
          <h3>提案 v{view.proposalVersion}{accepted ? '（已确认）' : ''}</h3>
          <p>{view.proposal.summary}</p>
          <h4>验收项</h4>
          <ul>{view.proposal.acceptance?.map(item => <li key={item.id}>{item.id}：{item.description}（检查节点 {item.checkNode}）</li>)}</ul>
          <h4>节点</h4>
          <ul>{view.proposal.nodes?.map(node => (
            <li key={node.id}>{node.id} · {node.kind}{node.action ? ` · ${node.action}` : ''}{node.model ? ` · 模型 ${node.model}` : ''}{node.definitionVersion ? ` · ${node.definitionVersion}` : ''}{node.dependsOn?.length ? ` · 依赖 ${node.dependsOn.join(',')}` : ''}</li>
          ))}</ul>
          {!accepted && <>
            <label>目标分支 <input value={branch} onChange={event => setBranch(event.target.value)} data-testid="accept-branch" /></label>
            <button type="button" data-testid="accept" onClick={() => void act(() => api(`/api/tasks/${id}/accept`, { method: 'POST', body: JSON.stringify({ proposalVersion: view.proposalVersion, targetBranch: branch, requestId: `accept-${crypto.randomUUID()}` }) }))}>确认需求 v{view.proposalVersion}</button>
          </>}
          {accepted && <p data-testid="accepted">已确认提案 v{view.acceptedProposalVersion}，目标分支 {view.targetBranch}</p>}
        </section>
      )}
      <textarea value={text} onChange={event => setText(event.target.value)} placeholder="补充需求或说明" />
      <button type="button" onClick={() => void act(async () => { await api(`/api/tasks/${id}/say`, { method: 'POST', body: JSON.stringify({ text, requestId: crypto.randomUUID() }) }); setText(''); })}>发送</button>
      <button type="button" data-testid="pause" onClick={() => void act(() => api(`/api/tasks/${id}/pause`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) }))}>暂停</button>
      <button type="button" data-testid="resume" onClick={() => void act(() => api(`/api/tasks/${id}/resume`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) }))}>继续</button>
      <a href={`#/tasks/${id}/graph`}>查看任务图</a>
      {actionError && <ErrorBox message={actionError} />}
      {open.length ? (
        <ul data-testid="questions">{open.map(question => (
          <QuestionReply key={question.id} taskId={id} question={question} onDone={() => void reload()} />
        ))}</ul>
      ) : <p data-testid="no-questions">当前没有待处理问题。</p>}
    </section>
  );
}

function GraphPanel({ id }: { id: string }) {
  const { data: graph, error, loading, reload } = useAsync(() => api<GraphPayload>(`/api/tasks/${id}/graph`), [id]);
  const { data: view } = useAsync(() => api<TaskView>(`/api/tasks/${id}`), [id]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const connected = useTaskStream(id, () => reload());
  if (loading && !graph) return <p>加载中…</p>;
  if (error && !graph) return <ErrorBox message={error} onRetry={reload} />;
  if (!graph) return <p>加载中…</p>;
  const selectedNode = graph.nodes.find(node => node.id === selected);
  const nodeEvidence = view?.evidence?.filter(item => item.nodeId === selected) ?? [];
  const nodeOperations = view?.operations?.filter(item => item.nodeId === selected) ?? [];
  return (
    <section data-testid="graph" data-editable="false">
      <p data-testid="connection">{connected ? '已连接' : '重连中…'}</p>
      <p><a href={`#/tasks/${id}`}>← 返回任务</a></p>
      <p data-testid="cost">{graph.cost.unknown ? '费用未知' : `费用 ${graph.cost.amount ?? 0}`}</p>
      <p data-testid="revisions">图修订：{graph.revisions.map(item => `v${item.version} ${item.reason}`).join(' / ') || '无'}</p>
      <ul data-testid="legend">
        <li>待执行 / 就绪</li><li>执行中</li><li>已完成</li><li>失败</li><li>被阻塞 / 已跳过</li>
        <li>橙色虚线为返工回边</li>
      </ul>
      <div>{graph.containers.map(container => (
        <button key={container.id} type="button" data-testid={`container-${container.id}`} data-expanded={String(!collapsed[container.id])}
          onClick={() => setCollapsed(current => ({ ...current, [container.id]: !current[container.id] }))}>子图 {container.id}</button>
      ))}</div>
      {!graph.nodes.length && <p data-testid="graph-empty">尚未确认提案，任务图为空。</p>}
      <GraphCanvas graph={graph} collapsed={collapsed} onSelect={setSelected} selected={selected} />
      {selectedNode && (
        <aside data-testid="node-detail">
          <p>{selectedNode.id} {NODE_LABEL[selectedNode.status] ?? selectedNode.status}（{selectedNode.status}）</p>
          <ul>
            <li>实例 {selectedNode.instanceId ?? '—'}</li>
            <li>模型 {selectedNode.selectedModel ?? '—'} · 定义 {selectedNode.boundDefinition ?? '—'}</li>
            <li>用量 {selectedNode.used ?? 0}{selectedNode.budget ? ` / 预算 ${selectedNode.budget}` : ''} · 预留 {selectedNode.reserved ?? 0}</li>
            <li>尝试次数 {selectedNode.stallCount ?? 0} · 输出版本 {selectedNode.outputVersion ?? 0}</li>
            <li>操作 {nodeOperations.length} 次{nodeOperations[0]?.result?.output !== undefined ? ` · 最近输出 ${JSON.stringify(nodeOperations[0]?.result?.output)}` : ''}</li>
            <li>验收证据 {nodeEvidence.length ? nodeEvidence.map(item => `${item.acceptanceId}:${item.valid ? '有效' : '无效'} ${item.summary}`).join(' / ') : '无'}</li>
          </ul>
        </aside>
      )}
    </section>
  );
}
