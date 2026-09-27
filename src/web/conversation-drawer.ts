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

/**
 * Drawer pages. Exactly two of them: the task graph and the shared artifacts.
 * Acceptance items, node lists and decisions are deliberately not here.
 */
export type ConversationDrawerPage = 'graph' | 'artifacts' | 'task';

/** The drawer's two top-level sections: the draft details and the task list. */
export type ConversationDrawerSection = 'draft' | 'task';

export interface DrawerSectionInput {
  /** The section the user is currently looking at. */
  current: ConversationDrawerSection;
  /** The task the user (or a previous resolve) selected, if any. */
  selectedTaskId: string | null;
  /** Every task id that currently exists, in display order. */
  taskIds: readonly string[];
  /** Whether the conversation already has a proposal / draft. */
  hasProposal: boolean;
}

export interface DrawerSectionResolution {
  section: ConversationDrawerSection;
  taskId: string | null;
}

/**
 * Sticky drawer-section resolution. The user's choice wins: once the task
 * navigation is open it stays open even while a proposal exists or the task
 * list is still loading. It only falls back to the draft page when the chosen
 * task has disappeared, or when there is nothing to select and no proposal to
 * show. A proposal must never force the task section back to the draft page —
 * that was the bug that made the task navigation unclickable.
 */
export function resolveDrawerSection(input: DrawerSectionInput): DrawerSectionResolution {
  const { current, selectedTaskId, taskIds } = input;
  // The user's own choice always wins. Both sections are legitimate: the draft page is never
  // yanked away, and the task navigation stays reachable even while it is still empty — the
  // "no tasks yet" note lives there, so sending the user back to the draft page would make that
  // note unreachable. `hasProposal` deliberately no longer overrides either choice.
  if (current === 'draft') return { section: 'draft', taskId: selectedTaskId };
  // Task navigation: keep the chosen task while it still exists, otherwise adopt the first one;
  // with no tasks at all the section stays put and renders its empty note.
  const stillThere = selectedTaskId !== null && taskIds.includes(selectedTaskId);
  return { section: 'task', taskId: stillThere ? selectedTaskId : (taskIds[0] ?? null) };
}

/** Draft-detail pages that appear as tabs inside the drawer. */
export interface DrawerPanelDescriptor {
  id: Exclude<ConversationDrawerPage, 'task'>;
  label: string;
  /** Which testid family the panel keeps, useful for locating it in tests. */
  panel: 'task-graph' | 'artifact-list';
}

/** Draft-detail pages hosted by the drawer, in tab order. The graph is first: it is the default. */
export const DRAWER_DRAFT_PAGES: readonly DrawerPanelDescriptor[] = [
  { id: 'graph', label: '任务图', panel: 'task-graph' },
  { id: 'artifacts', label: '共享产物', panel: 'artifact-list' },
];

/**
 * Tasks the drawer keeps in view: the ones still waiting for a decision or still
 * running. Finished work (completed, failed, abandoned, skipped) is tucked away
 * under its own disclosure instead of crowding the list.
 */
const ENDED_TASK_STATUS = ['completed', 'failed', 'abandoned', 'skipped'];

export function isEndedTask(status: string): boolean {
  return ENDED_TASK_STATUS.includes(status);
}

export function splitTasksByLifecycle<T extends { status: string }>(tasks: readonly T[]): { active: T[]; ended: T[] } {
  return {
    active: tasks.filter(task => !isEndedTask(task.status)),
    ended: tasks.filter(task => isEndedTask(task.status)),
  };
}

/**
 * Shared artifacts read in two groups: what this task produced, and what belongs
 * to the project itself (`scope: 'project'` - promoted knowledge such as the
 * harness backlog, which no single task owns).
 */
export function groupArtifacts<T extends { scope: string }>(records: readonly T[]): { own: T[]; project: T[] } {
  return {
    own: records.filter(record => record.scope !== 'project'),
    project: records.filter(record => record.scope === 'project'),
  };
}

/** Everything the drawer hosts: the draft versions, the draft pages, the task
 * navigation list with its empty state, one selected task's execution detail
 * and the project-binding initialization panel. Everything here is reached by
 * the drawer; none of it may be rendered unconditionally in the chat stream. */
export const DRAWER_PANEL_IDS = [
  'draft-versions',
  'graph',
  'artifacts',
  'task-nav',
  'task',
  'task-empty',
  'bind-project',
] as const;

/** Drawer panels that are neither a draft page nor a task detail but the
 * initialization state shown before anything exists. */
export const DRAWER_INIT_PANEL_IDS = [
  'task-empty',
  'bind-project',
] as const;

/**
 * Entries that keep their legacy testids but now live *inside* the drawer:
 * the draft card, its compact graph/acceptance entry points and the
 * confirm-draft / target-branch controls.
 */
export const DRAWER_ENTRY_PANEL_IDS = [
  'proposal-draft',
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

export function defaultDrawerPage(): Exclude<ConversationDrawerPage, 'task'> {
  return 'graph';
}

export function drawerPanelIds(): readonly string[] {
  return DRAWER_PANEL_IDS;
}

export function drawerEntryPanelIds(): readonly string[] {
  return DRAWER_ENTRY_PANEL_IDS;
}

/** The drawer's initialization panels: the task-list empty state and the
 * project-binding panel, both shown before a task exists. */
export function drawerInitPanelIds(): readonly string[] {
  return DRAWER_INIT_PANEL_IDS;
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
  /** When false the entry also states that no project is bound yet. */
  projectBound: boolean;
}

/**
 * The header entry text. It always carries the draft version + status and the
 * task count — and, while no project is bound, that too — so the collapsed
 * drawer still tells the user what waits inside.
 */
export function drawerEntryLabel(state: DrawerEntryState): string {
  const draft = state.proposalVersion === null || state.draftStatus === 'none'
    ? '暂无草稿'
    : `草稿 v${state.proposalVersion} · ${draftStatusLabel(state.draftStatus)}`;
  const parts = [draft];
  if (!state.projectBound) parts.push('未绑定项目');
  parts.push(`任务 ${state.taskCount}`);
  return parts.join(' · ');
}

export function drawerEntryAriaLabel(state: DrawerEntryState): string {
  return `${drawerEntryLabel(state)}，打开草稿与任务抽屉`;
}
