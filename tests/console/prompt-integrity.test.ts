import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { PROMPT_SECTIONS, promptIntegrity, reportPromptIntegrity } from '../../src/runtime/prompt-integrity.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanups.reverse()) await action();
  cleanups.length = 0;
});
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'graph-prompt-integrity-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const COMPLETE = [
  '<identity>\nMAIN IDENTITY SENTINEL\n</identity>',
  '<rules>\n- Use tool results as evidence.\n</rules>',
  '<docs>\nGraph documentation.\n</docs>',
  '<cwd>\n/Users/me/project\n</cwd>',
  'Project rule: prefer the native agent_browser tool.',
].join('\n\n');

test('a complete prompt passes', () => {
  expect(promptIntegrity(COMPLETE)).toEqual({ checked: true, ok: true, missing: [] });
});

test('a prompt that lost a Graph section reports exactly which one', () => {
  const truncated = COMPLETE.slice(0, COMPLETE.indexOf('<docs>'));
  expect(promptIntegrity(truncated)).toEqual({ checked: true, ok: false, missing: ['<docs>', '<cwd>'] });
});

test('an extension that wiped the whole prompt is reported, not ignored', () => {
  expect(promptIntegrity('')).toEqual({ checked: true, ok: false, missing: [...PROMPT_SECTIONS] });
});

test('a send that carried no prompt is not a failure', () => {
  expect(promptIntegrity(null)).toEqual({ checked: false, ok: true, missing: [] });
});

test('the expected set can be narrowed for a caller that knows better', () => {
  const bare = '<identity>\nA\n</identity>';
  expect(promptIntegrity(bare, ['<identity>'])).toEqual({ checked: true, ok: true, missing: [] });
});

test('a healthy send writes nothing and a damaged one is appended to the report', async () => {
  const dir = await temp();
  expect(await reportPromptIntegrity(dir, 'op-1', COMPLETE)).toEqual({ checked: true, ok: true, missing: [] });
  await expect(readFile(join(dir, 'prompt-integrity.log'), 'utf8')).rejects.toThrow();
  const damaged = await reportPromptIntegrity(dir, 'op-2', '<identity>\nA\n</identity>');
  expect(damaged.ok).toBe(false);
  const line = await readFile(join(dir, 'prompt-integrity.log'), 'utf8');
  expect(line.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(line)).toMatchObject({ operationId: 'op-2', missing: ['<rules>', '<docs>', '<cwd>'] });
});
