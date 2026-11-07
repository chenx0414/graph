
export type WorkspaceTabKind = 'context' | 'conversation' | 'draft' | 'graph' | 'node' | 'artifact' | 'page';

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  key: string;
  title: string;
  hash: string;
}

export type TabDescriptor = Omit<WorkspaceTab, 'id'>;

export interface WorkspaceTabs {
  tabs: readonly WorkspaceTab[];
  activeId: string | null;
}

export const EMPTY_TABS: WorkspaceTabs = { tabs: [], activeId: null };

export function tabId(kind: WorkspaceTabKind, key: string): string {
  return `${kind}:${key}`;
}

export function openTab(state: WorkspaceTabs, tab: TabDescriptor | null): WorkspaceTabs {
  if (!tab) return { ...state, activeId: null };
  const id = tabId(tab.kind, tab.key);
  const found = state.tabs.some(item => item.id === id);
  const tabs = found
    ? state.tabs.map(item => item.id === id ? { ...item, title: tab.title, hash: tab.hash } : item)
    : [...state.tabs, { id, ...tab }];
  return { tabs, activeId: id };
}

export function activateTab(state: WorkspaceTabs, id: string): WorkspaceTabs {
  return state.tabs.some(tab => tab.id === id) ? { tabs: state.tabs, activeId: id } : state;
}

export function retitleTab(state: WorkspaceTabs, id: string, title: string): WorkspaceTabs {
  return { tabs: state.tabs.map(tab => tab.id === id ? { ...tab, title } : tab), activeId: state.activeId };
}

export function closeTab(state: WorkspaceTabs, id: string): WorkspaceTabs {
  const index = state.tabs.findIndex(tab => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter(tab => tab.id !== id);
  if (state.activeId !== id) return { tabs, activeId: state.activeId };
  const neighbour = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeId: neighbour?.id ?? null };
}

function page(key: string, title: string, hash: string): TabDescriptor {
  return { kind: 'page', key, title, hash };
}

export function tabForPath(path: string): TabDescriptor | null {
  const pathname = path.split('?')[0]!.split('#')[0]!;
  if (pathname === '/' || pathname === '' || pathname === '/settings' || pathname === '/setup') return null;
  const context = /^\/conversations\/([^/]+)\/context$/.exec(pathname);
  if (context) return { kind: 'context', key: context[1]!, title: 'Agent 上下文', hash: `#${pathname}` };
  const draft = /^\/conversations\/([^/]+)\/graph$/.exec(pathname);
  if (draft) return { kind: 'draft', key: draft[1]!, title: '任务图', hash: `#${path}` };
  const conversation = /^\/conversations\/([^/]+)$/.exec(pathname);
  if (conversation) return { kind: 'conversation', key: conversation[1]!, title: '对话', hash: `#${pathname}` };
  const node = /^\/tasks\/([^/]+)\/nodes\/([^/]+)$/.exec(pathname);
  if (node) return { kind: 'node', key: `${node[1]}/${decodeURIComponent(node[2]!)}`, title: `节点 ${decodeURIComponent(node[2]!)}`, hash: `#${pathname}` };
  const artifact = /^\/tasks\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
  if (artifact) return { kind: 'artifact', key: `${artifact[1]}/${artifact[2]}`, title: '共享产物', hash: `#${path}` };
  const graph = /^\/tasks\/([^/]+)(?:\/graph)?$/.exec(pathname);
  if (graph) return { kind: 'graph', key: graph[1]!, title: '任务图', hash: `#/tasks/${graph[1]!}/graph` };
  if (pathname === '/artifacts') return page('artifacts', '共享产物', `#${path}`);
  if (pathname === '/insights' || pathname === '/usage' || pathname === '/tools') return page('insights', '洞察', '#/insights');
  if (pathname === '/models') return page('models', '模型', '#/models');
  if (/^\/catalog(?:\/[^/]+)?$/.test(pathname)) return page('catalog', '资源库', `#${pathname}`);
  return null;
}

export function withTitles(state: WorkspaceTabs, title: (tab: WorkspaceTab) => string | null): WorkspaceTabs {
  return {
    tabs: state.tabs.map(tab => {
      const better = title(tab)?.trim();
      return better ? { ...tab, title: better } : tab;
    }),
    activeId: state.activeId,
  };
}
