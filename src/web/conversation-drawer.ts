/**
 * Pure layout policy for the conversation's right-hand drawer. No React and no
 * IO: `Conversation.tsx` derives its page tabs, its chat-stream resident
 * entries, the drawer's default state and the prominent entry label from here,
 * so the policy can be tested in the sandbox without a browser.
 *
 * The batch-C containment rule: the chat column only keeps the conversation
 * transcript, the pending questions and the composer. Every draft card and
 * every task / node overview moves into the right drawer, which starts
 * collapsed and is reached through a labelled, stateful entry in the header.
 * This module is the single source of truth for that split — the view must not
 * hardcode its own copy.
 */

/** Drawer pages. Draft-detail pages plus the full task graph and task detail. */
export type ConversationDrawerPage = 'acceptance' | 'nodes' | 'decisions' | 'graph' | 'task';

/** The drawer's two top-level sections: the draft details and the task list. */
export type ConversationDrawerSection = 'draft' | 'task';

/** Draft-detail pages that appear as tabs inside the drawer. */
export interface DrawerPanelDescriptor {
  id: Exclude<ConversationDrawerPage, 'task'>;
  label: string;
  /** Which testid family the panel keeps, useful for locating it in tests. */
  panel: 'draft-detail' | 'task-graph';
}

/** Draft-detail pages hosted by the drawer, in tab order. */
export const DRAWER_DRAFT_PAGES: readonly DrawerPanelDescriptor[] = [
  { id: 'acceptance', label: '验收项', panel: 'draft-detail' },
  { id: 'nodes', label: '节点', panel: 'draft-detail' },
  { id: 'decisions', label: '决策与约束', panel: 'draft-detail' },
  { id: 'graph', label: '任务图', panel: 'task-graph' },
];

/** Everything the drawer hosts: the draft versions, the draft pages, the task
 * navigation list and one selected task's execution detail. */
export const DRAWER_PANEL_IDS = [
  'draft-versions',
  'acceptance',
  'nodes',
  'decisions',
  'graph',
  'task-nav',
  'task',
] as const;

/**
 * Entries that keep their legacy testids but now live *inside* the drawer:
 * the draft card, its compact graph/acceptance entry points and the
 * confirm-draft / target-branch controls.
 */
export const DRAWER_ENTRY_PANEL_IDS = [
  'proposal-draft',
  'draft-acceptance',
  'draft-graph',
  'accept-branch',
  'confirm-draft',
] as const;

/**
 * The only blocks allowed to stay in the chat stream even while the drawer is
 * collapsed: the transcript, the pending questions, and the input area.
 * `conversation-questions` is a prefix: per-task question lists use
 * `conversation-questions-<taskId>`.
 */
export const CHAT_RESIDENT_PANEL_IDS = [
  'conversation-messages',
  'conversation-questions',
  'conversation-composer',
] as const;

export type ChatResidentPanelId = (typeof CHAT_RESIDENT_PANEL_IDS)[number];

/** Backwards-compatible alias for the chat-stream resident set. */
export const RESIDENT_PANEL_IDS = CHAT_RESIDENT_PANEL_IDS;

export type ResidentPanelId = ChatResidentPanelId;

/** How a draft reads in the header entry and the drawer. */
export type DraftStatus = 'none' | 'pending' | 'accepted' | 'stale';

/** The drawer starts collapsed; the user opens it on demand. */
export function defaultDrawerOpen(): boolean {
  return false;
}

export function defaultDrawerPage(): ConversationDrawerPage {
  return 'acceptance';
}

export function drawerPanelIds(): readonly string[] {
  return DRAWER_PANEL_IDS;
}

export function drawerEntryPanelIds(): readonly string[] {
  return DRAWER_ENTRY_PANEL_IDS;
}

/** Panel ids that stay in the chat column. */
export function residentPanelIds(): readonly string[] {
  return CHAT_RESIDENT_PANEL_IDS;
}

export function drawerPageIds(): string[] {
  return DRAWER_DRAFT_PAGES.map(page => page.id);
}

export function isResidentPanel(id: string): boolean {
  return (CHAT_RESIDENT_PANEL_IDS as readonly string[]).includes(id);
}

export function isDrawerPanel(id: string): boolean {
  return (DRAWER_PANEL_IDS as readonly string[]).includes(id)
    || (DRAWER_ENTRY_PANEL_IDS as readonly string[]).includes(id);
}

/** Where a known panel lives; `null` when the id is not part of the policy. */
export function panelPlacement(id: string): 'main' | 'drawer' | null {
  if (isResidentPanel(id)) return 'main';
  if (isDrawerPanel(id)) return 'drawer';
  return null;
}

export function draftStatusLabel(status: DraftStatus): string {
  switch (status) {
    case 'pending': return '待确认';
    case 'accepted': return '已确认';
    case 'stale': return '已过期';
    default: return '暂无草稿';
  }
}

export interface DrawerEntryState {
  proposalVersion: number | null;
  draftStatus: DraftStatus;
  taskCount: number;
}

/**
 * The header entry text. It always carries the draft version + status and the
 * task count, so the collapsed drawer still tells the user what waits inside.
 */
export function drawerEntryLabel(state: DrawerEntryState): string {
  const draft = state.proposalVersion === null || state.draftStatus === 'none'
    ? '暂无草稿'
    : `草稿 v${state.proposalVersion} · ${draftStatusLabel(state.draftStatus)}`;
  return `${draft} · 任务 ${state.taskCount}`;
}

export function drawerEntryAriaLabel(state: DrawerEntryState): string {
  return `${drawerEntryLabel(state)}，打开草稿与任务抽屉`;
}
