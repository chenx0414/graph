import { describe, expect, test } from 'vitest';
import { nearestLevel, thinkingLabel, thinkingOptionLabel, thinkingView, type ThinkingOptionView } from '../../src/web/thinking-levels.ts';

const option = (level: string, label = level): ThinkingOptionView => ({ level, label });

describe('thinking control view', () => {
  test('a model that cannot think offers no strength and says so', () => {
    const view = thinkingView({ id: 'plain', reasoning: false, thinkingOptions: [] }, 'high');
    expect(view.disabled).toBe(true);
    expect(view.options).toEqual([]);
    expect(view.level).toBe('off');
    expect(view.reason).toBe('该模型不支持思考强度');
  });

  test('an empty option list is reported, never guessed', () => {
    const view = thinkingView({ id: 'x', reasoning: true, thinkingOptions: [] }, 'high');
    expect(view.disabled).toBe(true);
    expect(view.reason).toBe('该模型没有可选的思考强度档位');
  });

  test('the model own option list drives the control', () => {
    const view = thinkingView(
      { id: 'grok', reasoning: true, thinkingOptions: [option('off', '关闭'), option('low'), option('xhigh')] },
      'low',
    );
    expect(view.options.map(item => item.level)).toEqual(['off', 'low', 'xhigh']);
    expect(view.level).toBe('low');
    expect(view.disabled).toBe(false);
  });

  test('a payload without the field keeps the previous levels', () => {
    const view = thinkingView({ id: 'legacy', reasoning: true }, 'medium');
    expect(view.options.map(item => item.level)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(view.level).toBe('medium');
  });

  test('a selected level the model does not take falls back like the SDK', () => {
    const options = [option('off'), option('low'), option('high'), option('max')];
    expect(nearestLevel(options, 'medium')).toBe('high');
    expect(nearestLevel(options, 'xhigh')).toBe('max');
    expect(nearestLevel(options, 'off')).toBe('off');
    expect(nearestLevel(options, 'bogus')).toBe('off');
  });

  test('a saved level the model does not take is reported as a fallback', () => {
    const view = thinkingView(
      { id: 'grok', reasoning: true, thinkingOptions: [option('off'), option('low'), option('high'), option('max')] },
      'xhigh',
    );
    expect(view.level).toBe('max');
    expect(view.fallbackFrom).toBe('xhigh');
    const exact = thinkingView(
      { id: 'grok', reasoning: true, thinkingOptions: [option('off'), option('xhigh')] },
      'xhigh',
    );
    expect(exact.level).toBe('xhigh');
    expect(exact.fallbackFrom).toBeUndefined();
  });

  test('levels are shown in the model own vocabulary, never translated', () => {
    expect(thinkingOptionLabel(option('high'))).toBe('high');
    expect(thinkingOptionLabel(option('xhigh'))).toBe('xhigh');
    // A provider's own spelling wins over Pi's name for the same level.
    expect(thinkingOptionLabel(option('off', 'none'))).toBe('none');
    expect(thinkingOptionLabel(option('max', 'max'))).toBe('max');
    expect(thinkingLabel('xhigh')).toBe('xhigh');
    expect(thinkingLabel('off')).toBe('off');
    expect(thinkingLabel(undefined)).toBe('—');
  });
});
