import { describe, expect, test } from 'vitest';
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
    expect(levels(entry())).toEqual(['off', 'low', 'medium', 'high', 'xhigh']);
    // deepseek names low/high/max: no medium, and its top level is max.
    const deepseek = entry({ id: 'deepseek-flash', provider: 'deepseek', modelId: 'deepseek-flash' });
    expect(levels(deepseek)).toEqual(['off', 'low', 'high', 'max']);
  });

  test('the provider spelling of a level is kept as its label', () => {
    const options = thinkingOptionsFor(entry());
    expect(options.find(option => option.level === 'xhigh')?.label).toBe('xhigh');
    // xai publishes no name for switching thinking off, so the level name stands
    // in; the console renders its own label for that instead of a second name.
    expect(options.find(option => option.level === 'off')?.label).toBe('off');
    // ChatGPT does name it, and the console shows that name beside 关闭.
    const gpt = thinkingOptionsFor(entry({ id: 'chatgpt:gpt-5.6', provider: 'chatgpt', modelId: 'gpt-5.6' }));
    expect(gpt.find(option => option.level === 'off')?.label).toBe('none');
    expect(gpt.map(option => option.level)).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('a model with no discrete effort vocabulary keeps Pi default levels', () => {
    // mimo-v2.6-pro is reasoning-capable but only publishes a toggle.
    const mimo = entry({ id: 'opencode-go:mimo-v2.6-pro', provider: 'opencode-go', modelId: 'mimo-v2.6-pro' });
    expect(levels(mimo)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
  });

  test('a model missing from the snapshot falls back instead of guessing', () => {
    const unknown = entry({ id: 'x:y', provider: 'no-such-provider', modelId: 'no-such-model' });
    expect(levels(unknown)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
  });

  test('a model that cannot think offers nothing and always runs off', () => {
    const plain = entry({ reasoning: false, defaultThinkingLevel: 'high' });
    expect(thinkingOptionsFor(plain)).toEqual([]);
    expect(effectiveThinkingLevel(plain, 'high')).toBe('off');
  });

  test('a level the model does not accept falls back like the SDK does', () => {
    // xhigh is the strongest xai level, so max falls back to xhigh, not high.
    expect(effectiveThinkingLevel(entry(), 'max')).toBe('xhigh');
    // minimal is not offered, so it falls forward to low.
    expect(effectiveThinkingLevel(entry(), 'minimal')).toBe('low');
    const deepseek = entry({ id: 'deepseek-flash', provider: 'deepseek', modelId: 'deepseek-flash' });
    expect(effectiveThinkingLevel(deepseek, 'medium')).toBe('high');
    expect(effectiveThinkingLevel(deepseek, 'off')).toBe('off');
  });

  test('an explicit user default is never denied by catalog data', () => {
    const configured = entry({ defaultThinkingLevel: 'max' });
    expect(levels(configured)).toContain('max');
    expect(effectiveThinkingLevel(configured)).toBe('max');
  });

  test('the level map denies unlisted levels and maps the listed ones', () => {
    const map = thinkingLevelMapFor(entry())!;
    expect(map.minimal).toBeNull();
    expect(map.max).toBeNull();
    expect(map.xhigh).toBe('xhigh');
    expect(map.low).toBe('low');
    // off travels as "no reasoning option", never as an effort value.
    expect(map.off).toBeUndefined();
    expect(thinkingLevelMapFor(entry({ reasoning: false }))).toBeUndefined();
  });
});
