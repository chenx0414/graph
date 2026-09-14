/** Decide whether a stream frame advances the task cursor. Duplicate or
 * out-of-order deliveries return null so callers never apply an old state.
 * The payload is preserved so stream consumers can apply incremental updates
 * (assistant deltas and tool activity) before refetching the record. */
export function nextEventCursor(lastCursor: number, raw: unknown): { cursor: number; type: string; data?: unknown; timestamp?: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as { cursor?: unknown; type?: unknown; data?: unknown; timestamp?: unknown };
  if (typeof event.cursor !== 'number' || !Number.isSafeInteger(event.cursor) || typeof event.type !== 'string') return null;
  if (event.cursor <= lastCursor) return null;
  return {
    cursor: event.cursor,
    type: event.type,
    ...(event.data === undefined ? {} : { data: event.data }),
    ...(typeof event.timestamp === 'number' ? { timestamp: event.timestamp } : {}),
  };
}
