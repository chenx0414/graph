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
