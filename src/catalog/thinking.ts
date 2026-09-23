/**
 * Per-model thinking strengths, derived from the vendored models.dev snapshot.
 *
 * Graph stores and sends Pi's own level vocabulary (`ModelThinkingLevel`); a
 * model may accept only a subset of it and may name those levels differently.
 * Two rules keep the console honest:
 *
 * - a level the snapshot does not list for this model is denied (`null`), so no
 *   control ever offers a strength the model cannot take;
 * - the catalog decides availability, never the configuration: a saved default
 *   the model does not accept is not offered and is clamped instead (the
 *   console says so where it happens).
 *
 * The result is exactly the shape `Model.thinkingLevelMap` takes, so the SDK's
 * own `getSupportedThinkingLevels` / `clampThinkingLevel` stay the single
 * authority for what is offered and for where a stale level falls back to.
 */
import { MODEL_THINKING_LEVELS, type ModelEntry, type ModelThinkingLevel } from './models.ts';
import { lookupModelMetadata, type ModelMetadata } from './models-dev.ts';

/** Levels the SDK refuses to invent: it accepts xhigh/max only through an
 * explicit mapping, so a model that does not name them does not offer them. */
const MAPPED_ONLY: readonly ModelThinkingLevel[] = ['xhigh', 'max'];

/** Shape of `Model.thinkingLevelMap`: `null` denies a level, a string is the
 * value the provider expects, and an absent key keeps the SDK default. */
export type ThinkingLevelMapView = Partial<Record<ModelThinkingLevel, string | null>>;

export function modelMetadataFor(entry: Pick<ModelEntry, 'provider' | 'id' | 'modelId'>): ModelMetadata | null {
  return lookupModelMetadata(entry.provider, entry.modelId ?? entry.id);
}

export function thinkingLevelMapFor(entry: ModelEntry, metadata?: ModelMetadata | null): ThinkingLevelMapView | undefined {
  if (entry.reasoning === false) return undefined;
  const options = (metadata === undefined ? modelMetadataFor(entry) : metadata)?.thinkingOptions ?? [];
  const listed = new Map(options.map(option => [option.level, option.label]));
  const map: ThinkingLevelMapView = {};
  for (const level of MODEL_THINKING_LEVELS) {
    // `off` never travels as an effort value: the Agent loop sends no reasoning
    // option at all for it, so it stays available without a mapping.
    if (level === 'off') continue;
    const label = listed.get(level);
    if (label !== undefined) {
      map[level] = label;
      continue;
    }
    // The snapshot names no discrete effort for this model (only a toggle or a
    // token budget): keep Pi's own default levels, and deny the two levels the
    // SDK will not invent on its own.
    map[level] = listed.size === 0 && !MAPPED_ONLY.includes(level) ? level : null;
  }
  return map;
}
