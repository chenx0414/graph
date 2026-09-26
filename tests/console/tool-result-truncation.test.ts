import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToolResult, hoistTruncationNotice } from '../../src/runtime/tool-results.ts';

const NOTICE = '[Showing lines 1-2000 of 3400. Use offset=2001 to continue.]';
const LARGE = `${Array.from({ length: 400 }, (_, i) => `export interface Thing${i} { a: string }`).join('\n')}\n\n${NOTICE}`;

// A truncated read must not look like a whole file. The SDK puts its notice on the last line, where
// a long result buries it; the harness moves it to the first line.
test('hoists a trailing truncation notice to the front', () => {
  const hoisted = hoistTruncationNotice(`line one\nline two\n\n${NOTICE}`);
  expect(hoisted.startsWith(`[truncated: ${NOTICE}]`)).toBe(true);
  expect(hoisted).toContain('line one');
  // The notice appears once, in front of the content it qualifies.
  expect(hoisted.split(NOTICE).length - 1).toBe(1);
});

// Every other tool result passes through unchanged: this is an annotation, not a rewrite.
test('leaves a result without a notice untouched', () => {
  expect(hoistTruncationNotice('plain output\nsecond line')).toBe('plain output\nsecond line');
  expect(hoistTruncationNotice('a [bracket] in the middle of a line')).toBe('a [bracket] in the middle of a line');
});

test('hoisting is idempotent', () => {
  const once = hoistTruncationNotice(`body\n\n${NOTICE}`);
  expect(hoistTruncationNotice(once)).toBe(once);
});

// The summary path is where the notice used to be lost: the tail it keeps is budgeted, and a long
// enough head squeezes it out. The banner survives because it now sits at the front.
test('a slimmed large result still leads with the notice', async () => {
  const spillDir = mkdtempSync(join(tmpdir(), 'tool-result-truncation-'));
  const slimmed = await renderToolResult({
    text: LARGE,
    conversationId: 'c1',
    tool: 'read',
    params: { path: 'src/big.ts' },
    spillDir,
    tracker: { record: () => 3 },
  });
  expect(slimmed.startsWith(`[truncated: ${NOTICE}]`)).toBe(true);
  expect(slimmed).toContain('handle:');
  expect(slimmed.length).toBeLessThan(LARGE.length);
});

// The first two occurrences of a large result are still returned whole - now with the notice in
// front of them instead of at the end.
test('an untouched large result also leads with the notice', async () => {
  const spillDir = mkdtempSync(join(tmpdir(), 'tool-result-truncation-'));
  const full = await renderToolResult({
    text: LARGE,
    conversationId: 'c2',
    tool: 'read',
    params: { path: 'src/big.ts' },
    spillDir,
    tracker: { record: () => 1 },
  });
  expect(full.startsWith(`[truncated: ${NOTICE}]`)).toBe(true);
  expect(full).toContain('Thing399');
});
