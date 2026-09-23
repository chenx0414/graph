import { describe, expect, test } from 'vitest';
import { nearestLevel, thinkingLabel, thinkingOptionLabel, thinkingView, type ThinkingOptionView } from '../../src/web/thinking-levels.ts';

const option = (level: string, label = level): ThinkingOptionView => ({ level, label });

describe('thinking control view', () => {
  test('a model with no options at all is reported, never guessed', () => {
    const view = thinkingView({ id: 'x', thinkingOptions: [] }, 'high');
    expect(view.disabled).toBe(true);
    expect(view.reason).toBe('该模型没有可选的思考强度档位');
  });

  test('the model own option list drives the control', () => {
    const view = thinkingView(
      { id: 'grok', thinkingOptions: [option('low'), option('medium'), option('xhigh')] },
      'medium',
    );
    expect(view.options.map(item => item.level)).toEqual(['low', 'medium', 'xhigh']);
    expect(view.level).toBe('medium');
    expect(view.disabled).toBe(false);
  });

  test('a payload without the field keeps the fallback levels, never off', () => {
    const view = thinkingView({ id: 'legacy' }, 'medium');
    expect(view.options.map(item => item.level)).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(view.level).toBe('medium');
    expect(view.options.some(item => item.level === 'off')).toBe(false);
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
      { id: 'grok', thinkingOptions: [option('low'), option('high'), option('max')] },
      'xhigh',
    );
    expect(view.level).toBe('max');
    expect(view.fallbackFrom).toBe('xhigh');
    const exact = thinkingView(
      { id: 'grok', thinkingOptions: [option('low'), option('xhigh')] },
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
