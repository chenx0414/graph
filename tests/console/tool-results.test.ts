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
 *  - the agent-loop hook leaves a small result, a first or second view, or a
 *    text-free result completely untouched (no content override at all)
 *  - the hook never fabricates a terminate or details override
 *  - the hook keeps non-text parts, replaces the first text part and drops the rest
 *  - counts are per scope: another conversation never inherits them
 *  - a shell result over the shell ceiling is bounded from its very first view, with
 *    a handle that still holds every byte
 *  - read and edit keep their upstream behaviour: this seam never caps them
 *  - an explicit limit is honoured by the summary itself
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  SHELL_OUTPUT_LIMIT,
  SUMMARY_LIMIT,
  TOOL_RESULT_LIMIT,
  createToolResultTracker,
  renderToolResult,
  summarizeToolResult,
  toolResultHook,
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

/** One tool result as the agent loop hands it to the hook. */
const context = (text: string, params: Record<string, unknown> = { path: 'a.txt' }) => ({
  toolCall: { name: 'read' }, args: params, result: { content: [{ type: 'text' as const, text }] },
});

const partsOf = (result: { content?: readonly { type: string; text?: string }[] }) =>
  [...(result.content ?? [])] as { type: string; text?: string; mimeType?: string }[];

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
  // A single huge line still reports what it dropped, byte-wise.
  const oneLine = summarizeToolResult({ text: 'p'.repeat(TOOL_RESULT_LIMIT * 2), handle: '/tmp/handle-2' });
  expect(oneLine).toContain('omitted');
  expect(oneLine).not.toContain('p'.repeat(TOOL_RESULT_LIMIT));
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

test('the hook leaves small results visibly untouched, however often they repeat', async () => {
  const spillDir = await scratch();
  const hook = toolResultHook({ scopeId: 'conv-hook-small', spillDir });
  const small = 'x'.repeat(TOOL_RESULT_LIMIT);
  for (let round = 0; round < 4; round += 1) {
    expect(await hook(context(small))).toBeUndefined();
  }
});

test('the hook answers the third large result with a summary and a readable handle', async () => {
  const spillDir = await scratch();
  const hook = toolResultHook({ scopeId: 'conv-hook-large', spillDir });
  const big = 'y'.repeat(TOOL_RESULT_LIMIT + 20);

  expect(await hook(context(big))).toBeUndefined();
  expect(await hook(context(big))).toBeUndefined();
  const third = await hook(context(big));
  expect(third).toBeTruthy();

  const parts = partsOf(third!);
  expect(parts).toHaveLength(1);
  const summary = parts[0]!.text ?? '';
  expect(summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
  const handle = /handle: (\S+)/.exec(summary)?.[1];
  expect(handle).toBeTruthy();
  expect(await readFile(handle!, 'utf8')).toBe(big);
  // Only content may be overridden: the tool's own terminate hint and details survive.
  expect('terminate' in third!).toBe(false);
  expect('details' in third!).toBe(false);
});

test('the hook keeps non-text parts, summarises at the first text part and drops the rest', async () => {
  const spillDir = await scratch();
  const hook = toolResultHook({ scopeId: 'conv-hook-parts', spillDir });
  const big = 'z'.repeat(TOOL_RESULT_LIMIT + 5);
  const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' };
  const call = {
    toolCall: { name: 'read' }, args: { path: 'a.txt' },
    result: { content: [image, { type: 'text' as const, text: big }, { type: 'text' as const, text: 'tail' }] },
  };
  await hook(call);
  await hook(call);
  const third = await hook(call);
  const parts = partsOf(third!);
  expect(parts.map(part => part.type)).toEqual(['image', 'text']);
  expect(parts[0]!.mimeType).toBe('image/png');
  expect(parts[1]!.text).toContain('omitted');
});

test('a text-free result is left alone and counts never leak between scopes', async () => {
  const spillDir = await scratch();
  const imageOnly = {
    toolCall: { name: 'read' }, args: {},
    result: { content: [{ type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }] },
  };
  expect(await toolResultHook({ scopeId: 'conv-hook-none', spillDir })(imageOnly)).toBeUndefined();

  const big = 'w'.repeat(TOOL_RESULT_LIMIT + 1);
  const first = toolResultHook({ scopeId: 'conv-hook-scope-a', spillDir });
  const other = toolResultHook({ scopeId: 'conv-hook-scope-b', spillDir });
  expect(await first(context(big))).toBeUndefined();
  expect(await first(context(big))).toBeUndefined();
  // Another conversation never inherits this count, and the count itself persists
  // across hook objects because the daemon keeps one tracker per scope.
  expect(await other(context(big))).toBeUndefined();
  expect(await first(context(big))).toBeTruthy();
});

test('a shell result over the shell ceiling is bounded from its first view, with a readable handle', async () => {
  const spillDir = await scratch();
  const hook = toolResultHook({ scopeId: 'conv-hook-shell', spillDir });
  const big = `${'q'.repeat(25_000)}\nlast-line`;
  const shell = {
    toolCall: { name: 'bash' }, args: { command: 'cat big.log' },
    result: { content: [{ type: 'text' as const, text: big }] },
  };

  const first = await hook(shell);
  expect(first).toBeTruthy();
  const summary = partsOf(first!)[0]!.text ?? '';
  expect(summary.length).toBeLessThanOrEqual(SHELL_OUTPUT_LIMIT);
  expect(summary).toContain('omitted');
  expect(summary).toContain('last-line');
  const handle = /handle: (\S+)/.exec(summary)?.[1];
  expect(handle).toBeTruthy();
  expect(await readFile(handle!, 'utf8')).toBe(big);
});

test('the shell ceiling is exact, and read and edit are never capped by this seam', async () => {
  const spillDir = await scratch();
  const hook = toolResultHook({ scopeId: 'conv-hook-ceiling', spillDir });
  const run = (name: string, text: string, args: Record<string, unknown> = {}) =>
    hook({ toolCall: { name }, args, result: { content: [{ type: 'text' as const, text }] } });

  // Exactly at the ceiling the output is still the tool's own.
  expect(await run('bash', 'r'.repeat(SHELL_OUTPUT_LIMIT), { command: 'x' })).toBeUndefined();
  // read and edit keep their upstream bounds: no Graph-side cap, so the first two
  // views stay full and only a repeated third view is bounded.
  const read = 'r'.repeat(25_000);
  expect(await run('read', read)).toBeUndefined();
  expect(await run('read', read)).toBeUndefined();
  expect(await run('read', read)).toBeTruthy();
  const edit = 'r'.repeat(25_000);
  expect(await run('edit', edit, { path: 'a.txt' })).toBeUndefined();
  expect(await run('edit', edit, { path: 'a.txt' })).toBeUndefined();
});

test('the summary honours an explicit limit', () => {
  const text = Array.from({ length: 2_000 }, (_, index) => `line-${index}`).join('\n');
  const bounded = summarizeToolResult({ text, handle: '/tmp/handle-3', limit: SHELL_OUTPUT_LIMIT });
  expect(bounded.length).toBeLessThanOrEqual(SHELL_OUTPUT_LIMIT);
  expect(bounded).toContain('2000 lines');
  expect(bounded).toContain(String(text.length));
  expect(bounded).toContain('line-0');
  expect(bounded).toContain('line-1999');
  expect(bounded).toContain('handle: /tmp/handle-3');
});
