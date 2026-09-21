import type { ModelEntry } from '../catalog/models.ts';

/** Compaction thresholds derived from the model that will receive the request.
 * A window only a few hundred tokens wide still gets a usable reserve: the
 * fixed 1024-token floor is capped at half the window so the trigger point
 * never goes negative, which would compact before the first turn. */
export function compactionSettings(entry: Pick<ModelEntry, 'contextWindow' | 'maxTokens'>) {
  const contextWindow = Math.max(1, Math.floor(entry.contextWindow));
  const maxTokens = Math.max(1, Math.floor(entry.maxTokens));
  const reserveTokens = Math.min(16_384, Math.max(maxTokens, 1_024), Math.max(256, Math.floor(contextWindow / 2)));
  const keepRecentTokens = Math.min(20_000, Math.max(1_024, Math.floor(contextWindow / 4)));
  return { enabled: true, reserveTokens, keepRecentTokens };
}

/**
 * Instructions for Graph-triggered compaction.
 *
 * Pi's built-in update prompt tells the summarizer to preserve every previous
 * detail. That makes the summary grow with each compaction until it no longer
 * fits the model's output budget; Pi then rejects the truncated summary and
 * every later compaction fails, so a conversation past the window can never
 * recover. Ask for a bounded handoff instead so the summary stays small.
 */
export const COMPACTION_INSTRUCTIONS = [
  'This summary is a working handoff for the next turn, not a transcript.',
  'Keep the entire summary under roughly 1500 tokens.',
  'Drop resolved detail, superseded attempts and stale plans instead of preserving them.',
  'Keep only what is needed to continue: the goal, the current state, open blockers, key decisions, exact file paths and the next steps.',
].join(' ');

/** The recorded context no longer fits the window once its reserve is set aside. */
export function shouldCompactContext(
  entry: Pick<ModelEntry, 'contextWindow' | 'maxTokens'>,
  contextTokens: number | null,
) {
  if (contextTokens === null || !Number.isFinite(contextTokens)) return false;
  const { reserveTokens } = compactionSettings(entry);
  return contextTokens > Math.max(1, Math.floor(entry.contextWindow) - reserveTokens);
}
