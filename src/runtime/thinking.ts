/**
 * What one configured model actually accepts for thinking strength.
 *
 * The per-model subset comes from the catalog (`thinkingLevelMapFor`), and the
 * final answer is the SDK's own judgement applied to the very same model object
 * the transport uses, so the console, the stored level and the wire value cannot
 * drift apart.
 */
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { ModelEntry, ModelThinkingLevel, ModelThinkingOption } from '../catalog/models.ts';
import { modelMetadataFor } from '../catalog/thinking.ts';
import { toPiModel } from './pi-adapter.ts';

/** Thinking strengths this model accepts, in Pi's canonical order. Empty for a
 * model that cannot think at all. */
export function thinkingOptionsFor(entry: ModelEntry): ModelThinkingOption[] {
  if (entry.reasoning === false) return [];
  const labels = new Map((modelMetadataFor(entry)?.thinkingOptions ?? []).map(option => [option.level, option.label]));
  return getSupportedThinkingLevels(toPiModel(entry)).map(level => ({
    level,
    // The label is the provider's own spelling of this level, and only that:
    // when the snapshot names none, the level name itself stands in and the
    // console renders its own label instead of inventing a second name.
    label: labels.get(level) ?? level,
  }));
}

/** The level a model will actually run at: a level this model does not accept
 * falls back the way the SDK falls back (nearest stronger, then nearest
 * weaker), and a model that cannot think always runs with thinking off. */
export function effectiveThinkingLevel(entry: ModelEntry, requested?: string): ModelThinkingLevel {
  if (entry.reasoning === false) return 'off';
  const wanted = (requested ?? entry.defaultThinkingLevel) as ModelThinkingLevel | undefined;
  return clampThinkingLevel(toPiModel(entry), wanted ?? 'off');
}
