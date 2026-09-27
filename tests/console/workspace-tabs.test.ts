import { describe, expect, test } from 'vitest';
import {
  EMPTY_TABS,
  activateTab,
  activeTab,
  closeTab,
  openTab,
  retitleTab,
  tabForPath,
  withTitles,
  type WorkspaceTabs,
} from '../../src/web/workspace-tabs.ts';

/** Open a series of routes the way the shell does while the user navigates. */
function visit(...paths: string[]): WorkspaceTabs {
  return paths.reduce((state, path) => openTab(state, tabForPath(path)), EMPTY_TABS);
}

function ids(state: WorkspaceTabs): string[] {
  return state.tabs.map(tab => tab.id);
}

describe('tab identity', () => {
  test('the same destination is one tab, a different destination is a second one', () => {
    const once = visit('/conversations/c1');
    expect(ids(once)).toEqual(['conversation:c1']);
    expect(ids(visit('/conversations/c1', '/conversations/c1'))).toEqual(['conversation:c1']);
    expect(ids(visit('/conversations/c1', '/conversations/c2'))).toEqual(['conversation:c1', 'conversation:c2']);
  });

  test('one task can be open in several tabs: its detail, its graph and its nodes are distinct tabs', () => {
    const state = visit('/tasks/t1', '/tasks/t1/graph', '/tasks/t1/nodes/impl-a');
    expect(ids(state)).toEqual(['task:t1', 'graph:t1', 'node:t1/impl-a']);
    // Revisiting the graph of the same task reuses that tab instead of adding a fourth.
    expect(ids(openTab(state, tabForPath('/tasks/t1/graph')))).toEqual(['task:t1', 'graph:t1', 'node:t1/impl-a']);
  });

  test('the new-chat route and the settings takeover are not workspace tabs', () => {
    expect(tabForPath('/')).toBeNull();
    expect(tabForPath('/settings')).toBeNull();
    expect(tabForPath('/setup')).toBeNull();
  });

  test('every tab-able route names its destination and where it lives', () => {
    expect(tabForPath('/conversations/c1')).toEqual({ kind: 'conversation', key: 'c1', title: '对话', hash: '#/conversations/c1' });
    expect(tabForPath('/tasks/t1')).toEqual({ kind: 'task', key: 't1', title: '任务', hash: '#/tasks/t1' });
    expect(tabForPath('/tasks/t1/graph')).toEqual({ kind: 'graph', key: 't1', title: '任务图', hash: '#/tasks/t1/graph' });
    expect(tabForPath('/tasks/t1/nodes/impl-a')).toEqual({ kind: 'node', key: 't1/impl-a', title: '节点 impl-a', hash: '#/tasks/t1/nodes/impl-a' });
    expect(tabForPath('/inbox')).toEqual({ kind: 'page', key: 'inbox', title: '问题', hash: '#/inbox' });
    expect(tabForPath('/usage')).toEqual({ kind: 'page', key: 'usage', title: '用量', hash: '#/usage' });
    expect(tabForPath('/tools')).toEqual({ kind: 'page', key: 'tools', title: '工具', hash: '#/tools' });
    expect(tabForPath('/catalog')).toEqual({ kind: 'page', key: 'catalog', title: '资源库', hash: '#/catalog' });
    expect(tabForPath('/nonsense')).toBeNull();
  });
});

describe('activation', () => {
  test('opening a tab activates it', () => {
    expect(activeTab(visit('/conversations/c1', '/usage'))?.id).toBe('page:usage');
  });

  test('revisiting an existing tab activates it instead of adding another', () => {
    const state = visit('/conversations/c1', '/usage');
    expect(activeTab(activateTab(state, 'conversation:c1'))?.id).toBe('conversation:c1');
    expect(ids(activateTab(state, 'conversation:c1'))).toEqual(['conversation:c1', 'page:usage']);
  });

  test('a destination that moved inside its own tab carries the newer address', () => {
    const state = visit('/catalog', '/catalog/models');
    expect(ids(state)).toEqual(['page:catalog']);
    expect(activeTab(state)?.hash).toBe('#/catalog/models');
  });

  test('activating an unknown tab changes nothing', () => {
    const state = visit('/conversations/c1');
    expect(state).toEqual(activateTab(state, 'graph:missing'));
  });

  test('the active tab can be retitled without touching the others', () => {
    const state = visit('/conversations/c1', '/conversations/c2');
    const titled = retitleTab(state, 'conversation:c1', '重构主页面');
    expect(titled.tabs.map(tab => tab.title)).toEqual(['重构主页面', '对话']);
    expect(activeTab(titled)?.id).toBe('conversation:c2');
  });
});

describe('closing', () => {
  test('closing the active tab activates the one on its right', () => {
    const state = visit('/conversations/c1', '/conversations/c2', '/conversations/c3');
    const after = closeTab(activateTab(state, 'conversation:c2'), 'conversation:c2');
    expect(ids(after)).toEqual(['conversation:c1', 'conversation:c3']);
    expect(activeTab(after)?.id).toBe('conversation:c3');
  });

  test('closing the last tab activates the one on its left', () => {
    const state = visit('/conversations/c1', '/conversations/c2');
    const after = closeTab(state, 'conversation:c2');
    expect(activeTab(after)?.id).toBe('conversation:c1');
  });

  test('closing a background tab leaves the active one alone', () => {
    const state = visit('/conversations/c1', '/conversations/c2');
    const after = closeTab(state, 'conversation:c1');
    expect(ids(after)).toEqual(['conversation:c2']);
    expect(activeTab(after)?.id).toBe('conversation:c2');
  });

  test('closing the only tab leaves the workspace empty', () => {
    const after = closeTab(visit('/conversations/c1'), 'conversation:c1');
    expect(after.tabs).toEqual([]);
    expect(activeTab(after)).toBeNull();
  });

  test('closing an unknown tab changes nothing', () => {
    const state = visit('/conversations/c1');
    expect(state).toEqual(closeTab(state, 'graph:missing'));
  });
});

describe('titles from loaded data', () => {
  test('a conversation tab takes the conversation title and a task tab the task request', () => {
    const state = visit('/conversations/c1', '/tasks/t1/graph');
    const titled = withTitles(state, tab => tab.kind === 'conversation' ? '重构主页面' : tab.kind === 'graph' ? '外壳与标签栏' : null);
    expect(titled.tabs.map(tab => tab.title)).toEqual(['重构主页面', '外壳与标签栏']);
  });

  test('a blank or missing title leaves the generic one in place', () => {
    const state = visit('/conversations/c1', '/usage');
    const titled = withTitles(state, tab => tab.kind === 'conversation' ? '   ' : null);
    expect(titled.tabs.map(tab => tab.title)).toEqual(['对话', '用量']);
  });
});
