import { expect, test } from 'vitest';
import { turnFailureReason, turnFailureText } from '../../src/core/conversation.ts';

test('a failed turn keeps its concrete reason instead of a generic apology', () => {
  const text = turnFailureText('Persisted capability bundle does not match the Agent definition (a != b)');
  expect(text).toContain('没有完成回复');
  expect(text).toContain('原因：Persisted capability bundle does not match the Agent definition (a != b)');
});

test('a classified failure keeps its plain-language sentence without the raw parse error', () => {
  const truncated = turnFailureText('unexpected end of json input');
  expect(truncated).toContain('模型输出被截断');
  // Raw exception text stays in the problem ledger; the user gets the actionable sentence.
  expect(truncated).not.toContain('原因：');
  expect(turnFailureText('SyntaxError: Unterminated string in JSON at position 1')).not.toContain('SyntaxError');
  expect(turnFailureText('unknown usage for this model')).toContain('缺少可核对的用量');
});

test('an unclassified failure names its reason, bounded to one line', () => {
  expect(turnFailureText('Persisted capability bundle does not match the Agent definition (a != b)'))
    .toContain('原因：Persisted capability bundle does not match the Agent definition (a != b)');
  expect(turnFailureText('')).not.toContain('原因：');
  expect(turnFailureText(`x\n${'y'.repeat(900)}`).length).toBeLessThan(400);
});

test('a setup failure is reported by its own reason, not as raw JSON', () => {
  expect(turnFailureReason({ outcome: 'failed', output: { setupError: 'Persisted session identity changed' } }))
    .toBe('Persisted session identity changed');
  // A model failure still wins when both are present.
  expect(turnFailureReason({ outcome: 'failed', output: { error: 'model exploded', setupError: 'setup' } }))
    .toBe('model exploded');
  expect(turnFailureReason({ outcome: 'failed', output: { anything: 1 } })).toBe('{"anything":1}');
});
