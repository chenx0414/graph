
export type HistoryAnchor = { top: number; height: number };

export const olderHistoryThreshold = 160;

export function wantsOlderHistory(thread: HTMLElement | null, options: { pinned: boolean; hasOlder: boolean }): boolean {
  if (!thread || options.pinned || !options.hasOlder) return false;
  return thread.scrollTop < olderHistoryThreshold;
}

export function captureHistoryAnchor(thread: HTMLElement | null): HistoryAnchor | null {
  return thread ? { top: thread.scrollTop, height: thread.scrollHeight } : null;
}

export function restoreHistoryAnchor(thread: HTMLElement | null, anchor: HistoryAnchor | null): HistoryAnchor | null {
  if (!anchor || !thread) return null;
  thread.scrollTop = anchor.top + thread.scrollHeight - anchor.height;
  return null;
}
