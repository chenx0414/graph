


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

import { Activity,Suspense,lazy,useCallback,useEffect,useState } from 'react';

import { api } from './api.ts';









import { type ConversationSummary,type GraphAgentDetail } from './Conversation.tsx';

import { TASK_LABEL,describeQuestion } from './labels.ts';


import { useAsync } from './shared.tsx';
import { StaleBuildBanner } from './build-freshness.tsx';

import { openQuestionTotal } from './insights.ts';

import { Icon,Spinner,Toaster } from './ui.tsx';

import type { CapabilityRecord } from './catalog-view-types.ts';

import type { AgentCombinationView } from './catalog-view-types.ts';

import { Sidebar } from "./app-sidebar.tsx";
import { WorkspacePage } from "./app-workspace.tsx";

export const Settings = lazy(() => import('./Settings.tsx').then(module => ({ default: module.Settings })));

export const ModelsPage = lazy(() => import('./Settings.tsx').then(module => ({ default: module.ModelsPage })));

export const InsightsPage = lazy(() => import('./Insights.tsx').then(module => ({ default: module.InsightsPage })));

export const CapabilityResourceLibrary = lazy(() => import('./ResourceLibrary.tsx').then(module => ({ default: module.ResourceLibrary })));

export type TaskSummary = {
  id: string; projectId: string; request: string; phase: string; status: string;
  acceptedProposalVersion: number | null; createdAt: number; updatedAt: number | null; openQuestions?: number;
};

export type Startup = { mode: 'view' | 'execute'; configured: boolean; modelCount: number; enabledModelCount: number; effectiveRevision?: number; limitAliases?: Record<string, string> };

export type TaskView = {
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

export type NodeView = {
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
  projects: { id: string; root: string; branch?: string | null; archivedAt?: number | null; ownCheckout?: boolean; preparation?: { branch?: string | null } | null }[];
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

export const NODE_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'> = {
  pending: 'neutral', ready: 'info', preparing: 'accent', running: 'accent',
  succeeded: 'success', failed: 'danger', blocked: 'warn', skipped: 'neutral',
};

export function statusText(view: TaskView) {
  if (view.paused) return TASK_LABEL[view.status] ?? view.status;
  const open = view.questions.filter(question => question.status === 'open' && (question.owner ?? 'user') === 'user');
  if (open.length) return open.map(question => describeQuestion(question.kind, question.data)).join('、');
  return TASK_LABEL[view.status] ?? view.status;
}

export function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  return hash;
}

export function App() {
  useUsageRefresh();
  const [path, setPath] = useState(route);
  const [settings, setSettings] = useState<Settings_ | null>(null);
  const [startup, setStartup] = useState<Startup | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
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
    setDetailOpen(false);
    const taskId = /^\/tasks\/([^/]+)/.exec(path)?.[1];
    if (taskId) setSelectedDrawerTaskId(taskId);
  }, [path]);

  // There is no "new conversation" page any more: a conversation comes from the global
  // Agent or from a project's supervisor thread. Landing on the root opens the global
  // one, so a fresh window still arrives somewhere that can talk.
  useEffect(() => {
    if (path !== '/' || !conversations) return;
    const global = conversations.find(item => 'role' in item && item.role === 'global');
    if (global) {
      location.hash = `#/conversations/${global.id}`;
      return;
    }
    void api<{ conversationId: string }>('/api/orchestration/global', {
      method: 'POST', body: JSON.stringify({ requestId: `open-global-${crypto.randomUUID()}` }),
    }).then(thread => {
      window.dispatchEvent(new Event('graph:conversations-changed'));
      location.hash = `#/conversations/${thread.conversationId}`;
    }).catch(() => undefined);
  }, [path, conversations]);
  const pathname = path.split('?')[0];
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
    document.title = `${settingsPage ? '设置' : shownTabs.tabs.find(tab => tab.id === visibleTabId)?.title ?? 'Graph'} · Graph`;
  }, [settingsPage, shownTabs, visibleTabId]);

  if (settingsPage) {
    return (
      <div className="settings-app-root">
        <StaleBuildBanner />
        <Suspense fallback={<Spinner />}><Settings openGuide={pathname === '/setup'} /></Suspense>
        <Toaster />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <StaleBuildBanner />
      <button type="button" className="skip-link" onClick={() => document.getElementById('workspace-main')?.focus()}>跳到主内容</button>
      <aside className="sidebar">
        <div className="sidebar-heading">
          <a className="brand" href="#/" aria-label="Graph 首页"><div className="brand-mark" /><span className="brand-name">Graph</span></a>
        </div>
        <nav className="rail" data-testid="app-rail" aria-label="主入口">
          <a className="rail-button" href="#/catalog" data-testid="rail-catalog" title="资源库" aria-label="资源库" data-active={Boolean(catalogMatch)}>
            <Icon name="catalog" size={17} /><span className="rail-label">资源库</span>
          </a>
          <a className="rail-button" href="#/insights" data-testid="rail-insights" title="洞察" aria-label="洞察"
            data-active={pathname === '/insights' || pathname === '/usage' || pathname === '/tools'}>
            <Icon name="usage" size={17} /><span className="rail-label">洞察</span>
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
