/**
 * One rule for "the reader scrolled to the top of a transcript": both the
 * conversation page and the node chat page used to carry their own copy of this
 * predicate, and the two copies drifted (only one of them kept the reader's
 * place when a page landed). The transcript itself is shared through
 * `TranscriptRowView`; this module is the other half - the scroll shell.
 */

/** Where the thread stood before an older page was merged above it. */
export type HistoryAnchor = { top: number; height: number };

/** How close to the top counts as "asking for the previous page", in pixels. */
export const olderHistoryThreshold = 160;

/**
 * Whether this scroll position should request the next older page. A thread the
 * reader has pinned back to the latest message is followed automatically and must
 * not page backwards underneath them.
 */
export function wantsOlderHistory(thread: HTMLElement | null, options: { pinned: boolean; hasOlder: boolean }): boolean {
  if (!thread || options.pinned || !options.hasOlder) return false;
  return thread.scrollTop < olderHistoryThreshold;
}

/** Remember the scroll position before older entries are prepended. */
export function captureHistoryAnchor(thread: HTMLElement | null): HistoryAnchor | null {
  return thread ? { top: thread.scrollTop, height: thread.scrollHeight } : null;
}

/** Put the reader back where they were, counting the height the new page added. */
export function restoreHistoryAnchor(thread: HTMLElement | null, anchor: HistoryAnchor | null): HistoryAnchor | null {
  if (!anchor || !thread) return null;
  thread.scrollTop = anchor.top + thread.scrollHeight - anchor.height;
  return null;
}
