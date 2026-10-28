/**
 * The workspace tab set: which windows the user has open in the main area and
 * which one is in front.
 *
 * The shell keeps the hash
 * route as the truth for *what is on screen* and this module as the truth for
 * *which tabs exist*; activating a tab navigates, navigating updates the tab.
 *
 * Two destinations are deliberately not tabs: the new-chat page (`#/`), which is
 * what an empty workspace shows, and the settings takeover (`#/settings`,
 * `#/setup`), which replaces the whole shell by design.
 */

export type WorkspaceTabKind = 'context' | 'conversation' | 'draft' | 'graph' | 'node' | 'artifact' | 'page';

export interface WorkspaceTab {
  /** Stable identity: `kind:key`. The same destination never opens twice. */
  id: string;
  kind: WorkspaceTabKind;
  /** What the tab points at: a conversation id, a task id, `taskId/nodeId`, or a page id. */
  key: string;
  title: string;
  /** Where activating this tab navigates to. */
  hash: string;
}

/** A destination the shell can put in a tab. */
export type TabDescriptor = Omit<WorkspaceTab, 'id'>;

export interface WorkspaceTabs {
  tabs: readonly WorkspaceTab[];
  activeId: string | null;
}

export const EMPTY_TABS: WorkspaceTabs = { tabs: [], activeId: null };

export function tabId(kind: WorkspaceTabKind, key: string): string {
  return `${kind}:${key}`;
}

/**
 * Open a destination: an existing tab is refreshed and brought to the front, a
 * new one is appended. A `null` destination keeps the open set but clears its
 * selection — the new-chat page and settings are outside the tab set.
 */
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

/**
 * Close a tab. Closing the tab in front hands the front to its right-hand
 * neighbour, or to the left when it was the last one; closing the final tab
 * leaves an empty workspace.
 */
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

/** Where a hash route lives in the tab set, or `null` when it is not a tab. */
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
  // `/tasks/<id>` and `/tasks/<id>/graph` are the same window now; the graph address is canonical.
  const graph = /^\/tasks\/([^/]+)(?:\/graph)?$/.exec(pathname);
  if (graph) return { kind: 'graph', key: graph[1]!, title: '任务图', hash: `#/tasks/${graph[1]!}/graph` };
  if (pathname === '/artifacts') return page('artifacts', '共享产物', `#${path}`);
  if (pathname === '/usage') return page('usage', '用量', '#/usage');
  if (pathname === '/tools') return page('tools', '工具', '#/tools');
  if (pathname === '/models') return page('models', '模型', '#/models');
  if (/^\/catalog(?:\/[^/]+)?$/.test(pathname)) return page('catalog', '资源库', `#${pathname}`);
  return null;
}

/**
 * Improve tab titles with what the shell has since learned — a conversation's
 * own title, a task's request. A tab keeps its generic title until the data
 * arrives, and a blank answer never replaces a usable one.
 */
export function withTitles(state: WorkspaceTabs, title: (tab: WorkspaceTab) => string | null): WorkspaceTabs {
  return {
    tabs: state.tabs.map(tab => {
      const better = title(tab)?.trim();
      return better ? { ...tab, title: better } : tab;
    }),
    activeId: state.activeId,
  };
}
