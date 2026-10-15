import { describe, expect, test } from 'vitest';
import { thinkingLabel, thinkingOptionLabel, thinkingView, type ThinkingOptionView } from '../../src/web/thinking-levels.ts';

const option = (level: string, label = level): ThinkingOptionView => ({ level, label });

describe('thinking control view', () => {
  test('a payload without the field keeps the fallback levels, never off', () => {
    const view = thinkingView({ id: 'legacy' }, 'medium');
    expect(view.options.map(item => item.level)).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(view.level).toBe('medium');
    expect(view.options.some(item => item.level === 'off')).toBe(false);
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
