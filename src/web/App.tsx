import { ArtifactDetail } from './ArtifactViews.tsx';
import { ArtifactIndex } from './ArtifactIndex.tsx';
import { DraftGraphTab } from './DraftGraphTab.tsx';
import { splitTasksByLifecycle } from './conversation-drawer.ts';
import { TabBar } from './TabBar.tsx';
import { WindowDrawer } from './WindowDrawer.tsx';
import {
  EMPTY_TABS,
  activateTab,
  closeTab,
  openTab,
  retitleTab,
  tabForPath,
  tabId,
  withTitles,
  type WorkspaceTabKind,
  type WorkspaceTabs,
} from './workspace-tabs.ts';
import { useUsageRefresh } from './usage-refresh.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import type { AgentContextView } from './AgentContext.tsx';
import { ChatComposer, type ChatAttachment } from './ChatComposer.tsx';
import { attachmentPayload } from './attachments.ts';
import { ComposerTelemetry, type ComposerTelemetryView } from './ComposerTelemetry.tsx';
import { defaultThinkingOption } from './thinking-levels.ts';
import { CreateProjectDialog } from './CreateProjectDialog.tsx';
import { GraphCanvas } from './GraphCanvas.tsx';
import { NodeChatTab } from './NodeDetail.tsx';
import { ConversationPanel, type ConversationSummary, type GraphAgentDetail } from './Conversation.tsx';
import { NODE_LABEL, QUESTION_LABEL, TASK_LABEL, describeQuestion, when } from './labels.ts';
import { QuestionReply } from './Questions.tsx';
import { ErrorBox, costText, useAsync, useTargetBranch, useTaskStream } from './shared.tsx';
import { Settings } from './Settings.tsx';
import { UsagePage } from './Usage.tsx';
import { ToolStatsPage } from './ToolStats.tsx';
import { ResourceLibrary as CapabilityResourceLibrary } from './ResourceLibrary.tsx';
import { buildTimeline, formatTokens, openQuestionTotal, summarizeUsage, type EventRow } from './insights.ts';
import { Button, Card, Empty, Icon, Pill, Spinner, Stat, StatusDot, Toaster, toast } from './ui.tsx';
import type { CapabilityRecord } from '../catalog/catalog.ts';
import type { AgentCombination, AgentCombinationView } from '../catalog/agent-combinations.ts';
import { composeSlashDirective, extractSlashTargets } from './SlashCommands.tsx';

type TaskSummary = {
  id: string; projectId: string; request: string; phase: string; status: string;
  acceptedProposalVersion: number | null; updatedAt: number | null; openQuestions?: number;
};
type Startup = { mode: 'view' | 'execute'; configured: boolean; modelCount: number; enabledModelCount: number; effectiveRevision?: number; limitAliases?: Record<string, string> };
type TaskView = {
  id: string; projectId: string; request: string; phase: string; status: string; paused: boolean; proposalVersion: number;
  acceptedProposalVersion: number | null; targetBranch: string | null; updatedAt: number | null;
  messages: { cursor: number; text: string; requirementVersion: number }[];
  questions: { id: string; kind: string; status: string; owner?: string; nodeId: string; data: { prompt?: string; grant?: string; reason?: string; output?: unknown } & Record<string, unknown> }[];
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
  context?: {
    purpose?: string; sourceNode?: string; requiredFacts?: { kind: string }[]; independence?: string;
    predecessors?: { source?: string; mode?: string }[];
    predecessorHandoffs?: {
      sourceNodeId?: string;
      mode?: string;
      resultHandoff?: { workSummary?: string } | null;
    }[];
    handoffSummary?: string | null;
  };
  agent?: GraphAgentDetail | null;
};
export type Settings_ = {
  projects: { id: string; root: string; branch?: string | null; preparation?: { branch?: string | null } | null }[];
  defaultModel?: string | null;
  models: { id: string; grade: string; credentialId?: string; contextWindow?: number; reasoning?: boolean; defaultThinkingLevel?: string; thinkingOptions?: { level: string; label: string }[] }[];
  definitions: { id: string; version: number }[];
  capabilities: CapabilityRecord[];
  agentCombinations?: AgentCombinationView[];
  capabilityConfig?: {
    id: string; version: string; name: string; kind: string; source: string;
    fields: { env: string; label: string; secret: boolean; reason: string }[];
    configured: string[]; missing: string[]; ready: boolean; error?: string;
  }[];
  capabilityRoot?: string | null;
  agentCombinationFile?: string | null;
  agentCombinationError?: string | null;
};
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
  blocked: 'warn', completed: 'success', failed: 'danger', skipped: 'neutral', abandoned: 'danger',
};
const NODE_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'> = {
  pending: 'neutral', ready: 'info', preparing: 'accent', running: 'accent',
  succeeded: 'success', failed: 'danger', blocked: 'warn', skipped: 'neutral',
};

function statusText(view: TaskView) {
  if (view.paused) return TASK_LABEL[view.status] ?? view.status;
  const open = view.questions.filter(question => question.status === 'open' && (question.owner ?? 'user') === 'user');
  if (open.length) return open.map(question => describeQuestion(question.kind, question.data)).join('、');
  return TASK_LABEL[view.status] ?? view.status;
}


/** A preparing node whose credential has requests waiting is waiting for a
 * model slot, not executing on the provider. */

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  return hash;
}

export function App() {
  useUsageRefresh();
  const [path, setPath] = useState(route);
  const [settings, setSettings] = useState<Settings_ | null>(null);
  const [startup, setStartup] = useState<Startup | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('graph-sidebar-collapsed') === 'true'; } catch { return false; }
  });
  const [detailOpen, setDetailOpen] = useState(false);
  // Which windows are open in the main area. The hash route stays the truth for what is on
  // screen; navigating opens or refreshes the matching tab (`workspace-tabs.ts` owns the rules).
  const [tabs, setTabs] = useState<WorkspaceTabs>(() => openTab(EMPTY_TABS, tabForPath(route())));
  const { data: conversations, reload: reloadConversations } = useAsync(() => api<ConversationSummary[]>('/api/conversations'), []);

  const refreshTasks = useCallback(async () => {
    setTasks(await api<TaskSummary[]>('/api/tasks'));
  }, []);
  const reloadSettings = useCallback(async () => {
    setSettings(await api<Settings_>('/api/settings'));
  }, []);
  useEffect(() => {
    const onHash = () => {
      const next = route();
      setPath(next);
      setTabs(current => openTab(current, tabForPath(next)));
    };
    const onConversationsChanged = () => void reloadConversations();
    const onSettingsChanged = () => void reloadSettings();
    window.addEventListener('hashchange', onHash);
    window.addEventListener('graph:conversations-changed', onConversationsChanged);
    window.addEventListener('graph:settings-changed', onSettingsChanged);
    void reloadSettings();
    void api<Startup>('/api/startup').then(setStartup);
    void refreshTasks().catch(() => undefined);
    const poll = setInterval(() => {
      void refreshTasks().catch(() => undefined);
      void reloadConversations();
    }, 4_000);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('graph:conversations-changed', onConversationsChanged);
      window.removeEventListener('graph:settings-changed', onSettingsChanged);
      clearInterval(poll);
    };
  }, [refreshTasks, reloadConversations, reloadSettings]);
  useEffect(() => {
    try { localStorage.setItem('graph-sidebar-collapsed', String(sidebarCollapsed)); } catch { /* local persistence is optional */ }
  }, [sidebarCollapsed]);
  useEffect(() => { setDetailOpen(false); }, [path]);

  const [pathname, query = ''] = path.split('?');
  const queryParams = new URLSearchParams(query);
  const questionTotal = openQuestionTotal(tasks);
  // The drawer is a launcher everywhere: outside a conversation it lists the tasks the user can
  // open, split the same way the conversation drawer splits them.
  const workspaceTasks = splitTasksByLifecycle(tasks);
  // Tabs are named from the data the shell already polls: a conversation by its own title, a
  // task by its request. Until that arrives the tab keeps the generic name it opened with.
  const shownTabs = withTitles(tabs, tab => {
    if (tab.kind === 'conversation') return conversations?.find(item => item.id === tab.key)?.title ?? null;
    // A task's tabs stay distinguishable from each other: the kind names the window, the request
    // names the task, so "任务图 · 外壳与标签栏" never looks like "节点 impl-shell".
    const prefix = tab.kind === 'graph' ? '任务图' : null;
    if (!prefix) return null;
    const request = tasks.find(item => item.id === tab.key)?.request;
    return request ? `${prefix} · ${request}` : null;
  });
  const catalogMatch = /^\/catalog(?:\/([^/]+))?$/.exec(pathname ?? '/');
  // A task's address always means its graph: the separate task page is gone.
  const taskMatch = /^\/tasks\/([^/]+)(?:\/graph)?$/.exec(pathname ?? '/');
  const nodeMatch = /^\/tasks\/([^/]+)\/nodes\/([^/]+)$/.exec(pathname ?? '/');
  const artifactMatch = /^\/tasks\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname ?? '/');
  const draftGraphMatch = /^\/conversations\/([^/]+)\/graph$/.exec(pathname ?? '/');
  const conversationMatch = /^\/conversations\/([^/]+)$/.exec(pathname ?? '/');
  const modeTone = !startup?.configured ? 'danger' : startup.mode === 'execute' ? 'success' : 'warn';
  const modeText = !startup?.configured ? '未配置模型' : startup.mode === 'execute' ? '执行模式' : '仅查看模式';
  function openWorkspaceTab(id: string) {
    const tab = tabs.tabs.find(item => item.id === id);
    if (!tab) return;
    setTabs(current => activateTab(current, id));
    // A tab that points where we already are needs no navigation; anything else sets the hash,
    // which the hash listener turns back into the same tab being in front.
    if (tab.hash !== `#${path}`) location.hash = tab.hash;
  }
  function closeWorkspaceTab(id: string) {
    const wasActive = tabs.activeId === id;
    const next = closeTab(tabs, id);
    setTabs(next);
    if (!wasActive) return;
    // The front follows its neighbour; an emptied workspace falls back to the new-chat page.
    const active = next.tabs.find(tab => tab.id === next.activeId);
    location.hash = active ? active.hash : '#/';
  }
  function startNewConversation() {
    location.hash = '#/';
  }
  // Tab content that only learns its own name after loading (a shared artifact) renames its tab.
  function retitleWorkspaceTab(kind: WorkspaceTabKind, key: string, title: string) {
    setTabs(current => retitleTab(current, tabId(kind, key), title));
  }
  // A draft's graph fills its window the same way the conversation does.
  const conversationFirst = pathname === '/' || Boolean(conversationMatch) || Boolean(draftGraphMatch);
  const settingsPage = pathname === '/settings' || pathname === '/setup';

  if (settingsPage) {
    return (
      <div className="settings-app-root">
        <Settings openGuide={pathname === '/setup'} />
        <Toaster />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" data-collapsed={sidebarCollapsed}>
        <nav className="rail" data-testid="app-rail" aria-label="主入口">
          <a className="rail-button" href="#/" data-testid="rail-new" title="新对话" aria-label="新对话">
            <Icon name="plus" size={17} />
          </a>
          <a className="rail-button" href="#/inbox" data-testid="rail-inbox" title="问题" aria-label="问题" data-active={pathname === '/inbox'}>
            <Icon name="inbox" size={17} />
            {questionTotal > 0 && <span className="rail-badge" data-testid="rail-inbox-badge">{questionTotal}</span>}
          </a>
          <a className="rail-button" href="#/catalog" data-testid="rail-catalog" title="资源库" aria-label="资源库" data-active={Boolean(catalogMatch)}>
            <Icon name="catalog" size={17} />
          </a>
          <a className="rail-button" href="#/usage" data-testid="rail-usage" title="用量" aria-label="用量" data-active={pathname === '/usage'}>
            <Icon name="usage" size={17} />
          </a>
          <a className="rail-button" href="#/tools" data-testid="rail-tools" title="工具" aria-label="工具" data-active={pathname === '/tools'}>
            <Icon name="tool" size={17} />
          </a>
          <div className="rail-spacer" />
          <a className="rail-button" href="#/settings" data-testid="rail-settings" title="设置" aria-label="设置" data-active={settingsPage}>
            <Icon name="settings" size={17} />
          </a>
        </nav>
        <div className="sidebar-body">
          <div className="brand-row">
            <a className="brand" href="#/" title="新对话">
              <div className="brand-mark" />
              <div className="brand-copy">
                <div className="brand-name">Graph</div>
              </div>
            </a>
          </div>
          <Sidebar
            path={pathname ?? '/'}
            settings={settings}
            conversations={conversations ?? []}
            onSettingsChanged={reloadSettings}
          />
        </div>
      </aside>
      <main className="main">
        <div className="workspace-bar" data-testid="workspace-bar">
          <TabBar
            state={shownTabs}
            onActivate={openWorkspaceTab}
            onClose={closeWorkspaceTab}
            onOpenNew={startNewConversation}
          />
          <button
            type="button"
            className="icon-button drawer-toggle"
            data-testid="workspace-drawer-toggle"
            data-open={detailOpen}
            onClick={() => setDetailOpen(value => !value)}
            title={detailOpen ? '收起右侧抽屉' : '展开右侧抽屉'}
            aria-label={detailOpen ? '收起右侧抽屉' : '展开右侧抽屉'}
            aria-expanded={detailOpen}
          >
            <Icon name="panel-right" size={16} />
          </button>
        </div>
        {conversationFirst && !conversationMatch && (
          <header className="topbar conversation-topbar">
            <button
              type="button"
              className="icon-button drawer-toggle"
              data-testid="sidebar-toggle"
              onClick={() => setSidebarCollapsed(value => !value)}
              title={sidebarCollapsed ? '展开左侧抽屉' : '收起左侧抽屉'}
              aria-label={sidebarCollapsed ? '展开左侧抽屉' : '收起左侧抽屉'}
            >
              <Icon name="panel-left" size={16} />
            </button>
            <div className="topbar-spacer" />
          </header>
        )}
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
            <button
              type="button"
              className="icon-button drawer-toggle"
              data-testid="sidebar-toggle"
              onClick={() => setSidebarCollapsed(value => !value)}
              title={sidebarCollapsed ? '展开左侧抽屉' : '收起左侧抽屉'}
              aria-label={sidebarCollapsed ? '展开左侧抽屉' : '收起左侧抽屉'}
            >
              <Icon name="panel-left" size={16} />
            </button>
            <div className="topbar-spacer" />
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
            {catalogMatch && <CapabilityResourceLibrary settings={settings} section={catalogMatch[1]} />}
            {pathname === '/usage' && <UsagePage />}
            {pathname === '/tools' && <ToolStatsPage />}
            {draftGraphMatch && (
              <DraftGraphTab
                key={draftGraphMatch[1]}
                conversationId={draftGraphMatch[1]!}
                {...(queryParams.get('v') ? { version: Number(queryParams.get('v')) } : {})}
              />
            )}
            {pathname === '/artifacts' && (
              <ArtifactIndex
                projectId={queryParams.get('project') ?? settings?.projects[0]?.id ?? ''}
                projects={settings?.projects ?? []}
              />
            )}
            {conversationMatch && (
              <ConversationPanel
                key={conversationMatch[1]}
                id={conversationMatch[1]!}
                settings={settings}
                onChanged={reloadConversations}
                sidebarCollapsed={sidebarCollapsed}
                onSidebarToggle={() => setSidebarCollapsed(value => !value)}
                drawerOpen={detailOpen}
                onDrawerOpenChange={setDetailOpen}
              />
            )}
            {artifactMatch && (
              <ArtifactDetail
                key={`${artifactMatch[1]}:${artifactMatch[2]}:${queryParams.get('v') ?? ''}`}
                taskId={artifactMatch[1]!}
                artifactId={artifactMatch[2]!}
                {...(queryParams.get('v') ? { version: Number(queryParams.get('v')) } : {})}
                onTitle={title => retitleWorkspaceTab('artifact', `${artifactMatch[1]}/${artifactMatch[2]}`, title)}
              />
            )}
            {nodeMatch && (
              <NodeChatTab
                key={`${nodeMatch[1]}:${nodeMatch[2]}`}
                taskId={nodeMatch[1]!}
                nodeId={nodeMatch[2]!}
              />
            )}
            {taskMatch && <GraphPanel id={taskMatch[1]!} settings={settings} startup={startup} />}
          </div>
        </div>
      </main>
      {!conversationMatch && detailOpen && (
        <WindowDrawer open={detailOpen}>
          <aside
            className="detail-drawer"
            data-testid="detail-drawer"
            data-section="workspace"
            data-open="true"
            aria-hidden={false}
            role="complementary"
          >
            <div className="drawer-head">
              <button className="icon-button" aria-label="关闭详情" onClick={() => setDetailOpen(false)}><Icon name="close" size={16} /></button>
              <div className="grow"><div className="drawer-eyebrow">入口</div><h2>窗口</h2></div>
            </div>
            <div className="drawer-inner">
              <div className="drawer-entry-links">
                <a className="btn btn-sm" data-testid="drawer-workspace-artifacts" href="#/artifacts">
                  <Icon name="box" size={14} />
                  <span style={{ marginLeft: 6 }}>共享产物</span>
                </a>
              </div>
              <section className="drawer-section" data-testid="drawer-workspace-tasks">
                <div className="drawer-section-head">
                  <h3>任务</h3>
                  <span>{workspaceTasks.active.length} 个</span>
                </div>
                {workspaceTasks.active.length === 0 && <p className="muted" data-testid="drawer-workspace-empty">没有待确认或正在跑的任务。</p>}
                <nav className="drawer-task-nav" aria-label="进行中的任务">
                  {workspaceTasks.active.map(task => (
                    <a key={task.id} className="drawer-task-nav-item" data-testid={`drawer-workspace-task-${task.id}`} href={`#/tasks/${task.id}/graph`}>
                      <span className="grow truncate">{task.request}</span>
                      <Pill tone={TASK_TONE[task.status] ?? 'neutral'}>{TASK_LABEL[task.status] ?? task.status}</Pill>
                    </a>
                  ))}
                </nav>
                {workspaceTasks.ended.length > 0 && (
                  <details className="drawer-task-ended">
                    <summary data-testid="drawer-workspace-ended">已收纳 {workspaceTasks.ended.length} 个已完成/已终止的任务</summary>
                    <nav className="drawer-task-nav" aria-label="已结束的任务">
                      {workspaceTasks.ended.map(task => (
                        <a key={task.id} className="drawer-task-nav-item" data-testid={`drawer-workspace-task-${task.id}`} href={`#/tasks/${task.id}/graph`}>
                          <span className="grow truncate">{task.request}</span>
                          <Pill tone={TASK_TONE[task.status] ?? 'neutral'}>{TASK_LABEL[task.status] ?? task.status}</Pill>
                        </a>
                      ))}
                    </nav>
                  </details>
                )}
              </section>
            </div>
          </aside>
        </WindowDrawer>
      )}
      <Toaster />
    </div>
  );
}

function Sidebar({ path, settings, conversations, onSettingsChanged }: {
  path: string;
  settings: Settings_ | null;
  conversations: ConversationSummary[];
  onSettingsChanged: () => void;
}) {
  const [projectOpen, setProjectOpen] = useState<Record<string, boolean>>({});
  const [createProject, setCreateProject] = useState(false);
  const [archiving, setArchiving] = useState('');
  const ordered = [...conversations].sort((left, right) => (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt));
  const unbound = ordered.filter(conversation => !conversation.projectId);
  async function archiveConversation(conversation: ConversationSummary) {
    if (archiving) return;
    setArchiving(conversation.id);
    try {
      await api(`/api/conversations/${conversation.id}/archive`, {
        method: 'POST',
        body: JSON.stringify({ requestId: `archive-${crypto.randomUUID()}` }),
      });
      toast('对话已归档，可在设置的“归档对话”中恢复。', 'success');
      window.dispatchEvent(new Event('graph:conversations-changed'));
      if (path === `/conversations/${conversation.id}`) location.hash = '#/';
    } catch (reason) {
      toast(`归档失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    } finally {
      setArchiving('');
    }
  }
  return (
    <>
      <div className="sidebar-scroll" data-testid="conversation-list">
        <div className="sidebar-label">
          <span>项目</span>
          <button type="button" className="sidebar-add" data-testid="project-create-open" onClick={() => setCreateProject(true)} aria-label="新建项目" title="新建项目">
            <Icon name="plus" size={15} />
          </button>
        </div>
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
                  {items.map(conversation => (
                    <SidebarConversation
                      key={conversation.id}
                      conversation={conversation}
                      active={path === `/conversations/${conversation.id}`}
                      archiving={archiving === conversation.id}
                      onArchive={() => void archiveConversation(conversation)}
                    />
                  ))}
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
            {unbound.map(conversation => (
              <SidebarConversation
                key={conversation.id}
                conversation={conversation}
                active={path === `/conversations/${conversation.id}`}
                archiving={archiving === conversation.id}
                onArchive={() => void archiveConversation(conversation)}
              />
            ))}
            <a className="sidebar-conversation" href="#/" data-testid="new-conversation-recent">
              <Icon name="plus" size={15} />
              <span className="sidebar-conversation-title">新对话</span>
            </a>
          </div>
        </div>
      </div>
      {createProject && (
        <CreateProjectDialog
          onClose={() => setCreateProject(false)}
          onCreated={onSettingsChanged}
        />
      )}
    </>
  );
}

function SidebarConversation({ conversation, active, archiving, onArchive }: {
  conversation: ConversationSummary;
  active: boolean;
  archiving: boolean;
  onArchive: () => void;
}) {
  return (
    <div className="sidebar-conversation-row" data-active={active}>
      <a className="sidebar-conversation" href={`#/conversations/${conversation.id}`} data-active={active} title={conversation.title}>
        <Icon name="message" size={14} />
        <span className="sidebar-conversation-title">{conversation.title}</span>
        {conversation.openQuestions > 0 && <span className="sidebar-conversation-badge">{conversation.openQuestions}</span>}
      </a>
      <button
        type="button"
        className="sidebar-conversation-archive"
        data-testid={`archive-conversation-${conversation.id}`}
        disabled={archiving}
        onClick={onArchive}
        title="归档对话"
        aria-label={`归档对话 ${conversation.title}`}
      >
        <Icon name="archive" size={14} />
      </button>
    </div>
  );
}

function NewConversation({ settings, initialProjectId }: { settings: Settings_ | null; initialProjectId: string }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [modelId, setModelId] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState('low');
  const { data: agentContext } = useAsync(() => api<AgentContextView>('/api/agent-context'), []);

  useEffect(() => { setProjectId(initialProjectId); }, [initialProjectId]);
  // A new conversation inherits the daemon's default master model/thinking
  // unless the user picks something else before the first message.
  useEffect(() => {
    if (!settings || modelId) return;
    const selected = settings.models.find(model => model.id === settings.defaultModel) ?? settings.models[0];
    setModelId(selected?.id ?? '');
    setThinkingLevel(selected?.defaultThinkingLevel ?? defaultThinkingOption(selected?.thinkingOptions ?? []) ?? 'low');
  }, [settings, modelId]);
  const selectedModel = settings?.models.find(model => model.id === modelId);
  const telemetry: ComposerTelemetryView = {
    model: modelId || null,
    thinkingLevel,
    cacheHitRate: null,
    cachedInput: 0,
    cacheInput: 0,
    contextTokens: null,
    contextLimit: selectedModel?.contextWindow ?? null,
    contextPercent: null,
  };
  async function start() {
    if (busy) return;
    if (!text.trim() && !attachments.length) { setError('先说说你想解决什么，或添加一个附件。'); return; }
    const outgoing = composeSlashDirective(text, extractSlashTargets(
      text,
      agentContext?.tools ?? [],
      agentContext?.capabilities ?? [],
    ));
    setBusy(true);
    setError('');
    setText('');
    try {
      const created = await api<{ conversationId: string }>('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({
          ...(projectId ? { projectId } : {}),
          ...(outgoing.trim() ? { text: outgoing.trim() } : {}),
          ...(attachments.length ? { attachments: attachmentPayload(attachments) } : {}),
          ...(modelId ? { model: modelId } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
          requestId: `conv-${crypto.randomUUID()}`,
        }),
      });
      window.dispatchEvent(new Event('graph:conversations-changed'));
      location.hash = `#/conversations/${created.conversationId}`;
    } catch (reason) {
      setText(current => current || text);
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
      <ChatComposer
        className="new-chat-composer"
        value={text}
        onChange={setText}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        projectId={projectId || null}
        placeholder="例如：这个项目很乱，先帮我看看能从哪里改进。"
        slashTools={agentContext?.tools ?? []}
        slashCapabilities={agentContext?.capabilities ?? []}
        slashModels={settings?.models ?? []}
        slashTelemetry={telemetry}
        onSlashModelSelect={(model, level) => {
          setModelId(model.id);
          setThinkingLevel(level);
        }}
        onSend={() => void start()}
        sendDisabled={busy || (!text.trim() && !attachments.length)}
        autoFocus
        inputTestId="new-conversation-input"
        sendTestId="new-conversation-start"
        attachTestId="new-conversation-attach"
        attachmentInputTestId="new-conversation-attachment-input"
        leftActions={(
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
        )}
      />
      <div className="composer-footer new-chat-composer-footer">
        <span className="composer-note">Enter 发送，Shift + Enter 换行</span>
        <ComposerTelemetry
          telemetry={telemetry}
          models={settings?.models ?? []}
          onSelect={(model, level) => {
            setModelId(model.id);
            setThinkingLevel(level);
          }}
        />
      </div>
      {error && <ErrorBox message={error} />}
    </section>
  );
}

function Inbox({ tasks }: { tasks: TaskSummary[] }) {
  const pending = tasks.filter(task => (task.openQuestions ?? 0) > 0);
  const [views, setViews] = useState<Record<string, TaskView>>({});
  const [error, setError] = useState('');
  const { data: inbox, error: historyError, loading: historyLoading } = useAsync(() => api<{
    history: {
      id: string; taskId: string; nodeId: string; kind: string; status: string;
      data: Record<string, unknown>; answer: Record<string, unknown> | null;
      request: string; projectId: string; conversationId: string | null;
    }[];
  }>('/api/inbox'), []);
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
      {historyError && <ErrorBox message={historyError} />}
      {!pending.length && (
        <Card title="问题收件箱" icon="inbox">
          <Empty icon="check" title="没有待处理问题" hint={<span data-testid="inbox-empty">所有任务都在正常推进；需要人工介入时会出现在这里。</span>} />
        </Card>
      )}
      {pending.map(task => (
        <Card key={task.id} testid={`inbox-${task.id}`} icon="inbox" tone="warn"
          title={<a href={`#/tasks/${task.id}/graph`}>{task.request.slice(0, 70)}</a>}
          subtitle={`${task.projectId} · ${task.openQuestions} 个待处理问题`}>
          <ul className="list">{(views[task.id]?.questions ?? []).filter(question => question.status === 'open' && (question.owner ?? 'user') === 'user').map(question => (
            <QuestionReply key={question.id} taskId={task.id} question={question} onDone={() => void load()} />
          ))}</ul>
        </Card>
      ))}
      {pending.length > 5 && <p className="muted">其余 {pending.length - 5} 个任务请进入任务页处理。</p>}
      <Card title="已处理问题" icon="check" subtitle={inbox?.history.length ? `${inbox.history.length} 条历史记录` : undefined}>
        {historyLoading && <Spinner />}
        {!historyLoading && !(inbox?.history.length) && <p className="muted" data-testid="inbox-history-empty">暂无已处理问题。</p>}
        {Boolean(inbox?.history.length) && (
          <div className="question-history" data-testid="inbox-history">
            {inbox!.history.map(item => (
              <article className="question-history-item" key={item.id}>
                <div className="row">
                  <Pill tone="success">{describeQuestion(item.kind)}</Pill>
                  <a className="grow truncate" href={item.conversationId ? `#/conversations/${item.conversationId}` : `#/tasks/${item.taskId}`}>{item.request}</a>
                  <span className="faint">{item.projectId}</span>
                </div>
                {item.data.prompt ? <p className="muted">{String(item.data.prompt)}</p> : null}
                <div className="question-history-answer">
                  <strong>处理结果</strong>
                  <span>{item.answer ? JSON.stringify(item.answer) : '已处理'}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function GraphPanel({ id, settings, startup }: { id: string; settings: Settings_ | null; startup: Startup | null }) {
  const { data: graph, error, loading, reload } = useAsync(() => api<GraphPayload>(`/api/tasks/${id}/graph`), [id]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Clicking a node opens its chat tab: the node's own window is where its transcript and
  // overview live, so the graph does not grow a second, thinner copy of them.
  const [selected, setSelected] = useState<string | null>(null);
  function openNode(nodeId: string) {
    location.hash = `#/tasks/${id}/nodes/${nodeId}`;
  }
  const { data: view, reload: reloadView } = useAsync(() => api<TaskView>(`/api/tasks/${id}`), [id]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshAll = useCallback(() => {
    // One task event usually means several records changed; coalesce them.
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { reload(); reloadView(); }, 150);
  }, [reload, reloadView]);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
  const connected = useTaskStream(id, refreshAll);
  if (loading && !graph) return <Card><Spinner /></Card>;
  if (error && !graph) return <ErrorBox message={error} onRetry={reload} />;
  if (!graph) return <Card><Spinner /></Card>;
  const selectedNode = graph.nodes.find(node => node.id === selected);
  return (
    <div className="stagger" data-testid="graph" data-editable="false">
      <Card>
        <div className="row-between">
          <div className="row">
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
      </Card>

      <Card title="任务图" icon="graph" subtitle={graph.nodes.length ? `${graph.nodes.length} 个节点` : undefined}>
        {!graph.nodes.length && <Empty icon="graph" title="任务图为空" hint={<span data-testid="graph-empty">尚未确认提案，任务图为空。</span>} />}
        <GraphCanvas graph={graph} collapsed={collapsed} onSelect={openNode} selected={selected} />
      </Card>


    </div>
  );
}
