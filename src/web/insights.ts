/** Console token formatting and graph status presentation. */

export type NodeTone = 'pending' | 'active' | 'success' | 'error' | 'blocked';

export function nodeTone(status: string): NodeTone {
  switch (status) {
    case 'preparing':
    case 'running':
    case 'ready':
      return 'active';
    case 'succeeded':
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'blocked':
    case 'skipped':
      return 'blocked';
    default:
      return 'pending';
  }
}

export const NODE_TONE_COLOR: Record<NodeTone, string> = {
  pending: '#94a3b8',
  active: '#2563eb',
  success: '#16a34a',
  error: '#dc2626',
  blocked: '#d97706',
};

/**
 * The task board groups every node status into four stable states so the
 * canvas can colour, icon and count them the same way everywhere. `nodeTone`
 * above stays the five-step presentation tone used by older views.
 */
export type BoardNodeState = 'pending' | 'running' | 'done' | 'blocked';

export interface BoardStateMeta {
  id: BoardNodeState;
  label: string;
  icon: string;
  color: string;
}

/** Status -> board state. Unknown statuses fall through to `pending`. */
const BOARD_STATE_BY_STATUS: Record<string, BoardNodeState> = {
  pending: 'pending',
  draft: 'pending',
  preparing: 'running',
  running: 'running',
  ready: 'running',
  succeeded: 'done',
  completed: 'done',
  skipped: 'done',
  blocked: 'blocked',
  failed: 'blocked',
};

/** Always exported in this order so the legend is stable. */
export const BOARD_STATE_ORDER: readonly BoardNodeState[] = ['pending', 'running', 'done', 'blocked'];

export const BOARD_STATE_META: Record<BoardNodeState, BoardStateMeta> = {
  pending: { id: 'pending', label: '待执行', icon: '○', color: '#94a3b8' },
  running: { id: 'running', label: '运行中', icon: '◐', color: '#2563eb' },
  done: { id: 'done', label: '已完成', icon: '✓', color: '#16a34a' },
  blocked: { id: 'blocked', label: '被阻塞', icon: '⛔', color: '#d97706' },
};

/** `pending` for unknown statuses, so an unrecognised value never disappears. */
export function boardNodeState(status: string): BoardNodeState {
  return BOARD_STATE_BY_STATUS[status] ?? 'pending';
}

/** True when the status is one the board knows how to place. */
export function boardStateKnown(status: string): boolean {
  return Object.prototype.hasOwnProperty.call(BOARD_STATE_BY_STATUS, status);
}

/** Human label for a status; unknown values are explicitly marked 未知. */
export function boardStateLabel(status: string): string {
  const label = BOARD_STATE_META[boardNodeState(status)].label;
  return boardStateKnown(status) ? label : `${label}（未知）`;
}

export function boardStateIcon(status: string): string {
  return BOARD_STATE_META[boardNodeState(status)].icon;
}

export function boardStateColor(status: string): string {
  return BOARD_STATE_META[boardNodeState(status)].color;
}

export interface BoardStateCount extends BoardStateMeta {
  count: number;
}

/** One entry per state (always four, in legend order) with the node count. */
export function boardStateCounts(statuses: readonly string[]): BoardStateCount[] {
  const counts: Record<BoardNodeState, number> = { pending: 0, running: 0, done: 0, blocked: 0 };
  for (const status of statuses) counts[boardNodeState(status)] += 1;
  return BOARD_STATE_ORDER.map(state => ({ ...BOARD_STATE_META[state], count: counts[state] }));
}

/** How many of the given statuses the board had to fold into 待执行 as 未知. */
export function boardUnknownCount(statuses: readonly string[]): number {
  return statuses.reduce((sum, status) => sum + (boardStateKnown(status) ? 0 : 1), 0);
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未知';
  return value.toLocaleString('en-US');
}

export function openQuestionTotal(tasks: { openQuestions?: number }[]): number {
  return tasks.reduce((sum, task) => sum + (task.openQuestions ?? 0), 0);
}
