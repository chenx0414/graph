import { ArtifactDetail } from './ArtifactViews.tsx';
import { ArtifactIndex } from './ArtifactIndex.tsx';
import { DraftGraphTab } from './DraftGraphTab.tsx';
import { TaskDrawerSection } from './TaskDrawerSection.tsx';
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
import { Activity, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { AgentContextPage, type AgentContextView } from './AgentContext.tsx';
import { ChatComposer, type ChatAttachment } from './ChatComposer.tsx';
import { attachmentPayload } from './attachments.ts';
import { ComposerTelemetry, type ComposerTelemetryView } from './ComposerTelemetry.tsx';
import { defaultThinkingOption } from './thinking-levels.ts';
import { CreateProjectDialog } from './CreateProjectDialog.tsx';
import { GraphPanel } from './GraphPanel.tsx';
import { NodeChatTab } from './NodeDetail.tsx';
import { ConversationPanel, type ConversationSummary, type GraphAgentDetail } from './Conversation.tsx';
import { NODE_LABEL, QUESTION_LABEL, TASK_LABEL, describeQuestion, when } from './labels.ts';
import { QuestionReply } from './Questions.tsx';
import { ErrorBox, useAsync, useTargetBranch, useTaskStream } from './shared.tsx';
import { formatTokens, openQuestionTotal } from './insights.ts';
import { Button, Card, Empty, Icon, Pill, Spinner, Stat, StatusDot, Toaster, toast, type IconName } from './ui.tsx';
import type { CapabilityRecord } from '../catalog/catalog.ts';
import type { AgentCombination, AgentCombinationView } from '../catalog/agent-combinations.ts';
import { composeSlashDirective, extractSlashTargets } from './SlashCommands.tsx';

// Keep low-frequency pages outside the chat startup path. React retains each
// resolved module; switching a workspace tab keeps its existing Activity state.
const Settings = lazy(() => import('./Settings.tsx').then(module => ({ default: module.Settings })));
const ModelsPage = lazy(() => import('./Settings.tsx').then(module => ({ default: module.ModelsPage })));
const UsagePage = lazy(() => import('./Usage.tsx').then(module => ({ default: module.UsagePage })));
const ToolStatsPage = lazy(() => import('./ToolStats.tsx').then(module => ({ default: module.ToolStatsPage })));
const CapabilityResourceLibrary = lazy(() => import('./ResourceLibrary.tsx').then(module => ({ default: module.ResourceLibrary })));

type TaskSummary = {
  id: string; projectId: string; request: string; phase: string; status: string;
  acceptedProposalVersion: number | null; createdAt: number; updatedAt: number | null; openQuestions?: number;
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
  proposal: import('../core/types.ts').NativeProposal | null;
};
type NodeView = {
  id: string; kind: string; status: string; container?: string; used?: number | null; budget?: number | null; unlimited?: boolean;
  reserved?: number; instanceId?: string | null; selectedModel?: string; boundDefinition?: string;
  activationId?: string; outputVersion?: number; stallCount?: number;
  context?: {
    purpose?: string; sourceNode?: string; requiredFacts?: { kind: string }[]; independence?: string;
    predecessors?: { source?: string; mode?: string }[];
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
    try { return window.matchMedia('(max-width: 860px)').matches || localStorage.getItem('graph-sidebar-collapsed') === 'true'; } catch { return false; }
  });
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedDrawerTaskId, setSelectedDrawerTaskId] = useState<string | null>(null);
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
      if (window.matchMedia('(max-width: 860px)').matches) setSidebarCollapsed(true);
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
  useEffect(() => {
    setDetailOpen(false);
    const taskId = /^\/tasks\/([^/]+)/.exec(path)?.[1];
    if (taskId) setSelectedDrawerTaskId(taskId);
  }, [path]);

  const pathname = path.split('?')[0];
  const questionTotal = openQuestionTotal(tasks);
  // Tabs are named from the data the shell already polls: a conversation by its own title, a
  // task by its request. Until that arrives the tab keeps the generic name it opened with.
  const shownTabs = withTitles(tabs, tab => {
    if (tab.kind === 'context') {
      const title = conversations?.find(item => item.id === tab.key)?.title;
      return title ? `上下文 · ${title}` : null;
    }
    if (tab.kind === 'conversation') return conversations?.find(item => item.id === tab.key)?.title ?? null;
    // A task's tabs stay distinguishable from each other: the kind names the window, the request
    // names the task, so "任务图 · 外壳与标签栏" never looks like "节点 impl-shell".
    const prefix = tab.kind === 'graph' ? '任务图' : null;
    if (!prefix) return null;
    const request = tasks.find(item => item.id === tab.key)?.request;
    return request ? `${prefix} · ${request}` : null;
  });
  const catalogMatch = /^\/catalog(?:\/([^/]+))?$/.exec(pathname ?? '/');
  const taskMatch = /^\/tasks\/([^/]+)(?:\/graph)?$/.exec(pathname ?? '/');
  const conversationMatch = /^\/conversations\/([^/]+)$/.exec(pathname ?? '/');
  const currentProjectId = tasks.find(task => task.id === selectedDrawerTaskId)?.projectId
    ?? (conversationMatch ? conversations?.find(item => item.id === conversationMatch[1])?.projectId : null)
    ?? settings?.projects[0]?.id
    ?? null;
  function openWorkspaceTab(id: string) {
    const tab = tabs.tabs.find(item => item.id === id);
    if (!tab) return;
    setTabs(current => activateTab(current, id));
    setPath(tab.hash.slice(1));
    // A tab that points where we already are needs no navigation; anything else sets the hash,
    // which the hash listener turns back into the same tab being in front.
    if (tab.hash !== `#${path}`) location.hash = tab.hash;
  }
  function closeWorkspaceTab(id: string) {
    const wasActive = tabs.activeId === id;
    const next = closeTab(tabs, id);
    setTabs(next);
    if (!wasActive) return;
    const active = next.tabs.find(tab => tab.id === next.activeId);
    const hash = active ? active.hash : '#/';
    setPath(hash.slice(1));
    location.hash = hash;
  }
  function startNewConversation() {
    location.hash = '#/';
  }
  // Tab content that only learns its own name after loading (a shared artifact) renames its tab.
  function retitleWorkspaceTab(kind: WorkspaceTabKind, key: string, title: string) {
    setTabs(current => retitleTab(current, tabId(kind, key), title));
  }
  const destination = tabForPath(path);
  const visibleTabId = destination ? tabId(destination.kind, destination.key) : null;
  const settingsPage = pathname === '/settings' || pathname === '/setup';
  useEffect(() => {
    if (settingsPage) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing) return;
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        const tab = tabs.tabs[event.key === '9' ? tabs.tabs.length - 1 : Number(event.key) - 1];
        if (tab) openWorkspaceTab(tab.id);
      } else if (event.key.toLowerCase() === 'w') {
        event.preventDefault();
        const current = tabForPath(path);
        if (current) closeWorkspaceTab(tabId(current.kind, current.key));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs, path, settingsPage]);

  useEffect(() => {
    document.title = `${settingsPage ? '设置' : shownTabs.tabs.find(tab => tab.id === visibleTabId)?.title ?? '新对话'} · Graph`;
  }, [settingsPage, shownTabs, visibleTabId]);

  if (settingsPage) {
    return (
      <div className="settings-app-root">
        <Suspense fallback={<Spinner />}><Settings openGuide={pathname === '/setup'} /></Suspense>
        <Toaster />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <button type="button" className="skip-link" onClick={() => document.getElementById('workspace-main')?.focus()}>跳到主内容</button>
      <aside className="sidebar" data-collapsed={sidebarCollapsed}>
        <div className="sidebar-heading">
          <a className="brand" href="#/" aria-label="Graph 首页"><div className="brand-mark" /><span className="brand-name">Graph</span></a>
          <span className="sidebar-caption">Agent 协作空间</span>
        </div>
        <a className="sidebar-start" href="#/" aria-label="新对话"><Icon name="plus" size={17} /><span>新对话</span></a>
        <nav className="rail" data-testid="app-rail" aria-label="主入口">
          <button type="button" className="rail-button icon-button" data-testid="sidebar-toggle"
            onClick={() => setSidebarCollapsed(value => !value)} aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? '展开左侧抽屉' : '收起左侧抽屉'}
            aria-label={sidebarCollapsed ? '导航：展开左侧抽屉' : '导航：收起左侧抽屉'}>
            <Icon name="panel-left" size={17} /><span className="rail-label">导航</span>
          </button>
          <a className="rail-button" href="#/inbox" data-testid="rail-inbox" title="问题" aria-label="问题" data-active={pathname === '/inbox'}>
            <Icon name="inbox" size={17} /><span className="rail-label">问题</span>
            {questionTotal > 0 && <span className="rail-badge" data-testid="rail-inbox-badge">{questionTotal}</span>}
          </a>
          <a className="rail-button" href="#/catalog" data-testid="rail-catalog" title="资源库" aria-label="资源库" data-active={Boolean(catalogMatch)}>
            <Icon name="catalog" size={17} /><span className="rail-label">资源库</span>
          </a>
          <a className="rail-button" href="#/usage" data-testid="rail-usage" title="用量" aria-label="用量" data-active={pathname === '/usage'}>
            <Icon name="usage" size={17} /><span className="rail-label">用量</span>
          </a>
          <a className="rail-button" href="#/tools" data-testid="rail-tools" title="工具" aria-label="工具" data-active={pathname === '/tools'}>
            <Icon name="tool" size={17} /><span className="rail-label">工具</span>
          </a>
          <a className="rail-button" href="#/models" data-testid="rail-models" title="模型" aria-label="模型" data-active={pathname === '/models'}>
            <Icon name="bolt" size={17} /><span className="rail-label">模型</span>
          </a>
          <div className="rail-spacer" />
          <a className="rail-button" href="#/settings" data-testid="rail-settings" title="设置" aria-label="设置" data-active={settingsPage}>
            <Icon name="settings" size={17} /><span className="rail-label">设置</span>
          </a>
        </nav>
        <div className="sidebar-body">
          <Sidebar
            path={pathname ?? '/'}
            settings={settings}
            conversations={conversations ?? []}
            onSettingsChanged={reloadSettings}
          />
        </div>
      </aside>
      <main className="main" id="workspace-main" tabIndex={-1}>
        <div className="workspace-bar" data-testid="workspace-bar">
          <TabBar
            state={shownTabs}
            onActivate={openWorkspaceTab}
            onClose={closeWorkspaceTab}
            onOpenNew={startNewConversation}
          />
          {/* The bar itself is a window drag region in the desktop app, so everything the user
              can click has to opt out of it - otherwise the control is draggable, not pressable. */}
          <div className="workspace-bar-actions">
            {conversationMatch && <a className="icon-button" data-testid="agent-context-open"
              href={`#/conversations/${conversationMatch[1]}/context`} title="Agent 上下文" aria-label="Agent 上下文">
              <Icon name="spark" size={16} />
            </a>}
            <div id="conversation-toolbar" />
            {!conversationMatch && (            <button
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
            </button>)}
          </div>
        </div>
        {startup && !startup.configured && (
          <div className="banner" data-testid="banner">
            <Icon name="alert" />
            <div className="banner-copy">
              <strong>{startup.modelCount === 0 ? '连接模型，开始协作' : '模型凭据需要检查'}</strong>
              <span>{startup.modelCount === 0 ? '连接厂商并添加模型。当前为仅查看模式，不会派发任务。' : '当前仅可浏览。请检查模型凭据或配置对应的环境变量。'}</span>
            </div>
            <a className="btn btn-sm" href="#/models">{startup.modelCount === 0 ? '连接模型' : '检查凭据'}<Icon name="chevron" size={14} /></a>
          </div>
        )}
        {startup?.mode === 'view' && startup.configured && (
          <div className="banner info" data-testid="banner-view">
            <Icon name="bolt" />
            仅查看模式：可浏览与配置，不派发模型请求。使用 --execute 启动以启用调度。
          </div>
        )}
        {/* Activity retains local state and DOM, disconnecting effects while a tab is hidden. */}
        {tabs.tabs.map(tab => (
          <Activity key={tab.id} mode={tab.id === visibleTabId ? 'visible' : 'hidden'}>
            <WorkspacePage path={tab.id === visibleTabId ? path : tab.hash.slice(1)}
              active={tab.id === visibleTabId} settings={settings} startup={startup} tasks={tasks} conversations={conversations ?? []}
              reloadConversations={reloadConversations} refreshTasks={refreshTasks} detailOpen={detailOpen} setDetailOpen={setDetailOpen}
              retitleWorkspaceTab={retitleWorkspaceTab} />
          </Activity>
        ))}
        {pathname === '/' && <WorkspacePage path={path} active settings={settings} startup={startup} tasks={tasks} conversations={conversations ?? []}
          reloadConversations={reloadConversations} refreshTasks={refreshTasks} detailOpen={detailOpen} setDetailOpen={setDetailOpen}
          retitleWorkspaceTab={retitleWorkspaceTab} />}

      </main>
      {!conversationMatch && detailOpen && (
        <WindowDrawer open={detailOpen}>
          <aside className="detail-drawer" data-testid="detail-drawer" data-section="task" data-open="true" role="complementary">
            <div className="drawer-inner">
              <TaskDrawerSection tasks={tasks} selectedId={selectedDrawerTaskId} onSelect={setSelectedDrawerTaskId}
                projectId={currentProjectId} origin="workspace" />
            </div>
          </aside>
        </WindowDrawer>
      )}
      <Toaster />
    </div>
  );
}

function WorkspacePage({ path, active, settings, startup, tasks, conversations, reloadConversations, refreshTasks, detailOpen, setDetailOpen, retitleWorkspaceTab }: {
  path: string; active: boolean; settings: Settings_ | null; startup: Startup | null; tasks: TaskSummary[]; conversations: ConversationSummary[];
  refreshTasks: () => Promise<void>; reloadConversations: () => void; detailOpen: boolean; setDetailOpen: (open: boolean) => void;
  retitleWorkspaceTab: (kind: WorkspaceTabKind, key: string, title: string) => void;
}) {
  const [pathname, query = ''] = path.split('?');
  const queryParams = new URLSearchParams(query);
  const catalogMatch = /^\/catalog(?:\/([^/]+))?$/.exec(pathname ?? '/');
  const taskMatch = /^\/tasks\/([^/]+)(?:\/graph)?$/.exec(pathname ?? '/');
  const nodeMatch = /^\/tasks\/([^/]+)\/nodes\/([^/]+)$/.exec(pathname ?? '/');
  const artifactMatch = /^\/tasks\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname ?? '/');
  const draftGraphMatch = /^\/conversations\/([^/]+)\/graph$/.exec(pathname ?? '/');
  const contextMatch = /^\/conversations\/([^/]+)\/context$/.exec(pathname ?? '/');
  const conversationMatch = /^\/conversations\/([^/]+)$/.exec(pathname ?? '/');
  const conversationFirst = pathname === '/' || Boolean(conversationMatch || draftGraphMatch || nodeMatch || contextMatch);
  return <div className={`content ${conversationFirst ? 'conversation-content' : ''}`}>
    <div className={`page ${conversationFirst ? 'conversation-page-host' : ''}`}>
            {pathname === '/' && <NewConversation settings={settings} initialProjectId={queryParams.get('project') ?? ''} />}
            {contextMatch && <AgentContextPage conversationId={contextMatch[1]!} />}
            {pathname === '/inbox' && <Inbox tasks={tasks} onAnswered={() => void refreshTasks().catch(() => undefined)} />}
            {catalogMatch && <Suspense fallback={<Spinner />}><CapabilityResourceLibrary settings={settings} section={catalogMatch[1]} /></Suspense>}
            {pathname === '/usage' && <Suspense fallback={<Spinner />}><UsagePage /></Suspense>}
            {pathname === '/tools' && <Suspense fallback={<Spinner />}><ToolStatsPage /></Suspense>}
            {pathname === '/models' && <Suspense fallback={<Spinner />}><ModelsPage /></Suspense>}
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
                tasks={tasks}
                conversations={conversations}
              />
            )}
            {conversationMatch && (
              <ConversationPanel
                key={conversationMatch[1]}
                id={conversationMatch[1]!}
                settings={settings}
                onChanged={reloadConversations}
                drawerOpen={active && detailOpen}
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
                nodeId={decodeURIComponent(nodeMatch[2]!)}
              />
            )}
            {taskMatch && <GraphPanel id={taskMatch[1]!} />}
    </div>
  </div>;
}

function Sidebar({ path, settings, conversations, onSettingsChanged }: {
  path: string;
  settings: Settings_ | null;
  conversations: ConversationSummary[];
  onSettingsChanged: () => void;
}) {
  const [sections, setSections] = useState({ projects: true, recent: true });
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
          <button type="button" className="sidebar-section-toggle" aria-expanded={sections.projects} onClick={() => setSections(value => ({ ...value, projects: !value.projects }))}><Icon name="chevron" size={12} /><span>项目</span></button>
          <button type="button" className="sidebar-add" data-testid="project-create-open" onClick={() => setCreateProject(true)} aria-label="新建项目" title="新建项目">
            <Icon name="plus" size={15} />
          </button>
        </div>
        <div className="sidebar-section" hidden={!sections.projects}>
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
          {!settings?.projects.length && <div className="sidebar-empty">添加项目，让 Agent 了解你的代码。<button type="button" className="sidebar-empty-action" onClick={() => setCreateProject(true)}>添加项目<Icon name="plus" size={13} /></button></div>}
        </div>
        <div className="sidebar-label"><button type="button" className="sidebar-section-toggle" aria-expanded={sections.recent} onClick={() => setSections(value => ({ ...value, recent: !value.recent }))}><Icon name="chevron" size={12} /><span>最近</span></button>
          <a className="sidebar-add" href="#/" data-testid="new-conversation-recent" title="新对话" aria-label="新对话"><Icon name="plus" size={15} /></a>
        </div>
        <div className="sidebar-section" hidden={!sections.recent}>
          <div className="sidebar-conversations" style={{ paddingLeft: 0 }}>
            {!unbound.length && <span className="sidebar-empty">新对话会显示在这里</span>}
            {unbound.map(conversation => (
              <SidebarConversation
                key={conversation.id}
                conversation={conversation}
                active={path === `/conversations/${conversation.id}`}
                archiving={archiving === conversation.id}
                onArchive={() => void archiveConversation(conversation)}
              />
            ))}

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
        <div className="new-chat-mark" aria-hidden="true" />
        <span className="new-chat-eyebrow">从一个目标，开始协作</span>
        <h1>开始新对话</h1>
        <p>描述你想解决的问题，主 Agent 会帮你理清思路、制定方案并协调执行。</p>
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
            <option value="">先聊聊，暂不选项目</option>
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
      <div className="starter-grid" aria-label="试试这些任务">
        {([
          { icon: 'search', title: '了解项目', hint: '梳理结构，找到改进方向', prompt: '帮我梳理这个项目的结构与主要流程，找出值得优先改进的地方。' },
          { icon: 'bolt', title: '解决问题', hint: '描述现象，一起定位原因', prompt: '我遇到了一个问题，请先帮我分析原因，并告诉我需要补充哪些信息：' },
          { icon: 'graph', title: '开发功能', hint: '从想法到可执行的方案', prompt: '我想给这个项目添加一项功能，请先帮我明确需求和验收条件，再制定方案：' },
        ] satisfies { icon: IconName; title: string; hint: string; prompt: string }[]).map(item => <button type="button" className="starter-card" key={item.title} disabled={busy} onClick={() => {
          if (text.trim()) return;
          setText(item.prompt);
          document.querySelector<HTMLElement>('[data-testid="new-conversation-input"]')?.focus();
        }} aria-disabled={Boolean(text.trim())}>
          <Icon name={item.icon} size={18} /><strong>{item.title}</strong><span>{item.hint}</span>
        </button>)}
      </div>
      <ol className="onboarding-steps" aria-label="协作流程">
        <li><span>1</span>描述目标</li><li><span>2</span>确认方案草稿</li><li><span>3</span>在任务图中跟进</li>
      </ol>
    </section>
  );
}

function Inbox({ tasks, onAnswered }: { tasks: TaskSummary[]; onAnswered: () => void }) {
  const pending = tasks.filter(task => (task.openQuestions ?? 0) > 0);
  const [views, setViews] = useState<Record<string, TaskView>>({});
  const [error, setError] = useState('');
  const { data: inbox, error: historyError, loading: historyLoading, reload: reloadHistory } = useAsync(() => api<{
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
          <Empty icon="check" title="没有待处理问题" hint={<span data-testid="inbox-empty">需要你决策或补充信息时，问题会显示在这里。</span>} />
        </Card>
      )}
      {pending.map(task => (
        <Card key={task.id} testid={`inbox-${task.id}`} icon="inbox" tone="warn"
          title={<a href={`#/tasks/${task.id}/graph`}>{task.request.slice(0, 70)}</a>}
          subtitle={`${task.projectId} · ${task.openQuestions} 个待处理问题`}>
          <ul className="list">{(views[task.id]?.questions ?? []).filter(question => question.status === 'open' && (question.owner ?? 'user') === 'user').map(question => (
            <QuestionReply key={question.id} taskId={task.id} question={question} onDone={() => { void load(); void reloadHistory(); onAnswered(); }} />
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
