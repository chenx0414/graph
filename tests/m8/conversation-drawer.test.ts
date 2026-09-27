import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  CHAT_RESIDENT_PANEL_IDS,
  DRAWER_ENTRY_LINKS,
  DRAWER_INIT_PANEL_IDS,
  DRAWER_PANEL_IDS,
  defaultDrawerOpen,
  groupArtifacts,
  isEndedTask,
  drawerEntryLabel,
  drawerInitPanelIds,
  drawerEntryIds,
  drawerPanelIds,
  draftStatusLabel,
  isDrawerPanel,
  isResidentPanel,
  panelPlacement,
  residentPanelIds,
  resolveDrawerSection,
  splitTasksByLifecycle,
} from '../../src/web/conversation-drawer.ts';

const read = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

/** Pure policy for the chat containment: only the transcript, the pending
 * questions and the composer stay in the chat column. The draft card and every
 * task / node overview move into the right drawer, which starts collapsed and
 * is reached through a labelled, stateful entry. */

describe('drawer default state', () => {
  test('the drawer is collapsed by default', () => {
    expect(defaultDrawerOpen()).toBe(false);
  });
});

describe('chat-stream resident policy', () => {
  test('the chat stream keeps only the transcript, the questions and the composer', () => {
    for (const id of ['conversation-messages', 'conversation-questions', 'conversation-composer']) {
      expect(residentPanelIds()).toContain(id);
      expect(isResidentPanel(id)).toBe(true);
      expect(panelPlacement(id)).toBe('main');
    }
    expect(CHAT_RESIDENT_PANEL_IDS).toEqual(['conversation-messages', 'conversation-questions', 'conversation-composer']);
  });

  test('the draft card and the task overviews are not resident any more', () => {
    for (const id of ['proposal-draft', 'accept-branch', 'confirm-draft']) {
      expect(residentPanelIds()).not.toContain(id);
      expect(isResidentPanel(id)).toBe(false);
      expect(panelPlacement(id)).toBe('drawer');
    }
    // The task cards and their node summary never appear in the chat stream.
    expect(panelPlacement('conversation-task-abc')).toBeNull();
    expect(residentPanelIds().some(id => id.startsWith('conversation-task'))).toBe(false);
    expect(residentPanelIds()).not.toContain('node-summary-list');
  });
});

describe('drawer panel policy', () => {
  test('draft versions, the two draft pages and the task navigation all live in the drawer', () => {
    for (const id of ['draft-versions', 'graph', 'artifacts', 'task-nav', 'task']) {
      expect(drawerPanelIds()).toContain(id);
      expect(isDrawerPanel(id)).toBe(true);
      expect(panelPlacement(id)).toBe('drawer');
    }
    expect(DRAWER_ENTRY_LINKS.map(entry => entry.id)).toEqual(['graph', 'artifacts']);
    expect(drawerEntryIds()).toContain('artifacts');
    // Acceptance items, node lists and decisions are deliberately not drawer pages any more.
    for (const gone of ['acceptance', 'nodes', 'decisions']) expect(drawerEntryIds()).not.toContain(gone);
  });

  test('the empty task state and the project binding are drawer initialization panels', () => {
    expect(DRAWER_INIT_PANEL_IDS).toEqual(['task-empty', 'bind-project']);
    expect(drawerInitPanelIds()).toEqual(['task-empty', 'bind-project']);
    for (const id of ['task-empty', 'bind-project']) {
      expect(drawerPanelIds()).toContain(id);
      expect(isDrawerPanel(id)).toBe(true);
      expect(isResidentPanel(id)).toBe(false);
      expect(panelPlacement(id)).toBe('drawer');
    }
  });

  test('every declared panel is either main-resident or drawer, with no third home', () => {
    const declared = [...residentPanelIds(), ...drawerPanelIds(), ...DRAWER_PANEL_IDS];
    for (const id of declared) {
      const placement = panelPlacement(id);
      expect(placement === 'main' || placement === 'drawer').toBe(true);
    }
    // Anything not declared has no placement and therefore cannot be rendered
    // in the chat stream as a policy-backed block.
    expect(panelPlacement('no-conversation-tasks')).toBeNull();
    expect(panelPlacement('some-ad-hoc-card')).toBeNull();
  });

  test('main and drawer panels are disjoint and unknown ids have no placement', () => {
    const main = new Set(residentPanelIds());
    for (const id of drawerPanelIds()) expect(main.has(id)).toBe(false);
    expect(panelPlacement('not-a-panel')).toBeNull();
    expect(isResidentPanel('graph')).toBe(false);
    expect(isDrawerPanel('conversation-questions')).toBe(false);
  });
});

describe('drawer section resolution (the task navigation must stay open)', () => {
  test('clicking the task navigation stays on task even when a proposal exists', () => {
    expect(resolveDrawerSection({ current: 'task', selectedTaskId: 't1', taskIds: ['t1', 't2'], hasProposal: true }))
      .toEqual({ section: 'task', taskId: 't1' });
  });

  test('a proposal never forces the still-loading task list back to the draft page', () => {
    expect(resolveDrawerSection({ current: 'task', selectedTaskId: null, taskIds: [], hasProposal: true }))
      .toEqual({ section: 'task', taskId: null });
  });

  test('a disappeared selected task keeps the task navigation and adopts the next task', () => {
    // Never yank the user out of the section they picked: the empty note lives in the task
    // section, and a stale selection is replaced rather than used as a reason to go back.
    expect(resolveDrawerSection({ current: 'task', selectedTaskId: 'gone', taskIds: [], hasProposal: true }))
      .toEqual({ section: 'task', taskId: null });
    expect(resolveDrawerSection({ current: 'task', selectedTaskId: 'gone', taskIds: ['t2'], hasProposal: false }))
      .toEqual({ section: 'task', taskId: 't2' });
  });

  test('the task navigation stays reachable while it is still empty', () => {
    // The "no tasks yet" note is rendered inside the task section, so the policy must not send
    // the user back to the draft page just because no task exists yet and no proposal is there.
    expect(resolveDrawerSection({ current: 'task', selectedTaskId: null, taskIds: [], hasProposal: false }))
      .toEqual({ section: 'task', taskId: null });
    for (const hasProposal of [true, false]) {
      for (const taskIds of [[], ['t1']]) {
        expect(resolveDrawerSection({ current: 'task', selectedTaskId: null, taskIds, hasProposal }).section).toBe('task');
        expect(resolveDrawerSection({ current: 'draft', selectedTaskId: 't1', taskIds, hasProposal }).section).toBe('draft');
      }
    }
  });

  test('with tasks but no selection, task is shown and the first task is selected', () => {
    expect(resolveDrawerSection({ current: 'task', selectedTaskId: null, taskIds: ['t1', 't2'], hasProposal: true }))
      .toEqual({ section: 'task', taskId: 't1' });
  });

  test('opening the task navigation with no tasks keeps it open', () => {
    // The "no tasks yet" note is rendered inside the task section, so the section must stay put
    // even with zero tasks and no proposal; only the component's initial state is the draft page.
    expect(resolveDrawerSection({ current: 'task', selectedTaskId: null, taskIds: [], hasProposal: false }))
      .toEqual({ section: 'task', taskId: null });
    expect(resolveDrawerSection({ current: 'draft', selectedTaskId: null, taskIds: [], hasProposal: false }))
      .toEqual({ section: 'draft', taskId: null });
  });

  test('the draft page stays put and is never yanked away', () => {
    expect(resolveDrawerSection({ current: 'draft', selectedTaskId: 't1', taskIds: ['t1'], hasProposal: true }))
      .toEqual({ section: 'draft', taskId: 't1' });
  });
});

describe('drawer entry label', () => {
  test('carries the draft version, the draft status and the task count', () => {
    expect(draftStatusLabel('pending')).toBe('待确认');
    expect(draftStatusLabel('accepted')).toBe('已确认');
    expect(draftStatusLabel('stale')).toBe('已过期');
    expect(draftStatusLabel('none')).toBe('暂无草稿');

    const pending = drawerEntryLabel({ proposalVersion: 12, draftStatus: 'pending', taskCount: 9, projectBound: true });
    expect(pending).toContain('草稿 v12');
    expect(pending).toContain('待确认');
    expect(pending).toContain('任务 9');
    expect(pending).not.toContain('未绑定项目');

    const accepted = drawerEntryLabel({ proposalVersion: 3, draftStatus: 'accepted', taskCount: 1, projectBound: true });
    expect(accepted).toContain('草稿 v3');
    expect(accepted).toContain('已确认');
    expect(accepted).toContain('任务 1');

    const empty = drawerEntryLabel({ proposalVersion: null, draftStatus: 'none', taskCount: 0, projectBound: true });
    expect(empty).toContain('暂无草稿');
    expect(empty).toContain('任务 0');
  });

  test('also states that no project is bound, alongside the draft state and task count', () => {
    const unbound = drawerEntryLabel({ proposalVersion: 2, draftStatus: 'pending', taskCount: 0, projectBound: false });
    expect(unbound).toContain('草稿 v2');
    expect(unbound).toContain('待确认');
    expect(unbound).toContain('未绑定项目');
    expect(unbound).toContain('任务 0');
  });
});

describe('components genuinely use the policy module', () => {
  test('Conversation.tsx wires the drawer policy instead of hardcoding it', () => {
    const source = read('src/web/Conversation.tsx');
    expect(source).toContain("from './conversation-drawer.ts'");
    expect(source).toContain('drawerOpen = defaultDrawerOpen()');
    expect(source).toContain('DRAWER_ENTRY_LINKS.map');
    expect(source).toContain('residentPanelIds().join');
    expect(source).toContain('drawerPanelIds().join');
    expect(source).toContain('aria-label={drawerEntryAriaLabel(entryState)}');
    expect(source).toContain('data-testid="drawer-entry-label"');
    expect(source).toContain('drawerInitPanelIds()');
    expect(source).toContain('resolveDrawerSection({');
    expect(source).toContain('data-testid="drawer-entry"');
    // The questions keep their resident marker; the draft card no longer does.
    expect(source).toContain("data-resident={residentFlag('conversation-questions')}");
    expect(source).toContain('className="conversation-question-region"');
  });

  test('the drawer renders the draft pages plus the task graph, keeping their testids', () => {
    const source = read('src/web/Conversation.tsx');
    expect(source).toContain('data-testid="drawer-mode-tabs"');
    expect(source).toContain('data-testid="drawer-draft-toc"');
    // The drawer names the windows; the graph and the artifacts render as tabs of their own.
    expect(source).toContain('DRAWER_ENTRY_LINKS.map');
    expect(source).toContain('data-testid="drawer-entry-links"');
    expect(source).toContain('data-testid={`drawer-entry-${entry.id}`}');
    expect(source).toContain('data-testid="drawer-task-nav"');
    // The drawers no longer list anything themselves: the shared-artifact index is its own window.
    expect(read('src/web/ArtifactIndex.tsx')).toContain('data-testid="artifact-index"');
    // The two groups, and the label that says the project's own artifacts belong to no task,
    // live with the list both windows share.
    expect(read('src/web/ArtifactViews.tsx')).toContain('data-testid="drawer-artifacts"');
    expect(read('src/web/ArtifactViews.tsx')).toContain('不属于任何任务');
  });

  test('the draft card, the confirm controls and the task cards moved into the drawer', () => {
    const source = read('src/web/Conversation.tsx');
    expect(source).toContain('data-testid="proposal-draft"');
    expect(source).toContain('data-testid="accept-branch"');
    expect(source).toContain('data-testid="confirm-draft"');
    expect(source).toContain('data-testid={`conversation-task-${task.id}`}');
    expect(source).toContain('data-testid={`conversation-questions-${task.id}`}');
  });

  test('the empty task state and the project binding live in the drawer, keeping their testids', () => {
    const source = read('src/web/Conversation.tsx');
    expect(source).toContain('data-testid="bind-project"');
    expect(source).toContain('data-testid="bind-select"');
    expect(source).toContain('data-testid="bind-submit"');
    expect(source).toContain('data-testid="no-conversation-tasks"');
  });

  test('the chat thread itself no longer renders the draft card or the task cards', () => {
    const source = read('src/web/Conversation.tsx');
    const thread = source.split('conversation-thread-inner')[1]?.split('conversation-runway')[0] ?? '';
    expect(thread).not.toContain('data-testid="proposal-draft"');
    expect(thread).not.toContain('conversation-task-');
    expect(thread).not.toContain('node-summary-list');
    expect(thread).not.toContain('accept-branch');
    expect(thread).not.toContain('confirm-draft');
    // The empty task state and the project binding moved out of the chat stream.
    expect(thread).not.toContain('no-conversation-tasks');
    expect(thread).not.toContain('bind-project');
    // ...but the pending questions do stay in the chat stream.
    expect(thread).toContain('data-testid="conversation-questions"');
    expect(thread).toContain('data-testid={`conversation-questions-${task.id}`}');
  });
});

describe('what the drawer keeps quiet', () => {
  test('finished work is tucked away, a decision or a running task stays in the list', () => {
    const tasks = [
      { id: 'a', status: 'running' },
      { id: 'b', status: 'completed' },
      { id: 'c', status: 'blocked' },
      { id: 'd', status: 'abandoned' },
      { id: 'e', status: 'failed' },
    ];
    const { active, ended } = splitTasksByLifecycle(tasks);
    expect(active.map(task => task.id)).toEqual(['a', 'c']);
    expect(ended.map(task => task.id)).toEqual(['b', 'd', 'e']);
    expect(isEndedTask('running')).toBe(false);
    expect(isEndedTask('abandoned')).toBe(true);
  });

  test('a shared artifact belongs to the project group, not to the task that produced it', () => {
    const records = [
      { artifactId: 'one', scope: 'task' },
      { artifactId: 'two', scope: 'project' },
      { artifactId: 'three', scope: 'task' },
    ];
    const groups = groupArtifacts(records);
    expect(groups.own.map(record => record.artifactId)).toEqual(['one', 'three']);
    expect(groups.project.map(record => record.artifactId)).toEqual(['two']);
  });
});
