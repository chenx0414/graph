import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  COMPOSER_HISTORY_LIMIT,
  composerHistoryDown,
  composerHistoryUp,
  composerHistoryValue,
  createComposerHistoryState,
  recordComposerPrompt,
  resetComposerHistory,
} from '../../src/web/chat-history.ts';

function history(...prompts: string[]) {
  return prompts.reduce(recordComposerPrompt, createComposerHistoryState());
}

describe('composer prompt history', () => {
  test('remembers sent prompts oldest → newest and trims blanks', () => {
    const state = history('第一条', '  ', '第二条');
    expect(state.entries).toEqual(['第一条', '第二条']);
    expect(state.cursor).toBeNull();
  });

  test('collapses consecutive duplicates', () => {
    expect(history('same', 'same', 'different', 'different').entries).toEqual(['same', 'different']);
  });

  test('caps the remembered prompts', () => {
    const state = history(...Array.from({ length: COMPOSER_HISTORY_LIMIT + 20 }, (_, i) => `p${i}`));
    expect(state.entries.length).toBe(COMPOSER_HISTORY_LIMIT);
    expect(state.entries[0]).toBe('p20');
    expect(state.entries.at(-1)).toBe(`p${COMPOSER_HISTORY_LIMIT + 19}`);
  });

  test('↑ out of the draft shows the newest prompt and saves the draft', () => {
    const start = history('first', 'second');
    const up = composerHistoryUp(start, '半截草稿');
    expect(up?.value).toBe('second');
    expect(up?.state.cursor).toBe(0);
    expect(up?.state.draft).toBe('半截草稿');
  });

  test('repeated ↑ walks toward the oldest and then stops', () => {
    const start = history('first', 'second', 'third');
    const one = composerHistoryUp(start, 'draft')!;
    const two = composerHistoryUp(one.state, one.value)!;
    const three = composerHistoryUp(two.state, two.value)!;
    expect(one.value).toBe('third');
    expect(two.value).toBe('second');
    expect(three.value).toBe('first');
    // At the earliest prompt the key is no longer consumed.
    expect(composerHistoryUp(three.state, three.value)).toBeNull();
  });

  test('↓ walks back to the newest prompt and restores the draft', () => {
    const start = history('first', 'second');
    const one = composerHistoryUp(start, '草稿内容')!;
    const two = composerHistoryUp(one.state, one.value)!;
    const backToNewest = composerHistoryDown(two.state)!;
    expect(backToNewest.value).toBe('second');
    const restored = composerHistoryDown(backToNewest.state)!;
    expect(restored.value).toBe('草稿内容');
    expect(restored.state.cursor).toBeNull();
    // Already on the draft: the key is not consumed.
    expect(composerHistoryDown(restored.state)).toBeNull();
  });

  test('empty history never consumes the arrow keys', () => {
    const empty = createComposerHistoryState();
    expect(composerHistoryUp(empty, 'x')).toBeNull();
    expect(composerHistoryDown(empty)).toBeNull();
  });

  test('typing while browsing leaves the prompt list intact', () => {
    const start = history('sent');
    const browsing = composerHistoryUp(start, 'draft')!;
    const edited = resetComposerHistory(browsing.state);
    expect(edited.cursor).toBeNull();
    expect(edited.entries).toEqual(['sent']);
  });

  test('sending resets the browsing position', () => {
    const browsing = composerHistoryUp(history('a'), 'draft')!;
    const sent = recordComposerPrompt(browsing.state, 'b');
    expect(sent.cursor).toBeNull();
    expect(sent.entries).toEqual(['a', 'b']);
  });

  test('reports the prompt under the cursor', () => {
    const start = history('one', 'two');
    expect(composerHistoryValue(start)).toBeNull();
    const one = composerHistoryUp(start, 'draft')!;
    expect(composerHistoryValue(one.state)).toBe('two');
  });

  test('the composer sources history from the conversation, normalizes it and keeps dedup', () => {
    // A conversation whose transcript already carries sent prompts seeds the
    // state; blank and repeated adjacent entries collapse the same way.
    const seeded = createComposerHistoryState(['', ' 你好 ', '你好', '再见']);
    expect(seeded.entries).toEqual(['你好', '再见']);
  });
});

describe('composer keyboard wiring', () => {
  const source = readFileSync(new URL('../../src/web/ChatComposer.tsx', import.meta.url), 'utf8');

  test('↑/↓ use the history helpers only while no / or @ menu is open', () => {
    expect(source).toContain('composerHistoryUp(');
    expect(source).toContain('composerHistoryDown(');
    expect(source).toMatch(/if \(!slashOpen && !mentionOpen && \(event\.key === 'ArrowUp' \|\| event\.key === 'ArrowDown'\)\)/);
    // The history branch must sit after the menu branches so the menus win the keys.
    expect(source.indexOf('if (!slashOpen && !mentionOpen')).toBeGreaterThan(source.indexOf('if (slashOpen) {'));
  });

  test('⌘Z / ⇧⌘Z step the explicit snapshot stack', () => {
    expect(source).toContain('undoComposer(');
    expect(source).toContain('redoComposer(');
    expect(source).toMatch(/key === 'z'/);
  });

  test('sending a prompt feeds the recalled history', () => {
    expect(source).toContain('recordComposerPrompt(');
    expect(source).toContain('rememberPrompt()');
  });
});
