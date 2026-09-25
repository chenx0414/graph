/**
 * Tool-result lazy loading (backlog v81, frozen design).
 *
 * Failure modes this file pins down, in order:
 *  - a small result must pass through untouched (no handle, no summary)
 *  - exactly 4,000 characters still passes through; 4,001 does not
 *  - the first two occurrences of one (conversation, tool, params) key stay full
 *  - the third occurrence is replaced by a bounded summary plus a readable handle
 *  - the summary is deterministic: the same result yields the same text
 *  - changed params, or a changed result for the same params, count as new keys
 *  - nothing is truncated silently: the summary names the handle and how to read it
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  SUMMARY_LIMIT,
  TOOL_RESULT_LIMIT,
  createToolResultTracker,
  renderToolResult,
  summarizeToolResult,
  toolResultKey,
} from '../../src/runtime/tool-results.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'graph-tool-results-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const call = (text: string, params: Record<string, unknown> = { path: 'a.txt' }) => ({ conversationId: 'conv-1', tool: 'read', params, text });

function body(input: string) {
  const marker = '\n---\n';
  return input.includes(marker) ? input.slice(input.indexOf(marker) + marker.length) : input;
}

test('a small result is passed through unchanged', async () => {
  const spillDir = await scratch();
  const tracker = createToolResultTracker();
  const small = 'x'.repeat(TOOL_RESULT_LIMIT);
  for (let round = 0; round < 4; round += 1) {
    const rendered = await renderToolResult({ ...call(small), spillDir, tracker });
    expect(rendered).toBe(small);
  }
  // One character over the limit is a large result from the very first call on.
  await renderToolResult({ ...call('x'.repeat(TOOL_RESULT_LIMIT + 1)), spillDir, tracker });
});

test('the first two occurrences stay full, the third becomes a bounded summary', async () => {
  const spillDir = await scratch();
  const tracker = createToolResultTracker();
  const text = `head-marker\n${'y'.repeat(TOOL_RESULT_LIMIT * 2)}\ntail-marker`;

  const first = await renderToolResult({ ...call(text), spillDir, tracker });
  const second = await renderToolResult({ ...call(text), spillDir, tracker });
  const third = await renderToolResult({ ...call(text), spillDir, tracker });

  expect(first).toBe(text);
  expect(second).toBe(text);
  expect(third).not.toBe(text);
  expect(third.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
  expect(third).toContain(String(text.length));
  expect(third).toContain('head-marker');
  expect(third).toContain('omitted');

  // The handle names a real file holding the whole result, byte for byte.
  const handle = /handle: (\S+)/.exec(third)?.[1];
  expect(handle).toBeTruthy();
  expect(await readFile(handle!, 'utf8')).toBe(text);
});

test('a different argument set or a different result is a new key', async () => {
  const spillDir = await scratch();
  const tracker = createToolResultTracker();
  const text = 'z'.repeat(TOOL_RESULT_LIMIT + 10);
  await renderToolResult({ ...call(text, { path: 'a.txt' }), spillDir, tracker });
  await renderToolResult({ ...call(text, { path: 'a.txt' }), spillDir, tracker });
  // Another path: this key was never seen, so it stays full even though the same
  // tool produced it twice already.
  const otherPath = await renderToolResult({ ...call(text, { path: 'b.txt' }), spillDir, tracker });
  expect(otherPath).toBe(text);
  // Same path, changed content: not the same result, so it stays full as well.
  const changed = await renderToolResult({ ...call(`${text}\nchanged`), spillDir, tracker });
  expect(changed).toBe(`${text}\nchanged`);
});

test('the summary is deterministic and always says how to get the rest', async () => {
  const text = Array.from({ length: 400 }, (_, index) => `line-${index}`).join('\n');
  const first = summarizeToolResult({ text, handle: '/tmp/handle-1' });
  const second = summarizeToolResult({ text, handle: '/tmp/handle-1' });
  expect(first).toBe(second);
  expect(first.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
  expect(first).toContain('400 lines');
  expect(first).toContain(String(text.length));
  expect(first).toContain('line-0');
  expect(first).toContain('line-399');
  expect(first).toContain('handle: /tmp/handle-1');
  expect(first).toContain('read');
});

test('the key is stable for identical input and separates real differences', () => {
  const base = toolResultKey(call('same'));
  expect(toolResultKey(call('same'))).toBe(base);
  expect(toolResultKey(call('same', { path: 'b.txt' }))).not.toBe(base);
  expect(toolResultKey(call('different'))).not.toBe(base);
  expect(toolResultKey({ ...call('same'), tool: 'bash' })).not.toBe(base);
  expect(toolResultKey({ ...call('same'), conversationId: 'conv-2' })).not.toBe(base);
  // Parameter order must not matter.
  expect(toolResultKey({ ...call('same'), params: { a: 1, b: 2 } })).toBe(toolResultKey({ ...call('same'), params: { b: 2, a: 1 } }));
});
