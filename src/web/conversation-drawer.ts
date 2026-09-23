/**
 * Pure layout policy for the conversation's right-hand drawer. No React and no
 * IO: `Conversation.tsx` derives its page tabs, its resident (always-visible)
 * entries and the drawer's default state from here, so the policy can be tested
 * in the sandbox without a browser.
 *
 * The batch-C rule is simple: the draft details and the task-graph overview
 * live in the drawer and start collapsed, while the confirm / target-branch /
 * acceptance entry points and any pending questions stay pinned to the main
 * column.
 */

/** Drawer pages. Draft-detail pages plus the full task graph and execution detail. */
export type ConversationDrawerPage = 'acceptance' | 'nodes' | 'decisions' | 'graph' | 'task';

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

/** Everything the drawer can show: draft versions plus the draft pages plus execution detail. */
export const DRAWER_PANEL_IDS = [
  'draft-versions',
  'acceptance',
  'nodes',
  'decisions',
  'graph',
  'task',
] as const;

/**
 * Entries that must stay visible in the main column even while the drawer is
 * collapsed. `conversation-questions` is a prefix: per-task question lists use
 * `conversation-questions-<taskId>`.
 */
export const RESIDENT_PANEL_IDS = [
  'proposal-draft',
  'draft-acceptance',
  'draft-graph',
  'accept-branch',
  'confirm-draft',
  'conversation-questions',
] as const;

export type ResidentPanelId = (typeof RESIDENT_PANEL_IDS)[number];

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

export function residentPanelIds(): readonly string[] {
  return RESIDENT_PANEL_IDS;
}

export function drawerPageIds(): string[] {
  return DRAWER_DRAFT_PAGES.map(page => page.id);
}

export function isResidentPanel(id: string): boolean {
  return (RESIDENT_PANEL_IDS as readonly string[]).includes(id);
}

export function isDrawerPanel(id: string): boolean {
  return (DRAWER_PANEL_IDS as readonly string[]).includes(id);
}

/** Where a known panel lives; `null` when the id is not part of the policy. */
export function panelPlacement(id: string): 'main' | 'drawer' | null {
  if (isResidentPanel(id)) return 'main';
  if (isDrawerPanel(id)) return 'drawer';
  return null;
}
