import { describe, expect, test } from 'vitest';
import { defaultThinkingLevelFor } from '../../src/catalog/models.ts';
import type { ModelEntry } from '../../src/catalog/models.ts';
import { thinkingLevelMapFor } from '../../src/catalog/thinking.ts';
import { effectiveThinkingLevel, thinkingOptionsFor } from '../../src/runtime/thinking.ts';

/** A configured model; ids come from the real vendored models.dev snapshot so
 * the per-model vocabularies under test are the ones a user actually gets. */
function entry(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: 'grok:grok-4.6', provider: 'grok', modelId: 'grok-4.6', grade: 'highest',
    api: 'openai-completions', baseUrl: 'https://api.x.ai/v1',
    contextWindow: 500_000, maxTokens: 100_000, reasoning: true,
    ...over,
  };
}

const levels = (model: ModelEntry) => thinkingOptionsFor(model).map(option => option.level);

describe('per-model thinking strengths', () => {
  test('a model offers exactly the effort levels its catalog entry names', () => {
    // xai names low/medium/high/xhigh: no minimal, and its top level is xhigh.
    expect(levels(entry())).toEqual(['low', 'medium', 'high', 'xhigh']);
    // deepseek names low/high/max: no medium, and its top level is max.
    const deepseek = entry({ id: 'deepseek-flash', provider: 'deepseek', modelId: 'deepseek-flash' });
    expect(levels(deepseek)).toEqual(['low', 'high', 'max']);
  });

  test('the provider spelling of a level is kept as its label', () => {
    const options = thinkingOptionsFor(entry());
    expect(options.find(option => option.level === 'xhigh')?.label).toBe('xhigh');
    expect(options.find(option => option.level === 'low')?.label).toBe('low');
    expect(options.some(option => option.level === 'off')).toBe(false);
  });

  test('a model with no discrete effort vocabulary keeps Pi default levels', () => {
    // mimo-v2.6-pro is reasoning-capable but only publishes a toggle.
    const mimo = entry({ id: 'opencode-go:mimo-v2.6-pro', provider: 'opencode-go', modelId: 'mimo-v2.6-pro' });
    expect(levels(mimo)).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  test('a model missing from the snapshot falls back instead of guessing', () => {
    const unknown = entry({ id: 'x:y', provider: 'no-such-provider', modelId: 'no-such-model' });
    expect(levels(unknown)).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  test('every model is thinking-capable, including one flagged otherwise', () => {
    // The console no longer asks whether a model can think: the legacy flag is
    // ignored, so an old config entry still gets real levels and thinking on.
    const plain = entry({ reasoning: false, defaultThinkingLevel: 'high' });
    expect(levels(plain)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(effectiveThinkingLevel(plain, 'high')).toBe('high');
    expect(effectiveThinkingLevel(plain, 'off')).toBe('low');
  });

  test('a level the model does not accept falls back like the SDK does', () => {
    // xhigh is the strongest xai level, so max falls back to xhigh, not high.
    expect(effectiveThinkingLevel(entry(), 'max')).toBe('xhigh');
    // minimal is not offered, so it falls forward to low.
    expect(effectiveThinkingLevel(entry(), 'minimal')).toBe('low');
    const deepseek = entry({ id: 'deepseek-flash', provider: 'deepseek', modelId: 'deepseek-flash' });
    expect(effectiveThinkingLevel(deepseek, 'medium')).toBe('high');
    // off is never offered, so it falls forward to the lowest real level.
    expect(effectiveThinkingLevel(deepseek, 'off')).toBe('low');
    expect(effectiveThinkingLevel(entry(), 'off')).toBe('low');
  });

  test('a saved default the model does not accept is not offered, only clamped', () => {
    // deepseek names low/high/max: a stale xhigh default cannot make xhigh real.
    const deepseek = entry({
      id: 'opencode-go:deepseek-v4.1-flash', provider: 'opencode-go', modelId: 'deepseek-v4.1-flash',
      defaultThinkingLevel: 'xhigh',
    });
    expect(levels(deepseek)).toEqual(['low', 'high', 'max']);
    expect(thinkingLevelMapFor(deepseek).xhigh).toBeNull();
    expect(effectiveThinkingLevel(deepseek)).toBe('max');
    // A model the snapshot does not name keeps Pi's default levels, and the SDK
    // will not invent xhigh without a catalog entry that names it.
    const unknown = entry({
      id: 'x:y', provider: 'no-such-provider', modelId: 'no-such-model', defaultThinkingLevel: 'xhigh',
    });
    expect(levels(unknown)).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(effectiveThinkingLevel(unknown)).toBe('high');
  });

  test('the level map denies off and every unlisted level', () => {
    const map = thinkingLevelMapFor(entry());
    expect(map.off).toBeNull();
    expect(map.minimal).toBeNull();
    expect(map.max).toBeNull();
    expect(map.xhigh).toBe('xhigh');
    expect(map.low).toBe('low');
    // A model flagged as non-reasoning is still treated as thinking-capable.
    expect(thinkingLevelMapFor(entry({ reasoning: false })).low).toBe('low');
  });

  test('the default is the second strongest level a model accepts', () => {
    const options = (model: ModelEntry) => thinkingOptionsFor(model).map(option => option.level);
    // low/medium/high/xhigh → high; low/high/max → high; minimal…high → medium.
    expect(defaultThinkingLevelFor(options(entry()).map(level => ({ level })))).toBe('high');
    const deepseek = entry({ id: 'deepseek-flash', provider: 'deepseek', modelId: 'deepseek-flash' });
    expect(defaultThinkingLevelFor(options(deepseek).map(level => ({ level })))).toBe('high');
    const mimo = entry({ id: 'opencode-go:mimo-v2.6-pro', provider: 'opencode-go', modelId: 'mimo-v2.6-pro' });
    expect(defaultThinkingLevelFor(options(mimo).map(level => ({ level })))).toBe('medium');
    // The rule is what a model with no configured default actually runs at.
    expect(effectiveThinkingLevel(mimo)).toBe('medium');
    // A single-level model uses the only level it has.
    expect(defaultThinkingLevelFor([{ level: 'high' }])).toBe('high');
    expect(defaultThinkingLevelFor([])).toBeUndefined();
  });
});
