import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { GraphCanvas } from './GraphCanvas.tsx';
import { NodeRunPanel } from './NodeDetail.tsx';
import { ConversationPanel, type ConversationSummary } from './Conversation.tsx';
import { NODE_LABEL, QUESTION_LABEL, TASK_LABEL, when } from './labels.ts';
import { QuestionReply } from './Questions.tsx';
import { ErrorBox, costText, useAsync, useTaskStream } from './shared.tsx';
import { Settings } from './Settings.tsx';
import { buildTimeline, formatTokens, openQuestionTotal, summarizeUsage, type EventRow } from './insights.ts';
import { Button, Card, Empty, Icon, Pill, Spinner, Stat, StatusDot, Toaster, toast } from './ui.tsx';

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
  cost: { unknown?: boolean; amount?: number | null; amounts?: Record<string, number> };
  integrationSha: string | null;
  proposal: {
    summary?: string; acceptance: { id: string; description: string; checkNode: string }[];
    nodes: { id: string; kind: string; action?: string; definitionVersion?: string; model?: string; dependsOn?: string[] }[];
  } | null;
};
type NodeView = {
  id: string; kind: string; status: string; container?: string; used?: number | null; budget?: number | null; unlimited?: boolean;
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
  cost: { unknown?: boolean; amount?: number | null; amounts?: Record<string, number> };
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
  const { data: conversations, reload: reloadConversations } = useAsync(() => api<ConversationSummary[]>('/api/conversations'), []);

  const refreshTasks = useCallback(async () => {
    setTasks(await api<TaskSummary[]>('/api/tasks'));
  }, []);
  useEffect(() => {
    const onHash = () => setPath(route());
    const onConversationsChanged = () => void reloadConversations();
    window.addEventListener('hashchange', onHash);
    window.addEventListener('graph:conversations-changed', onConversationsChanged);
    void api<Settings_>('/api/settings').then(setSettings);
    void api<Startup>('/api/startup').then(setStartup);
    void refreshTasks().catch(() => undefined);
    const poll = setInterval(() => {
      void refreshTasks().catch(() => undefined);
      void reloadConversations();
    }, 4_000);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('graph:conversations-changed', onConversationsChanged);
      clearInterval(poll);
    };
  }, [refreshTasks, reloadConversations]);

  const [pathname, query = ''] = path.split('?');
  const queryParams = new URLSearchParams(query);
  const questionTotal = openQuestionTotal(tasks);
  const taskMatch = /^\/tasks\/([^/]+)(\/graph)?$/.exec(pathname ?? '/');
  const nodeMatch = /^\/tasks\/([^/]+)\/nodes\/([^/]+)$/.exec(pathname ?? '/');
  const conversationMatch = /^\/conversations\/([^/]+)$/.exec(pathname ?? '/');
  const modeTone = !startup?.configured ? 'danger' : startup.mode === 'execute' ? 'success' : 'warn';
  const modeText = !startup?.configured ? '未配置模型' : startup.mode === 'execute' ? '执行模式' : '仅查看模式';
  const title = pathname === '/' ? '新对话'
    : pathname === '/inbox' ? '问题收件箱'
      : pathname === '/catalog' ? '人才库'
        : pathname === '/setup' ? '设置'
          : pathname === '/settings' ? '设置'
            : nodeMatch ? '节点详情'
              : taskMatch?.[2] ? '任务图' : taskMatch ? '任务详情' : 'Graph';
  const conversationFirst = pathname === '/' || Boolean(conversationMatch);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#/" title="新对话">
          <div className="brand-mark" />
          <div>
            <div className="brand-name">Graph</div>
            <div className="brand-sub">Agent 任务编排控制台</div>
          </div>
        </a>
        <Sidebar
          path={pathname ?? '/'}
          settings={settings}
          conversations={conversations ?? []}
          questionTotal={questionTotal}
          modeText={modeText}
          modeTone={modeTone}
        />
      </aside>
      <main className="main">
        {startup && !startup.configured && (
          <div className="banner" data-testid="banner">
            <Icon name="alert" />
            {startup.modelCount === 0
              ? <>首次运行：未配置模型，当前为仅查看模式，任务不会被派发。请<a href="#/settings">打开设置</a>连接模型；保存后立即生效，无需重启。</>
              : <>模型已配置但凭据未解析，当前为仅查看模式，任务不会被派发。请<a href="#/settings">打开设置</a>检查凭据，或设置凭据引用的环境变量。{typeof window !== 'undefined' && window.graph && '桌面 APP 也可在设置页保存密钥到钥匙串，保存后立即对该守护进程生效，无需重启。'}</>}
          </div>
        )}
        {startup?.mode === 'view' && startup.configured && (
          <div className="banner info" data-testid="banner-view">
            <Icon name="bolt" />
            仅查看模式：可浏览与配置，不派发模型请求。使用 --execute 启动以启用调度。
          </div>
        )}
        {!conversationFirst && (
          <header className="topbar">
            <h1>{title}</h1>
            <span className="topbar-sub">
              {modeText}
              {settings && ` · ${settings.projects.length} 个项目 · ${settings.models.length} 个模型`}
            </span>
            <div className="topbar-spacer" />
            <Pill tone={modeTone}>{startup?.mode === 'execute' ? '调度开启' : '调度关闭'}</Pill>
          </header>
        )}
        <div className={`content ${conversationFirst ? 'conversation-content' : ''}`}>
          <div className={`page ${conversationFirst ? 'conversation-page-host' : ''}`} key={path}>
            {pathname === '/' && <NewConversation settings={settings} initialProjectId={queryParams.get('project') ?? ''} />}
            {pathname === '/inbox' && <Inbox tasks={tasks} />}
            {pathname === '/catalog' && <Catalog settings={settings} />}
            {pathname === '/setup' && <Settings openGuide />}
            {pathname === '/settings' && <Settings />}
            {conversationMatch && (
              <ConversationPanel
                key={conversationMatch[1]}
                id={conversationMatch[1]!}
                settings={settings}
                onChanged={reloadConversations}
              />
            )}
            {nodeMatch && (
              <Card title={`节点 ${nodeMatch[2]}`} icon="box" actions={<a className="btn" href={`#/tasks/${nodeMatch[1]}/graph`}>返回任务图</a>}>
                <NodeRunPanel key={`${nodeMatch[1]}:${nodeMatch[2]}`} taskId={nodeMatch[1]!} nodeId={nodeMatch[2]!} full />
              </Card>
            )}
            {taskMatch && !taskMatch[2] && <TaskPanel id={taskMatch[1]!} onTasks={setTasks} settings={settings} startup={startup} />}
            {taskMatch?.[2] && <GraphPanel id={taskMatch[1]!} settings={settings} startup={startup} />}
          </div>
        </div>
      </main>
      <Toaster />
    </div>
  );
}

function Sidebar({ path, settings, conversations, questionTotal, modeText, modeTone }: {
  path: string;
  settings: Settings_ | null;
  conversations: ConversationSummary[];
  questionTotal: number;
  modeText: string;
  modeTone: 'success' | 'warn' | 'danger';
}) {
  const [projectOpen, setProjectOpen] = useState<Record<string, boolean>>({});
  const ordered = [...conversations].sort((left, right) => (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt));
  const unbound = ordered.filter(conversation => !conversation.projectId);
  return (
    <>
      <nav className="nav">
        <a href="#/inbox" data-active={path === '/inbox'}>
          <Icon name="inbox" />问题
          {questionTotal > 0 && <> (<span className="nav-badge">{questionTotal}</span>)</>}
        </a>
        <a href="#/catalog" data-active={path === '/catalog'}><Icon name="catalog" />人才库</a>
      </nav>
      <div className="sidebar-scroll" data-testid="conversation-list">
        <div className="sidebar-label">项目</div>
        <div className="sidebar-section">
          {(settings?.projects ?? []).map(project => {
            const items = ordered.filter(conversation => conversation.projectId === project.id);
            return (
              <details
                className="sidebar-project"
                open={projectOpen[project.id] ?? true}
                key={project.id}
                onToggle={event => {
                  const open = event.currentTarget.open;
                  setProjectOpen(current => current[project.id] === open ? current : { ...current, [project.id]: open });
                }}
              >
                <summary>
                  <Icon name="chevron" size={13} className="sidebar-chevron" />
                  <span className="sidebar-project-name" title={project.root}>{project.id}</span>
                  <a
                    className="sidebar-new-chat"
                    href={`#/?project=${encodeURIComponent(project.id)}`}
                    data-testid={`new-conversation-project-${project.id}`}
                    title={`在 ${project.id} 中新建对话`}
                    aria-label={`在 ${project.id} 中新建对话`}
                    onClick={event => event.stopPropagation()}
                  >
                    <Icon name="plus" size={15} />
                  </a>
                </summary>
                <div className="sidebar-conversations">
                  {items.map(conversation => <SidebarConversation key={conversation.id} conversation={conversation} active={path === `/conversations/${conversation.id}`} />)}
                  {!items.length && <span className="sidebar-empty">暂无对话</span>}
                </div>
              </details>
            );
          })}
          {!settings?.projects.length && <span className="sidebar-empty">尚未配置项目</span>}
        </div>
        <div className="sidebar-label">最近</div>
        <div className="sidebar-section">
          <div className="sidebar-conversations" style={{ paddingLeft: 0 }}>
            {unbound.map(conversation => <SidebarConversation key={conversation.id} conversation={conversation} active={path === `/conversations/${conversation.id}`} />)}
            <a className="sidebar-conversation" href="#/" data-testid="new-conversation-recent">
              <Icon name="plus" size={15} />
              <span className="sidebar-conversation-title">新对话</span>
            </a>
          </div>
        </div>
      </div>
      <div className="sidebar-footer">
        <nav className="nav">
          <a href="#/settings" data-active={path === '/settings' || path === '/setup'}><Icon name="settings" />设置</a>
        </nav>
        <div className="sidebar-status"><StatusDot tone={modeTone} pulse={modeTone === 'success'} />{modeText}</div>
      </div>
    </>
  );
}

function SidebarConversation({ conversation, active }: { conversation: ConversationSummary; active: boolean }) {
  return (
    <a className="sidebar-conversation" href={`#/conversations/${conversation.id}`} data-active={active} title={conversation.title}>
      <Icon name="message" size={14} />
      <span className="sidebar-conversation-title">{conversation.title}</span>
      {conversation.openQuestions > 0 && <span className="sidebar-conversation-badge">{conversation.openQuestions}</span>}
    </a>
  );
}

function NewConversation({ settings, initialProjectId }: { settings: Settings_ | null; initialProjectId: string }) {
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState(initialProjectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setProjectId(initialProjectId); }, [initialProjectId]);
  async function start() {
    if (!text.trim()) { setError('先用一句话说说你想解决什么。'); return; }
    setBusy(true);
    setError('');
    try {
      const created = await api<{ conversationId: string }>('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ ...(projectId ? { projectId } : {}), text, requestId: `conv-${crypto.randomUUID()}` }),
      });
      window.dispatchEvent(new Event('graph:conversations-changed'));
      location.hash = `#/conversations/${created.conversationId}`;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="new-chat-page" data-testid="conversations">
      <div className="new-chat-intro">
        <div className="new-chat-mark" />
        <h1>开始新对话</h1>
        <p>说清目标即可。主 Agent 会先调查、追问并给出方案草稿，确认后才开始执行。</p>
      </div>
      <div className="new-chat-composer">
        <textarea
          data-testid="new-conversation-input"
          value={text}
          onChange={event => setText(event.target.value)}
          placeholder="例如：这个项目很乱，先帮我看看能从哪里改进。"
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void start();
            }
          }}
          autoFocus
        />
        <div className="composer-toolbar">
          <select
            className="composer-project"
            data-testid="new-conversation-project"
            value={projectId}
            onChange={event => setProjectId(event.target.value)}
            aria-label="对话项目"
          >
            <option value="">未绑定项目</option>
            {(settings?.projects ?? []).map(project => <option key={project.id} value={project.id}>{project.id}</option>)}
          </select>
          <div className="composer-spacer" />
          <button type="button" className="icon-button primary" data-testid="new-conversation-start" disabled={busy || !text.trim()} onClick={() => void start()} aria-label="发送并开始对话">
            <Icon name="send" size={17} />
          </button>
        </div>
      </div>
      {error && <ErrorBox message={error} />}
    </section>
  );
}

function TalentPanel({ id }: { id: string }) {
  const [version, setVersion] = useState<string>('');
  const [allVersions, setAllVersions] = useState(false);
  const [sampleLimit, setSampleLimit] = useState(20);
  const query = allVersions ? '?scope=all' : version ? `?version=${version}` : '';
  const { data, error } = useAsync(() => api<{
    detail: { id: string; version: number; versions: number[]; recommendedGrade: string; review: boolean; description: string | null; traceability: Record<string, unknown>; capabilities: { id: string; version: string; kind: string | null; status: string }[] };
    experience: { scope: { version: number | null; allVersions: boolean }; task: { token: { mean: number | null; samples: number; unknown: number; unfinished: number; failed: number }; runMs: { mean: number | null; samples: number; unknown: number; unfinished: number; failed: number }; cost: { byCurrency: { currency: string; mean: number | null; samples: number; unknown: number }[]; mixedCurrency: boolean; unknown: boolean }; totalSamples: number }; chat: { token: { mean: number | null; samples: number }; totalSamples: number }; samples: { taskId: string; nodeId: string; kind: string; status: string; request: string | null; model: string | null; tokens: number | null; runMs: number | null; waitingMs: number; reworkRounds: number }[] };
  }>(`/api/catalog/definitions/${id}${query}`), [id, query]);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Spinner />;
  const stat = (label: string, value: { mean: number | null; samples: number; unknown: number }) => (
    <li key={label}>{label}：{value.mean === null ? '暂无' : value.mean.toLocaleString('en-US', { maximumFractionDigits: 1 })}（样本 {value.samples}，未知 {value.unknown}）</li>
  );
  return (
    <div data-testid={`talent-${id}`} className="stack" style={{ gap: 8 }}>
      <div className="row">
        <Pill tone="accent">{data.detail.id}@{data.detail.version}</Pill>
        <Pill tone={data.detail.review ? 'warn' : 'info'}>{data.detail.review ? '独立审查' : `推荐 ${data.detail.recommendedGrade}`}</Pill>
        <Pill tone="neutral">{String((data.detail.traceability as { origin?: string }).origin ?? 'user') === 'preset' ? '内置预设' : '用户版本'}</Pill>
      </div>
      {data.detail.description && <p className="muted">{data.detail.description}</p>}
      <div>
        <h4>绑定能力</h4>
        <div className="chip-row">{data.detail.capabilities.map(item => <Pill key={`${item.id}@${item.version}`} tone={item.status === 'installed' ? 'success' : 'danger'}>{item.id}@{item.version} · {item.kind ?? '未知'} · {item.status}</Pill>)}</div>
      </div>
      <div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <h4 style={{ margin: 0 }}>工作经历</h4>
          <select className="input" style={{ width: 150 }} data-testid={`talent-version-${id}`} value={allVersions ? 'all' : version || String(data.detail.version)} disabled={allVersions}
            onChange={event => { setVersion(event.target.value); setAllVersions(false); }}>
            {data.detail.versions.map(item => <option key={item} value={String(item)}>版本 {item}</option>)}
          </select>
          <Button size="sm" variant={allVersions ? 'primary' : 'default'} data-testid={`talent-all-versions-${id}`} onClick={() => setAllVersions(current => !current)}>所有版本</Button>
          <span className="muted" data-testid={`talent-scope-${id}`}>统计范围：{data.experience.scope.allVersions ? '所有版本合并' : `v${data.experience.scope.version}`}</span>
        </div>
        <ul className="list">
          {stat('token 均值', data.experience.task.token)}
          {stat('运行时间均值(ms)', data.experience.task.runMs)}
          {data.experience.task.cost.byCurrency.map(entry => (
            <li key={entry.currency}>{`费用均值：${entry.currency} ${entry.mean === null ? '暂无' : entry.mean.toFixed(6)}（样本 ${entry.samples}，未知 ${entry.unknown}）`}</li>
          ))}
          {!data.experience.task.cost.byCurrency.length && <li>费用均值：无记录{data.experience.task.cost.unknown ? '（存在未知价格调用）' : ''}</li>}
          <li>费用币种：{data.experience.task.cost.mixedCurrency ? '多币种分列，不合并' : '单一币种'}</li>
          <li>经历样本：任务 {data.experience.task.totalSamples} · 对话 {data.experience.chat.totalSamples}</li>
        </ul>
        {!data.experience.samples.length && <p className="muted">暂无经历。</p>}
        <ul className="list" data-testid={`talent-samples-${id}`}>
          {data.experience.samples.slice(0, sampleLimit).map(sample => (
            <li className="list-item" key={`${sample.taskId}:${sample.nodeId}`}>
              <a className="grow" href={`#/tasks/${sample.taskId}/nodes/${sample.nodeId}`}>{sample.request ?? (sample.kind === 'chat' ? '对话工作' : '实施经历')} · {sample.status}</a>
              <span className="muted">{sample.model ?? '模型未知'}{sample.tokens === null ? ' · token 未知' : ` · ${sample.tokens.toLocaleString('en-US')} tokens`}{sample.runMs === null ? '' : ` · ${(sample.runMs / 1_000).toFixed(1)}s`}{sample.waitingMs ? ` · 凭据等待 ${(sample.waitingMs / 1_000).toFixed(1)}s` : ''}{sample.reworkRounds ? ` · 返工 ${sample.reworkRounds}` : ''}</span>
            </li>
          ))}
        </ul>
        {data.experience.samples.length > sampleLimit && (
          <Button size="sm" data-testid={`talent-samples-more-${id}`} onClick={() => setSampleLimit(limit => limit + 50)}>载入更多经历（已显示 {Math.min(sampleLimit, data.experience.samples.length)} / {data.experience.samples.length}）</Button>
        )}
      </div>
    </div>
  );
}

function Catalog({ settings }: { settings: Settings_ | null }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="stagger">
      <Card testid="catalog" title="Agent 库与能力库" icon="catalog" subtitle="可发布的定义与受限能力">
        <div className="stack">
          <div>
            <h4>Agent 定义</h4>
            <div className="chip-row">
              {(settings?.definitions ?? []).map(item => (
                <Button key={item.id} size="sm" variant={selected === item.id ? 'primary' : 'default'} data-testid={`definition-${item.id}`} onClick={() => setSelected(current => current === item.id ? null : item.id)}>{item.id}@{item.version}</Button>
              ))}
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
      {selected && <Card title={`人才详情 ${selected}`} icon="catalog" actions={<Button size="sm" variant="ghost" onClick={() => setSelected(null)}>关闭</Button>}><TalentPanel id={selected} /></Card>}
    </div>
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
          {` · 费用 ${costText(view.cost)}`}
        </p>
        <Stat label="已计量 tokens" value={formatTokens(usage.used)} hint={`${usage.measuredNodes} 个节点有权威计量`} />
        <Stat label="未知用量节点" value={usage.unknownNodes} tone={usage.unknownNodes ? 'warn' : undefined} hint={usage.unknownNodes ? '不计入 0，需核对' : '全部节点可计量'} />
        <Stat label="剩余预算" value={usage.unlimited ? '不限' : usage.remaining === null ? '未知' : formatTokens(usage.remaining)}
          hint={usage.unlimited ? `已计量 ${formatTokens(usage.used)} tokens` : usage.remaining === null ? '无预算绑定' : `总预算 ${formatTokens(usage.budget)}`}
          progress={!usage.unlimited && usage.budget > 0 ? (usage.used / usage.budget) * 100 : undefined} />
        <Stat label="费用" value={costText(view.cost)} tone={view.cost.unknown ? 'warn' : undefined} hint={view.cost.unknown ? '存在未知价格，不按 0 计' : '按已配置单价估算，分币种合计'} />
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
            <dt>费用</dt><dd data-testid="cost">{costText(view.cost)}</dd>
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
            <Pill tone="accent" testid="cost">{costText(graph.cost)}</Pill>
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
            <div><span className="muted">用量 </span>{selectedNode.used == null ? '未知（无权威计量）' : formatTokens(selectedNode.used)}{selectedNode.unlimited ? ' · 额度不限' : selectedNode.budget == null ? '' : ` / 预算 ${formatTokens(selectedNode.budget)}`} · 预留 {selectedNode.reserved ?? 0}</div>
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
          <div style={{ marginTop: 14 }}>
            <NodeRunPanel key={`${id}:${selectedNode.id}`} taskId={id} nodeId={selectedNode.id} />
          </div>
        </Card>
      )}
    </div>
  );
}
