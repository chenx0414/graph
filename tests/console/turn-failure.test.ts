import { expect, test } from 'vitest';
import { turnFailureReason, turnFailureText } from '../../src/core/conversation.ts';

const moduleStack = "Error: node:internal/modules/package_json_reader:301\n  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find package '@earendil-works/pi-ai' imported from /tmp/ux/src/runtime/pi-worker.ts";

test('a failed turn keeps its concrete reason instead of a generic apology', () => {
  const text = turnFailureText('Persisted capability bundle does not match the Agent definition (a != b)');
  expect(text).toContain('没有完成回复');
  expect(text).toContain('原因：Persisted capability bundle does not match the Agent definition (a != b)');
});

test('a truncated model output keeps its plain-language sentence without the raw parse error', () => {
  const truncated = turnFailureText('unexpected end of json input');
  expect(truncated).toContain('模型输出被截断');
  // Raw exception text stays in the problem ledger; the user gets the actionable sentence.
  expect(truncated).not.toContain('原因：');
  expect(turnFailureText('SyntaxError: Unterminated string in JSON at position 1')).not.toContain('SyntaxError');
  expect(turnFailureText('Model response hit the output token limit before completing the reply')).toContain('模型输出被截断');
  expect(turnFailureText('unknown usage for this model')).toContain('缺少可核对的用量');
});

test('a setup failure names its own reason even when its stack mentions JSON', () => {
  const setup = turnFailureText(moduleStack, 'setup');
  expect(setup).toContain('没有启动起来');
  expect(setup).not.toContain('被截断');
  expect(setup).toContain("Cannot find package '@earendil-works/pi-ai'");
  // The same stack on the run path is not read as a truncated output either: it names what
  // actually broke instead of hiding behind the module loader internals.
  const run = turnFailureText(moduleStack);
  expect(run).not.toContain('被截断');
  expect(run).not.toContain('package_json_reader');
  expect(run).toContain("Cannot find package '@earendil-works/pi-ai'");
});

test('an unclassified failure names its reason, bounded to one line', () => {
  expect(turnFailureText('Persisted capability bundle does not match the Agent definition (a != b)'))
    .toContain('原因：Persisted capability bundle does not match the Agent definition (a != b)');
  expect(turnFailureText('')).not.toContain('原因：');
  expect(turnFailureText(`x\n${'y'.repeat(900)}`).length).toBeLessThan(400);
});

test('a failure reason reports the field it came from, not raw JSON', () => {
  expect(turnFailureReason({ outcome: 'failed', output: { setupError: 'Persisted session identity changed' } }))
    .toEqual({ reason: 'Persisted session identity changed', kind: 'setup' });
  // A completed run that failed still wins when both are present.
  expect(turnFailureReason({ outcome: 'failed', output: { error: 'model exploded', setupError: 'setup' } }))
    .toEqual({ reason: 'model exploded', kind: 'run' });
  expect(turnFailureReason({ outcome: 'failed', output: { anything: 1 } }))
    .toEqual({ reason: '{"anything":1}', kind: 'run' });
});
