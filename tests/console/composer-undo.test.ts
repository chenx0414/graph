import { describe, expect, test } from 'vitest';
import {
  UNDO_LIMIT,
  canRedo,
  canUndo,
  createUndoState,
  editGroup,
  recordUndo,
  redoStep,
  undoStep,
  undoValue,
  type UndoState,
} from '../../src/web/chat-undo.ts';

/** Replay a list of edits the way the composer's onChange does. */
function replay(initial: string, edits: string[]): UndoState {
  let state = createUndoState(initial);
  let previous = initial;
  for (const next of edits) {
    state = recordUndo(state, next, editGroup(previous, next));
    previous = next;
  }
  return state;
}

describe('initial state', () => {
  test('a fresh stack holds the starting value and has nothing to undo or redo', () => {
    const state = createUndoState('草稿');
    expect(undoValue(state)).toBe('草稿');
    expect(canUndo(state)).toBe(false);
    expect(canRedo(state)).toBe(false);
    expect(undoStep(state)).toBeNull();
    expect(redoStep(state)).toBeNull();
  });
});

describe('edit grouping', () => {
  test('single appended characters coalesce as typing', () => {
    expect(editGroup('', 'a')).toBe('typing');
    expect(editGroup('a', 'ab')).toBe('typing');
    expect(editGroup('ab', 'abc')).toBe('typing');
  });

  test('a newline or a multi-character insertion starts a fresh step', () => {
    expect(editGroup('a', 'a\n')).toBeNull();
    expect(editGroup('', '粘贴的一段文字')).toBeNull();
    expect(editGroup('abc', 'aXYZc')).toBeNull();
  });

  test('a single backspace coalesces as deleting, a range delete does not', () => {
    expect(editGroup('abc', 'ab')).toBe('deleting');
    expect(editGroup('ab', 'a')).toBe('deleting');
    expect(editGroup('abcd', 'ad')).toBeNull();
  });
});

describe('typing', () => {
  test('a typing burst undoes and redoes as one step', () => {
    let state = replay('', ['h', 'he', 'hel', 'hell', 'hello']);
    expect(state.entries).toEqual(['', 'hello']);
    expect(canUndo(state)).toBe(true);
    expect(canRedo(state)).toBe(false);

    const undone = undoStep(state)!;
    expect(undone.value).toBe('');
    state = undone.state;
    expect(undoValue(state)).toBe('');
    expect(canRedo(state)).toBe(true);

    const redone = redoStep(state)!;
    expect(redone.value).toBe('hello');
    expect(undoValue(redone.state)).toBe('hello');
    expect(canRedo(redone.state)).toBe(false);
  });

  test('continuing to type after an undo closes the old step', () => {
    let state = replay('', ['a', 'ab']);
    state = undoStep(state)!.state;      // back to ''
    state = recordUndo(state, 'z', editGroup('', 'z')); // new burst
    expect(state.entries).toEqual(['', 'z']);
    expect(undoStep(state)!.value).toBe('');
    expect(canRedo(state)).toBe(false);
  });
});

describe('paste, delete and clear', () => {
  test('a right-click paste is its own undo step', () => {
    let state = recordUndo(createUndoState(''), 'pasted text', null);
    state = recordUndo(state, 'pasted text!', editGroup('pasted text', 'pasted text!'));
    expect(state.entries).toEqual(['', 'pasted text', 'pasted text!']);
    state = undoStep(state)!.state;
    expect(undoValue(state)).toBe('pasted text');
    state = undoStep(state)!.state;
    expect(undoValue(state)).toBe('');
  });

  test('a deletion burst undoes as one step', () => {
    let state = createUndoState('hello');
    state = recordUndo(state, 'hell', editGroup('hello', 'hell'));
    state = recordUndo(state, 'hel', editGroup('hell', 'hel'));
    state = recordUndo(state, 'he', editGroup('hel', 'he'));
    expect(state.entries).toEqual(['hello', 'he']);
    expect(undoStep(state)!.value).toBe('hello');
  });

  test('clearing the composer is one undo step', () => {
    const state = recordUndo(createUndoState('还没发出去的内容'), '', null);
    expect(state.entries).toEqual(['还没发出去的内容', '']);
    expect(undoStep(state)!.value).toBe('还没发出去的内容');
  });
});

describe('redo branch', () => {
  test('editing after an undo drops the forward entries', () => {
    // A typing burst, then a paste: two undo steps.
    let state = replay('', ['a', 'ab']);
    state = recordUndo(state, '插入的一段', null);
    expect(state.entries).toEqual(['', 'ab', '插入的一段']);
    state = undoStep(state)!.state;      // 'ab'
    state = undoStep(state)!.state;      // now at ''
    expect(canRedo(state)).toBe(true);
    state = recordUndo(state, 'x', editGroup('', 'x'));
    expect(canRedo(state)).toBe(false);
    expect(state.entries).toEqual(['', 'x']);
  });
});

describe('limits and safety', () => {
  test('keeps at most UNDO_LIMIT undo steps plus the base snapshot', () => {
    let state = createUndoState('');
    for (let step = 1; step <= UNDO_LIMIT + 25; step += 1) {
      state = recordUndo(state, `value-${step}`, null);
    }
    expect(state.entries).toHaveLength(UNDO_LIMIT + 1);
    expect(undoValue(state)).toBe(`value-${UNDO_LIMIT + 25}`);
    expect(state.entries[0]).toBe('value-25');
    let steps = 0;
    while (canUndo(state)) { state = undoStep(state)!.state; steps += 1; }
    expect(steps).toBe(UNDO_LIMIT);
    expect(undoValue(state)).toBe('value-25');
  });

  test('recording the same value again is a no-op', () => {
    const state = createUndoState('same');
    expect(recordUndo(state, 'same', null)).toBe(state);
    expect(recordUndo(state, 'same', 'typing')).toBe(state);
  });
});
