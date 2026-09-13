import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { nextEventCursor } from './event-cursor.ts';
import { GraphCanvas } from './GraphCanvas.tsx';
import { Settings } from './Settings.tsx';
import { Setup } from './Setup.tsx';
import { buildTimeline, formatTokens, openQuestionTotal, summarizeUsage, type EventRow } from './insights.ts';
import { Button, Card, Empty, Icon, Pill, Spinner, Stat, StatusDot, Toaster, toast, useTheme } from './ui.tsx';

type TaskSummary = {
  id: string; projectId: string; request: string; phase: string; status: string;
  acceptedProposalVersion: number | null; updatedAt: number | null; openQuestions?: number;
};
type Startup = { mode: 'view' | 'execute'; configured: boolean; modelCount: number; enabledModelCount: number; effectiveRevision?: number; limitAliases?: Record<string, string> };
type TaskView = {
  id: string; projectId: string; request: string; phase: string; status: string; paused: boolean; proposalVersion: number;
  acceptedProposalVersion: number | null; targetBranch: string | null; updatedAt: number | null;
  messages: { cursor: number; text: string; requirementVersion: number }[];
  questions: { id: string; kind: string; status: string; nodeId: string; data: { prompt?: string; grant?: string; reason?: string; output?: unknown } & Record<string, unknown> }[];
  nodes: NodeView[];
  evidence: { nodeId: string; acceptanceId: string; summary: string; valid: boolean; artifact?: { path: string; digest: string } }[];
  operations: { nodeId: string; state: string; result?: { output?: unknown } | null }[];
  cost: { unknown?: boolean; amount?: number };
  integrationSha: string | null;
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
type Settings_ = { projects: { id: string; root: string }[]; models: { id: string; grade: string; credentialId?: string }[]; definitions: { id: string; version: number }[]; capabilities: { id: string; version: string }[] };
type Limits = { active: Record<string, number>; queued: Record<string, number> };
type OperationRow = { id: string; nodeId: string; state: string; reserved: number; workerActive: boolean; result: { output?: unknown } | null; durationMs?: number };
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
const TASK_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'> = {
  discussing: 'info', running: 'accent', queued: 'neutral', paused: 'warn', pausing: 'warn',
  blocked: 'warn', completed: 'success', failed: 'danger', skipped: 'neutral',
};
const NODE_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'> = {
  pending: 'neutral', ready: 'info', preparing: 'accent', running: 'accent',
  succeeded: 'success', failed: 'danger', blocked: 'warn', skipped: 'neutral',
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
    <div data-testid="error" className="hint-card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)', margin: '8px 0' }}>
      <Icon name="alert" />
      <span><strong>加载失败：</strong>{message}</span>
      {onRetry && <Button size="sm" variant="danger" onClick={onRetry}>重试</Button>}
    </div>
  );
}

function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  // Every request gets a generation; a late response from an old key must
  // never overwrite the record the user is looking at now.
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setData(null);
    setError(null);
  }, deps);
  const reload = useCallback(() => {
    const current = ++generation.current;
    setLoading(true);
    loadRef.current()
      .then(value => { if (generation.current === current) { setData(value); setError(null); } })
      .catch((reason: unknown) => { if (generation.current === current) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (generation.current === current) setLoading(false); });
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

function useLimits() {
  const { data, reload } = useAsync(() => api<Limits>('/api/limits'), []);
  useEffect(() => {
    const timer = setInterval(reload, 500);
    return () => clearInterval(timer);
  }, [reload]);
  return data;
}

/** A preparing node whose credential has requests waiting is waiting for a
 * model slot, not executing on the provider. */
function waitingForSlot(node: { selectedModel?: string; status: string }, settings: Settings_ | null, limits: Limits | null, limitAliases?: Record<string, string>) {
  if (!node.selectedModel || !limits) return false;
  if (['succeeded', 'skipped', 'failed', 'pending', 'blocked'].includes(node.status)) return false;
  const credentialId = settings?.models.find(model => model.id === node.selectedModel)?.credentialId;
  if (!credentialId) return false;
  // Aliases resolving to the same actual key share one scheduling identity.
  const canonical = limitAliases?.[credentialId] ?? credentialId;
  return (limits.queued[canonical] ?? 0) > 0;
}

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  return hash;
}

export function App() {
  const [path, setPath] = useState(route);
  const [settings, setSettings] = useState<Settings_ | null>(null);
  const [startup, setStartup] = useState<Startup | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [theme, toggleTheme] = useTheme();
  useEffect(() => {
    const onHash = () => setPath(route());
    window.addEventListener('hashchange', onHash);
    void api<Settings_>('/api/settings').then(setSettings);
    void api<Startup>('/api/startup').then(setStartup);
    void api<TaskSummary[]>('/api/tasks').then(setTasks);
    // The inbox badge must reflect new questions from any page.
    const poll = setInterval(() => { void api<TaskSummary[]>('/api/tasks').then(setTasks).catch(() => undefined); }, 4_000);
    return () => { window.removeEventListener('hashchange', onHash); clearInterval(poll); };
  }, []);
  const questionTotal = openQuestionTotal(tasks);
  const taskMatch = /^\/tasks\/([^/]+)(\/graph)?$/.exec(path);
  const modeTone = !startup?.configured ? 'danger' : startup.mode === 'execute' ? 'success' : 'warn';
  const modeText = !startup?.configured ? '未配置模型' : startup.mode === 'execute' ? '执行模式' : '仅查看模式';
  const title = path === '/' ? '概览'
    : path === '/inbox' ? '问题收件箱'
      : path === '/catalog' ? '人才库'
        : path === '/setup' ? '配置向导'
          : path === '/settings' ? '设置'
            : taskMatch?.[2] ? '任务图' : taskMatch ? '任务详情' : 'Graph';
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-name">Graph</div>
            <div className="brand-sub">Agent 任务编排控制台</div>
          </div>
        </div>
        <nav className="nav">
          <a href="#/" data-active={path === '/'}><Icon name="overview" />概览</a>
          <a href="#/inbox" data-active={path === '/inbox'}>
            <Icon name="inbox" />问题
            {questionTotal > 0 && <> (<span className="nav-badge">{questionTotal}</span>)</>}
          </a>
          <a href="#/catalog" data-active={path === '/catalog'}><Icon name="catalog" />人才库</a>
          <a href="#/setup" data-active={path === '/setup'}><Icon name="wizard" />向导</a>
          <a href="#/settings" data-active={path === '/settings'}><Icon name="settings" />设置</a>
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-footer">
          <div className="sidebar-status"><StatusDot tone={modeTone} pulse={modeTone === 'success'} />{modeText}</div>
          <div className="sidebar-actions">
            <Button className="btn-sm" onClick={toggleTheme} icon={theme === 'dark' ? 'sun' : 'moon'} title="切换主题">
              {theme === 'dark' ? '浅色' : '深色'}
            </Button>
          </div>
        </div>
      </aside>
      <main className="main">
        {startup && !startup.configured && (
          <div className="banner" data-testid="banner">
            <Icon name="alert" />
            {startup.modelCount === 0
              ? <>首次运行：未配置模型，当前为仅查看模式，任务不会被派发。请<a href="#/setup">打开配置向导</a>，或在 graph.config.json 中添加模型与凭据后重启。</>
              : <>模型已配置但凭据未解析，当前为仅查看模式，任务不会被派发。请<a href="#/setup">打开配置向导</a>检查凭据，或设置凭据引用的环境变量后重启。</>}
          </div>
        )}
        {startup?.mode === 'view' && startup.configured && (
          <div className="banner info" data-testid="banner-view">
            <Icon name="bolt" />
            仅查看模式：可浏览与配置，不派发模型请求。使用 --execute 启动以启用调度。
          </div>
        )}
        <header className="topbar">
          <h1>{title}</h1>
          <span className="topbar-sub">
            {modeText}
            {settings && ` · ${settings.projects.length} 个项目 · ${settings.models.length} 个模型`}
          </span>
          <div className="topbar-spacer" />
          <Pill tone={modeTone}>{startup?.mode === 'execute' ? '调度开启' : '调度关闭'}</Pill>
        </header>
        <div className="content">
          <div className="page" key={path}>
            {path === '/' && <Overview settings={settings} tasks={tasks} onTasks={setTasks} />}
            {path === '/inbox' && <Inbox tasks={tasks} />}
            {path === '/catalog' && <Catalog settings={settings} />}
            {path === '/setup' && <Setup />}
            {path === '/settings' && <Settings />}
            {taskMatch && !taskMatch[2] && <TaskPanel id={taskMatch[1]!} onTasks={setTasks} settings={settings} startup={startup} />}
            {taskMatch?.[2] && <GraphPanel id={taskMatch[1]!} settings={settings} startup={startup} />}
          </div>
        </div>
      </main>
      <Toaster />
    </div>
  );
}

function Overview({ settings, tasks, onTasks }: { settings: Settings_ | null; tasks: TaskSummary[]; onTasks: (tasks: TaskSummary[]) => void }) {
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
      toast('任务已创建，主管开始讨论需求', 'success');
      onTasks(await api<TaskSummary[]>('/api/tasks'));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast(`创建任务失败：${message}`, 'danger');
    } finally {
      setBusy(false);
    }
  }
  const openTasks = tasks.filter(task => (task.openQuestions ?? 0) > 0).length;
  return (
    <div className="stagger">
      <div className="stat-grid">
        <Stat label="项目" value={settings?.projects.length ?? '—'} hint={settings?.projects.map(project => project.id).slice(0, 3).join(' · ') || '尚未配置'} />
        <Stat label="模型" value={settings?.models.length ?? '—'} hint="执行模式下可派发" />
        <Stat label="任务" value={tasks.length} hint={tasks.length ? `最近更新 ${when(tasks[tasks.length - 1]?.updatedAt ?? null)}` : '暂无任务'} />
        <Stat label="待处理问题" value={openTasks} tone={openTasks ? 'warn' : undefined} hint={openTasks ? '前往问题收件箱' : '没有阻塞项'} />
      </div>

      <div data-testid="queue">
      <Card title="提交新任务" icon="play" subtitle="选择项目并描述需求，主管会先讨论再拆解">
        <div data-testid="settings" className="chip-row" style={{ marginBottom: 12 }}>
          {(settings?.projects ?? []).map(project => <Pill key={project.id} tone="info">{project.id}</Pill>)}
          {(settings?.models ?? []).map(model => <Pill key={model.id}>{model.id} · {model.grade}</Pill>)}
        </div>
        <div className="inline-form">
          <label className="field" style={{ margin: 0 }}>
            <span className="field-label">项目</span>
            <select className="select" data-testid="project-select" value={projectId} onChange={event => setProjectId(event.target.value)} style={{ minWidth: 180 }}>
              {(settings?.projects ?? []).map(project => <option key={project.id} value={project.id}>{project.id}</option>)}
            </select>
          </label>
          <label className="field" style={{ margin: 0, flex: 1, minWidth: 280 }}>
            <span className="field-label">需求</span>
            <input className="input" data-testid="request-input" placeholder="例如：为项目添加搜索接口并补测试" value={request}
              onChange={event => setRequest(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) void begin(); }} style={{ maxWidth: 'none' }} />
          </label>
          <Button variant="primary" data-testid="begin" disabled={busy} onClick={() => void begin()}>
            {busy ? '提交中…' : '开始'}
          </Button>
        </div>
        {error && <ErrorBox message={error} />}
      </Card>

      <Card title="任务队列" icon="task" subtitle={`${tasks.length} 个任务`}>
        {!tasks.length
          ? <Empty icon="task" title="暂无任务" hint={<span data-testid="empty">暂无任务。选择项目并提交需求即可开始。</span>} />
          : (
            <ul className="list" data-testid="task-list">
              {[...tasks].reverse().map(task => (
                <li key={task.id} className="list-item">
                  <StatusDot tone={TASK_TONE[task.status] === 'neutral' ? 'info' : TASK_TONE[task.status] ?? 'info'} />
                  <div className="grow">
                    <a href={`#/tasks/${task.id}`} className="truncate" style={{ display: 'block', fontWeight: 600 }}>{task.request.slice(0, 90)}</a>
                    <small>{task.projectId} · {when(task.updatedAt)}{(task.openQuestions ?? 0) > 0 ? ` · ${task.openQuestions} 个待处理问题` : ''}</small>
                  </div>
                  <Pill tone={TASK_TONE[task.status] ?? 'neutral'}>{TASK_LABEL[task.status] ?? task.status}</Pill>
                  <Icon name="chevron" size={14} />
                </li>
              ))}
            </ul>
          )}
      </Card>
      </div>
    </div>
  );
}

function Catalog({ settings }: { settings: Settings_ | null }) {
  return (
    <div className="stagger">
      <Card testid="catalog" title="Agent 库与能力库" icon="catalog" subtitle="可发布的定义与受限能力">
        <div className="stack">
          <div>
            <h4>Agent 定义</h4>
            <div className="chip-row">
              {(settings?.definitions ?? []).map(item => <Pill key={item.id} tone="accent">{item.id}@{item.version}</Pill>)}
              {!(settings?.definitions ?? []).length && <span className="muted">暂无定义</span>}
            </div>
          </div>
          <div>
            <h4>能力</h4>
            <div className="chip-row">
              {(settings?.capabilities ?? []).map(item => <Pill key={item.id} tone="info">{item.id}@{item.version}</Pill>)}
              {!(settings?.capabilities ?? []).length && <span className="muted">暂无能力</span>}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function QuestionReply({ taskId, question, onDone }: {
  taskId: string;
  question: { id: string; kind: string; data: { prompt?: string; grant?: string; reason?: string; output?: unknown } & Record<string, unknown> };
  onDone: () => void;
}) {
  const [tokens, setTokens] = useState('100000');
  const [inputTokens, setInputTokens] = useState('0');
  const [outputTokens, setOutputTokens] = useState('0');
  const [value, setValue] = useState('');
  const [proof, setProof] = useState('');
  const [usageMode, setUsageMode] = useState<'usage' | 'reconcile'>('usage');
  const [error, setError] = useState('');
  async function submit(answer: unknown) {
    try {
      await api(`/api/tasks/${taskId}/answer`, { method: 'POST', body: JSON.stringify({ questionId: question.id, answer, requestId: `ans-${question.id}-${crypto.randomUUID()}` }) });
      toast('已提交答复', 'success');
      onDone();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast(`答复失败：${message}`, 'danger');
    }
  }
  return (
    <li className="list-item" style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
      <div className="row">
        <Pill tone="warn">{QUESTION_LABEL[question.kind] ?? question.kind}</Pill>
        <code className="faint">{question.kind}</code>
        <span>{question.data.prompt}</span>
      </div>
      <pre data-testid={`question-data-${question.id}`} style={{ maxWidth: '100%', margin: '4px 0', fontSize: 12 }}>{JSON.stringify(question.data, null, 2)}</pre>
      <div className="row">
        {question.kind === 'budget' && <input className="input" style={{ width: 130 }} data-testid="budget-tokens" type="number" min={1} value={tokens} onChange={event => setTokens(event.target.value)} />}
        {question.kind === 'waiting' && <input className="input" style={{ width: 220 }} data-testid="waiting-value" value={value} onChange={event => setValue(event.target.value)} placeholder="外部条件已满足的说明" />}
        {question.kind === 'unknown_usage' && <>
          <select className="select" style={{ width: 320 }} data-testid="usage-mode" value={usageMode} onChange={event => setUsageMode(event.target.value as 'usage' | 'reconcile')}>
            <option value="usage">补记用量（按供应商实际回复填写）</option>
            <option value="reconcile">无法核对（保留未知，需说明）</option>
          </select>
          {usageMode === 'usage' && <>
            <input className="input" style={{ width: 120 }} data-testid="usage-input" type="number" min={0} value={inputTokens} onChange={event => setInputTokens(event.target.value)} placeholder="输入 token" />
            <input className="input" style={{ width: 120 }} data-testid="usage-output" type="number" min={0} value={outputTokens} onChange={event => setOutputTokens(event.target.value)} placeholder="输出 token" />
          </>}
          <input className="input" style={{ width: 240 }} data-testid="usage-proof" value={proof} onChange={event => setProof(event.target.value)} placeholder={usageMode === 'usage' ? '用量证据' : '无法核对的说明'} />
        </>}
        {question.kind === 'rework' || question.kind === 'stalled' ? <>
          <Button size="sm" icon="refresh" onClick={() => void submit({ type: 'retry' })}>重试</Button>
          <Button size="sm" onClick={() => void submit({ type: 'respond', value })}>答复</Button>
        </> : <Button size="sm" variant="primary" onClick={() => {
          if (question.kind === 'budget') return void submit({ type: 'add_budget', tokens: Number(tokens) });
          if (question.kind === 'waiting') return void submit({ type: 'respond', value });
          if (question.kind === 'unknown_usage') {
            if (usageMode === 'reconcile') return void submit({ type: 'reconcile_usage', proof });
            return void submit({ type: 'usage', usage: { input: Number(inputTokens), output: Number(outputTokens), cacheRead: 0, cacheWrite: 0 }, proof });
          }
          if (question.kind === 'permission') return void submit({ type: 'grant', grant: question.data.grant });
          if (['adapter_error', 'execution_failed', 'model_unavailable', 'git_conflict'].includes(question.kind)) return void submit({ type: 'retry' });
          return void submit({ type: 'acknowledge' });
        }}>{['adapter_error', 'execution_failed', 'model_unavailable', 'git_conflict'].includes(question.kind) ? '重试' : '答复'}</Button>}
      </div>
      {error && <p data-testid="answer-error" style={{ color: 'var(--danger)' }}>{error}</p>}
    </li>
  );
}

function Inbox({ tasks }: { tasks: TaskSummary[] }) {
  const pending = tasks.filter(task => (task.openQuestions ?? 0) > 0);
  const [views, setViews] = useState<Record<string, TaskView>>({});
  const [error, setError] = useState('');
  const pendingKey = pending.map(task => `${task.id}:${task.openQuestions}`).join(',');
  const load = useCallback(async () => {
    const next: Record<string, TaskView> = {};
    for (const task of pending.slice(0, 5)) {
      try {
        next[task.id] = await api<TaskView>(`/api/tasks/${task.id}`);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
    setViews(next);
  }, [pendingKey]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="stagger" data-testid="inbox">
      {error && <ErrorBox message={error} />}
      {!pending.length && (
        <Card title="问题收件箱" icon="inbox">
          <Empty icon="check" title="没有待处理问题" hint={<span data-testid="inbox-empty">所有任务都在正常推进；需要人工介入时会出现在这里。</span>} />
        </Card>
      )}
      {pending.map(task => (
        <Card key={task.id} testid={`inbox-${task.id}`} icon="inbox" tone="warn"
          title={<a href={`#/tasks/${task.id}`}>{task.request.slice(0, 70)}</a>}
          subtitle={`${task.projectId} · ${task.openQuestions} 个待处理问题`}>
          <ul className="list">{(views[task.id]?.questions ?? []).filter(question => question.status === 'open').map(question => (
            <QuestionReply key={question.id} taskId={task.id} question={question} onDone={() => void load()} />
          ))}</ul>
        </Card>
      ))}
      {pending.length > 5 && <p className="muted">其余 {pending.length - 5} 个任务请进入任务页处理。</p>}
    </div>
  );
}

function TaskPanel({ id, onTasks, settings, startup }: { id: string; onTasks: (tasks: TaskSummary[]) => void; settings: Settings_ | null; startup: Startup | null }) {
  const { data: view, error, loading, reload } = useAsync(() => api<TaskView>(`/api/tasks/${id}`), [id]);
  const { data: events, reload: reloadEvents } = useAsync(() => api<EventRow[]>(`/api/tasks/${id}/events?limit=200`), [id]);
  const limits = useLimits();
  const [text, setText] = useState('');
  const [branch, setBranch] = useState('main');
  const [actionError, setActionError] = useState('');
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshAll = useCallback(() => {
    // A task action writes several records; coalesce the refetches.
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { reload(); reloadEvents(); }, 150);
  }, [reload, reloadEvents]);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
  const connected = useTaskStream(id, refreshAll);
  useEffect(() => {
    if (view?.targetBranch) setBranch(view.targetBranch);
  }, [view?.targetBranch]);
  useEffect(() => { void api<TaskSummary[]>('/api/tasks').then(onTasks).catch(() => undefined); }, [view?.status, onTasks]);
  if (loading && !view) return <Card><Spinner /></Card>;
  if (error && !view) return <ErrorBox message={error} onRetry={reload} />;
  if (!view) return <Card><Spinner /></Card>;
  const open = view.questions.filter(question => question.status === 'open');
  const accepted = view.acceptedProposalVersion === view.proposalVersion && view.proposalVersion > 0;
  const usage = summarizeUsage(view.nodes, view.cost);
  const timeline = events ? buildTimeline(events) : [];
  async function act(action: () => Promise<unknown>, success?: string) {
    setActionError('');
    try { await action(); if (success) toast(success, 'success'); reload(); }
    catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setActionError(message);
      toast(`操作失败：${message}`, 'danger');
    }
  }
  return (
    <div className="stagger" data-testid="task">
      <Card>
        <div className="row-between">
          <div>
            <h1 data-testid="request" style={{ marginBottom: 4 }}>{view.request}</h1>
            <div className="row">
              <Pill testid="status" tone={TASK_TONE[view.status] ?? 'neutral'}><StatusDot tone={view.paused ? 'warn' : (TASK_TONE[view.status] === 'neutral' ? 'info' : TASK_TONE[view.status] as 'success')} />{statusText(view)}</Pill>
              <span className="muted">项目 {view.projectId}</span>
              <span className="faint">· 更新于 {when(view.updatedAt)}</span>
              <span className="faint" data-testid="connection">· {connected ? '已连接' : '重连中…'}</span>
            </div>
          </div>
          <div className="row">
            <a className="btn" href={`#/tasks/${id}/graph`} data-testid="graph-link"><Icon name="graph" size={15} /><span style={{ marginLeft: 6 }}>查看任务图</span></a>
            <Button icon="pause" onClick={() => void act(() => api(`/api/tasks/${id}/pause`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) }), '已请求暂停')} data-testid="pause">暂停</Button>
            <Button icon="play" variant="primary" onClick={() => void act(() => api(`/api/tasks/${id}/resume`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) }), '已恢复执行')} data-testid="resume">继续</Button>
          </div>
        </div>
      </Card>

      <div className="stat-grid" data-testid="usage-summary">
        <p className="muted" style={{ gridColumn: '1 / -1', margin: '0 0 2px' }}>
          已计量 {formatTokens(usage.used)} tokens
          {usage.unknownNodes ? ` · ${usage.unknownNodes} 个节点用量未知` : ''}
          {usage.remaining === null ? '' : ` · 剩余预算 ${formatTokens(usage.remaining)}`}
          {usage.unknownCost ? ' · 费用未知' : ` · 费用 ${usage.cost ?? 0}`}
        </p>
        <Stat label="已计量 tokens" value={formatTokens(usage.used)} hint={`${usage.measuredNodes} 个节点有权威计量`} />
        <Stat label="未知用量节点" value={usage.unknownNodes} tone={usage.unknownNodes ? 'warn' : undefined} hint={usage.unknownNodes ? '不计入 0，需核对' : '全部节点可计量'} />
        <Stat label="剩余预算" value={usage.remaining === null ? '未知' : formatTokens(usage.remaining)} hint={usage.remaining === null ? '无预算绑定' : `总预算 ${formatTokens(usage.budget)}`}
          progress={usage.budget > 0 ? (usage.used / usage.budget) * 100 : undefined} />
        <Stat label="费用" value={usage.unknownCost ? '未知' : (usage.cost ?? 0)} tone={usage.unknownCost ? 'warn' : undefined} hint={usage.unknownCost ? '未配置价格，不按 0 计' : '按已配置单价估算'} />
      </div>

      <Card title="运行时间线" icon="clock" subtitle={timeline.length ? `${timeline.length} 条事件` : undefined}>
        <div data-testid="timeline">
          {timeline.length ? (
            <ol className="timeline">
              {timeline.slice(-60).reverse().map((entry, index) => (
                <li key={entry.cursor} className="timeline-item" data-tone={entry.tone} style={{ animationDelay: `${Math.min(index * 18, 240)}ms` }}>
                  <span className="timeline-meta">{when(entry.timestamp)}</span>
                  {' · '}<span className="timeline-label">{entry.label}</span>
                  {entry.nodeId && <> <span className="timeline-node">{entry.nodeId}</span></>}
                  {entry.detail && <div className="timeline-detail truncate" style={{ maxWidth: '100%' }}>{entry.detail}</div>}
                </li>
              ))}
            </ol>
          ) : <Empty icon="clock" title="暂无事件" hint={<span data-testid="timeline-empty">任务执行时会在这里实时记录每一步。</span>} />}
        </div>
      </Card>

      <div className="card-grid">
        <Card title="节点状态" icon="graph">
          <ul className="list" data-testid="node-list">
            {view.nodes.map(node => (
              <li key={node.id} className="list-item" data-node={node.id}>
                <StatusDot tone={NODE_TONE[node.status] === 'neutral' ? 'info' : NODE_TONE[node.status] ?? 'info'} pulse={node.status === 'preparing' || node.status === 'running'} />
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{node.id} · <span className="muted">{NODE_LABEL[node.status] ?? node.status}</span></div>
                  <small>实例 {node.instanceId ? node.instanceId.slice(0, 8) : '未知'} · 用量 {node.used == null ? '未知' : formatTokens(node.used)}</small>
                </div>
                {waitingForSlot(node, settings, limits, startup?.limitAliases) && <Pill tone="warn">等待 API 名额</Pill>}
                {node.status === 'blocked' && view.questions.some(question => question.status === 'open' && question.nodeId === node.id) && <Pill tone="warn">等待人工处理</Pill>}
              </li>
            ))}
          </ul>
        </Card>

        <Card title="需求与提案" icon="task">
          <div data-testid="conversation" className="stack">
            {view.messages.map(message => (
              <div key={message.cursor} className="hint-card" style={{ display: 'block' }}>
                <strong className="muted">需求（v{message.requirementVersion}）</strong>
                <p style={{ margin: '2px 0 0' }}>{message.text}</p>
              </div>
            ))}
            {!view.messages.length && <p className="muted">暂无对话。</p>}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <textarea className="textarea" value={text} onChange={event => setText(event.target.value)} placeholder="补充需求或说明" />
            <Button variant="primary" onClick={() => void act(async () => { await api(`/api/tasks/${id}/say`, { method: 'POST', body: JSON.stringify({ text, requestId: crypto.randomUUID() }) }); setText(''); }, '已发送补充说明')}>发送</Button>
          </div>
          {view.proposal && (
            <div data-testid="proposal" style={{ marginTop: 12 }}>
              <h3>提案 v{view.proposalVersion}{accepted ? '（已确认）' : ''}</h3>
              <p className="muted">{view.proposal.summary}</p>
              <h4>验收项</h4>
              <ul className="list">{view.proposal.acceptance?.map(item => (
                <li key={item.id} className="list-item"><div className="grow">{item.id}：{item.description}<br /><small>检查节点 {item.checkNode}</small></div></li>
              ))}</ul>
              <h4>节点</h4>
              <div className="chip-row">{view.proposal.nodes?.map(node => (
                <Pill key={node.id}>{node.id} · {node.kind}{node.model ? ` · ${node.model}` : ''}{node.definitionVersion ? ` · ${node.definitionVersion}` : ''}</Pill>
              ))}</div>
              {!accepted ? (
                <div className="row" style={{ marginTop: 10 }}>
                  <label className="field" style={{ margin: 0 }}><span className="field-label">目标分支</span>
                    <input className="input" style={{ width: 180 }} value={branch} onChange={event => setBranch(event.target.value)} data-testid="accept-branch" /></label>
                  <Button variant="primary" data-testid="accept" icon="check"
                    onClick={() => void act(() => api(`/api/tasks/${id}/accept`, { method: 'POST', body: JSON.stringify({ proposalVersion: view.proposalVersion, targetBranch: branch, requestId: `accept-${crypto.randomUUID()}` }) }), '已确认提案，开始执行')}>
                    确认需求 v{view.proposalVersion}
                  </Button>
                </div>
              ) : <p data-testid="accepted" className="muted">已确认提案 v{view.acceptedProposalVersion}，目标分支 {view.targetBranch}</p>}
            </div>
          )}
        </Card>
      </div>

      {open.length ? (
        <Card title="待处理问题" icon="inbox" tone="warn">
          <ul className="list" data-testid="questions">{open.map(question => (
            <QuestionReply key={question.id} taskId={id} question={question} onDone={() => void reload()} />
          ))}</ul>
        </Card>
      ) : <Card title="待处理问题" icon="check" tone="success">
        <Empty icon="check" title="没有待处理问题" hint={<span data-testid="no-questions">当前没有待处理问题。</span>} />
      </Card>}

      {(view.phase === 'completed' || view.acceptedProposalVersion !== null) && (
        <Card testid="delivery" title="交付" icon="box" subtitle={`目标分支 ${view.targetBranch ?? '未确认'}`}>
          <dl className="kv">
            <dt>集成提交</dt><dd className="mono">{view.integrationSha ?? '尚无集成提交'}</dd>
            <dt>交付目录</dt><dd className="mono">{settings?.projects.find(project => project.id === view.projectId)?.root ?? '未知'}</dd>
            <dt>费用</dt><dd data-testid="cost">{view.cost.unknown ? '费用未知' : `费用 ${view.cost.amount ?? 0}`}</dd>
          </dl>
          <ul className="list" style={{ marginTop: 10 }}>
            {view.proposal?.acceptance?.map(item => {
              const valid = view.evidence.filter(evidence => evidence.acceptanceId === item.id && evidence.valid);
              const invalid = view.evidence.filter(evidence => evidence.acceptanceId === item.id && !evidence.valid);
              return (
                <li key={item.id} className="list-item" data-acceptance={item.id} style={{ alignItems: 'flex-start' }}>
                  <StatusDot tone={valid.length ? 'success' : 'warn'} />
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{item.id}：{item.description}</div>
                    <small>{valid.length ? valid.map(evidence => `${evidence.summary}（${evidence.artifact?.path ?? '无产物'}）`).join('；') : '尚无有效证据'}
                      {invalid.length ? `；无效或过期证据 ${invalid.length} 条，不计入验收` : ''}</small>
                  </div>
                  <Pill tone={valid.length ? 'success' : 'warn'}>{valid.length ? '有效' : '待验证'}</Pill>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {actionError && <ErrorBox message={actionError} />}
    </div>
  );
}

function GraphPanel({ id, settings, startup }: { id: string; settings: Settings_ | null; startup: Startup | null }) {
  const { data: graph, error, loading, reload } = useAsync(() => api<GraphPayload>(`/api/tasks/${id}/graph`), [id]);
  const limits = useLimits();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [opsLimit, setOpsLimit] = useState(20);
  const { data: ops, reload: reloadOps } = useAsync(() => api<OperationRow[]>(`/api/tasks/${id}/operations?limit=${opsLimit}`), [id, opsLimit]);
  const { data: view, reload: reloadView } = useAsync(() => api<TaskView>(`/api/tasks/${id}`), [id]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshAll = useCallback(() => {
    // One task event usually means several records changed; coalesce them.
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { reload(); reloadView(); reloadOps(); }, 150);
  }, [reload, reloadView, reloadOps]);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
  const connected = useTaskStream(id, refreshAll);
  if (loading && !graph) return <Card><Spinner /></Card>;
  if (error && !graph) return <ErrorBox message={error} onRetry={reload} />;
  if (!graph) return <Card><Spinner /></Card>;
  const selectedNode = graph.nodes.find(node => node.id === selected);
  const nodeEvidence = view?.evidence?.filter(item => item.nodeId === selected) ?? [];
  const nodeOperations = (ops ?? []).filter(item => item.nodeId === selected);
  const nodeWaiting = selectedNode ? waitingForSlot(selectedNode, settings, limits, startup?.limitAliases) : false;
  return (
    <div className="stagger" data-testid="graph" data-editable="false">
      <Card>
        <div className="row-between">
          <div className="row">
            <a href={`#/tasks/${id}`} className="btn"><Icon name="task" size={15} /><span style={{ marginLeft: 6 }}>返回任务</span></a>
            <Pill tone="accent" testid="cost">{graph.cost.unknown ? '费用未知' : `费用 ${graph.cost.amount ?? 0}`}</Pill>
            <Pill testid="revisions">图修订 {graph.revisions.map(item => `v${item.version} ${item.reason}`).join(' / ') || '无'}</Pill>
            <span className="faint" data-testid="connection">{connected ? '已连接' : '重连中…'}</span>
          </div>
          <div className="row">
            {graph.containers.map(container => (
              <Button key={container.id} size="sm" data-testid={`container-${container.id}`} data-expanded={String(!collapsed[container.id])}
                onClick={() => setCollapsed(current => ({ ...current, [container.id]: !current[container.id] }))}>
                {collapsed[container.id] ? '展开' : '折叠'}子图 {container.id}
              </Button>
            ))}
          </div>
        </div>
        <ul className="legend" data-testid="legend" style={{ marginTop: 10 }}>
          <li data-tone="pending">待执行 / 就绪</li>
          <li data-tone="active">执行中</li>
          <li data-tone="success">已完成</li>
          <li data-tone="error">失败</li>
          <li data-tone="blocked">被阻塞 / 已跳过</li>
          <li data-tone="loop">橙色虚线为返工回边</li>
        </ul>
      </Card>

      <Card title="任务图" icon="graph" subtitle={graph.nodes.length ? `${graph.nodes.length} 个节点` : undefined}>
        {!graph.nodes.length && <Empty icon="graph" title="任务图为空" hint={<span data-testid="graph-empty">尚未确认提案，任务图为空。</span>} />}
        <GraphCanvas graph={graph} collapsed={collapsed} onSelect={setSelected} selected={selected} />
      </Card>

      {selectedNode && (
        <Card testid="node-detail" title={`节点 ${selectedNode.id}`} icon="box"
          actions={<Button size="sm" variant="ghost" onClick={() => setSelected(null)}>关闭</Button>}>
          <div className="row" style={{ marginBottom: 10 }}>
            <Pill tone={NODE_TONE[selectedNode.status] ?? 'neutral'}>{NODE_LABEL[selectedNode.status] ?? selectedNode.status}（{selectedNode.status}）</Pill>
            {nodeWaiting && <Pill tone="warn">等待 API 名额</Pill>}
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <div><span className="muted">实例 </span><span className="mono">{selectedNode.instanceId ?? '未知'}</span></div>
            <div><span className="muted">模型 </span>{selectedNode.selectedModel ?? '未知'} · 定义 {selectedNode.boundDefinition ?? '未知'}</div>
            <div><span className="muted">用量 </span>{selectedNode.used == null ? '未知（无权威计量）' : formatTokens(selectedNode.used)}{selectedNode.budget == null ? '' : ` / 预算 ${formatTokens(selectedNode.budget)}`} · 预留 {selectedNode.reserved ?? 0}</div>
            <div><span className="muted">尝试次数 </span>{selectedNode.stallCount ?? 0} · 输出版本 {selectedNode.outputVersion ?? 0}</div>
            <div><span className="muted">验收证据 </span>{nodeEvidence.length ? nodeEvidence.map(item => `${item.acceptanceId}:${item.valid ? '有效' : '无效或过期'} ${item.summary}`).join(' / ') : '无'}</div>
          </div>
          <h4 style={{ marginTop: 14 }}>操作记录（{nodeOperations.length}）</h4>
          <ol className="list" data-testid="node-operations">
            {nodeOperations.map(operation => (
              <li key={operation.id} className="list-item" style={{ alignItems: 'flex-start', display: 'block' }}>
                <div className="row">
                  <Pill tone={operation.state === 'succeeded' ? 'success' : operation.state === 'interrupted' || operation.state === 'unknown' ? 'warn' : 'info'}>{operation.state}</Pill>
                  <span className="muted">{operation.durationMs !== undefined ? `${operation.durationMs}ms` : '—'} · 预留 {operation.reserved}</span>
                </div>
                {operation.result?.output !== undefined && <pre style={{ marginTop: 6 }}>{JSON.stringify(operation.result.output, null, 2)}</pre>}
              </li>
            ))}
          </ol>
          <Button size="sm" data-testid="operations-more" onClick={() => setOpsLimit(current => current + 20)}>加载更多操作记录</Button>
        </Card>
      )}
    </div>
  );
}
