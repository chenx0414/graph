import { describe, expect, test } from 'vitest';
import {
  COMPOSER_UNDO_LIMIT,
  composerEditKind,
  createComposerUndoState,
  recordComposerEdit,
  redoComposer,
  undoComposer,
  type ComposerUndoState,
} from '../../src/web/chat-undo.ts';

/** Apply an edit exactly the way the composer's onChange handler does. */
function edit(state: ComposerUndoState, previous: string, next: string, kind?: ReturnType<typeof composerEditKind>) {
  return recordComposerEdit(state, previous, next, kind ?? composerEditKind(previous, next));
}

function type(state: ComposerUndoState, from: string, to: string) {
  return edit(state, from, to, 'typing');
}

describe('composer undo/redo stack', () => {
  test('undoes a run typed by hand as one step', () => {
    let state = createComposerUndoState();
    state = type(state, '', '你');
    state = type(state, '你', '你好');
    state = type(state, '你好', '你好世');
    state = type(state, '你好世', '你好世界');

    const undone = undoComposer(state, '你好世界');
    expect(undone?.value).toBe('');
    expect(undoComposer(undone!.state, undone!.value)).toBeNull();
  });

  test('a fresh typed run still collapses into a single step', () => {
    let state = createComposerUndoState();
    state = edit(state, '', 'a', 'typing');
    state = edit(state, 'a', 'ab', 'typing');

    const undone = undoComposer(state, 'ab');
    expect(undone?.value).toBe('');
  });

  test('undoes a right-click paste in one step, keeping the earlier text', () => {
    let state = createComposerUndoState();
    state = type(state, '', '前缀 ');
    const pasted = '粘贴的整段文本';
    state = edit(state, '前缀 ', `前缀 ${pasted}`, 'paste');

    expect(composerEditKind('前缀 ', `前缀 ${pasted}`)).toBe('paste');
    const undone = undoComposer(state, `前缀 ${pasted}`);
    expect(undone?.value).toBe('前缀 ');
  });

  test('undoes a deletion and a clear', () => {
    let state = createComposerUndoState();
    state = type(state, '', 'abc');
    state = edit(state, 'abc', 'ab', 'delete');
    expect(undoComposer(state, 'ab')?.value).toBe('abc');

    let cleared = type(createComposerUndoState(), '', 'todo');
    cleared = edit(cleared, 'todo', '', 'clear');
    expect(composerEditKind('todo', '')).toBe('clear');
    expect(undoComposer(cleared, '')?.value).toBe('todo');
  });

  test('redo replays undone edits and is cleared by a new edit', () => {
    let state = type(createComposerUndoState(), '', 'hello');
    const undone = undoComposer(state, 'hello');
    expect(undone?.value).toBe('');
    const redone = redoComposer(undone!.state, undone!.value);
    expect(redone?.value).toBe('hello');

    const undoneAgain = undoComposer(redone!.state, redone!.value);
    const edited = type(undoneAgain!.state, '', 'other');
    expect(redoComposer(edited, 'other')).toBeNull();
  });

  test('a bare undo of a single typed character works', () => {
    const state = type(createComposerUndoState(), '', 'x');
    expect(undoComposer(state, 'x')?.value).toBe('');
  });

  test('ignores no-op edits', () => {
    const state = createComposerUndoState();
    expect(recordComposerEdit(state, 'same', 'same', 'typing')).toBe(state);
  });

  test('keeps at most the 100 most recent steps', () => {
    let state = createComposerUndoState();
    for (let i = 0; i < COMPOSER_UNDO_LIMIT + 25; i += 1) {
      // Use paste so every edit is its own step (typing would coalesce).
      state = edit(state, String(i), `${i}!`, 'paste');
    }
    expect(state.past.length).toBe(COMPOSER_UNDO_LIMIT);
    // The oldest snapshot was dropped, so the earliest reachable value is snapshot #25.
    let current = `${COMPOSER_UNDO_LIMIT + 24}!`;
    let steps = 0;
    let result = undoComposer(state, current);
    while (result) {
      steps += 1;
      current = result.value;
      state = result.state;
      result = undoComposer(state, current);
    }
    expect(steps).toBe(COMPOSER_UNDO_LIMIT);
    expect(current).toBe(String(25));
  });

  test('redo also respects the step limit', () => {
    let state = createComposerUndoState();
    for (let i = 0; i < COMPOSER_UNDO_LIMIT; i += 1) state = edit(state, String(i), `${i}!`, 'paste');
    let current = `${COMPOSER_UNDO_LIMIT - 1}!`;
    let result = undoComposer(state, current);
    while (result) {
      current = result.value;
      state = result.state;
      result = undoComposer(state, current);
    }
    let steps = 0;
    let replay = redoComposer(state, current);
    while (replay) {
      steps += 1;
      current = replay.value;
      state = replay.state;
      replay = redoComposer(state, current);
    }
    expect(steps).toBe(COMPOSER_UNDO_LIMIT);
    expect(state.past.length).toBeLessThanOrEqual(COMPOSER_UNDO_LIMIT);
  });

  test('classifies keyboard edits for the stack', () => {
    expect(composerEditKind('', 'a')).toBe('typing');
    expect(composerEditKind('a', 'ab')).toBe('typing');
    expect(composerEditKind('ab', 'a')).toBe('delete');
    expect(composerEditKind('a', '')).toBe('clear');
    expect(composerEditKind('a', 'abcdef')).toBe('paste');
  });
});
