import { expect, test } from 'vitest';
import { formatTokens, nodeTone } from '../../src/web/insights.ts';

test('the token formatter distinguishes unknown from zero', () => {
  expect(formatTokens(undefined)).toBe('未知');
  expect(formatTokens(0)).toBe('0');
});

test('maps node statuses onto the palette used by the graph', () => {
  expect(nodeTone('preparing')).toBe('active');
  expect(nodeTone('succeeded')).toBe('success');
  expect(nodeTone('failed')).toBe('error');
  expect(nodeTone('blocked')).toBe('blocked');
  expect(nodeTone('pending')).toBe('pending');
});
