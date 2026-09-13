/** Decide whether a stream frame advances the task cursor. Duplicate or
 * out-of-order deliveries return null so callers never apply an old state. */
export function nextEventCursor(lastCursor: number, raw: unknown): { cursor: number; type: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as { cursor?: unknown; type?: unknown };
  if (typeof event.cursor !== 'number' || !Number.isSafeInteger(event.cursor) || typeof event.type !== 'string') return null;
  if (event.cursor <= lastCursor) return null;
  return { cursor: event.cursor, type: event.type };
}
