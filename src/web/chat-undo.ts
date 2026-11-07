
export const COMPOSER_UNDO_LIMIT = 100;

export type ComposerEditKind = 'typing' | 'paste' | 'delete' | 'clear' | 'insert';

export interface ComposerUndoState {
  past: string[];
  future: string[];
  lastKind: ComposerEditKind | null;
}

export function createComposerUndoState(): ComposerUndoState {
  return { past: [], future: [], lastKind: null };
}

function singleCharacterChange(previous: string, next: string): boolean {
  if (Math.abs(previous.length - next.length) !== 1) return false;
  const shorter = previous.length < next.length ? previous : next;
  const longer = previous.length < next.length ? next : previous;
  let index = 0;
  while (index < shorter.length && shorter[index] === longer[index]) index += 1;
  return shorter.slice(index) === longer.slice(index + 1);
}

export function recordComposerEdit(
  state: ComposerUndoState,
  previous: string,
  next: string,
  kind: ComposerEditKind = 'typing',
): ComposerUndoState {
  if (previous === next) return state;
  if (kind === 'typing' && state.lastKind === 'typing' && singleCharacterChange(previous, next)) {
    return { past: state.past, future: [], lastKind: 'typing' };
  }
  const past = [...state.past, previous];
  if (past.length > COMPOSER_UNDO_LIMIT) past.splice(0, past.length - COMPOSER_UNDO_LIMIT);
  return { past, future: [], lastKind: kind };
}

export interface ComposerUndoResult {
  state: ComposerUndoState;
  value: string;
}

export function undoComposer(state: ComposerUndoState, current: string): ComposerUndoResult | null {
  if (!state.past.length) return null;
  const value = state.past[state.past.length - 1]!;
  return {
    state: {
      past: state.past.slice(0, -1),
      future: [...state.future, current],
      lastKind: null,
    },
    value,
  };
}

export function redoComposer(state: ComposerUndoState, current: string): ComposerUndoResult | null {
  if (!state.future.length) return null;
  const value = state.future[state.future.length - 1]!;
  const past = [...state.past, current];
  if (past.length > COMPOSER_UNDO_LIMIT) past.splice(0, past.length - COMPOSER_UNDO_LIMIT);
  return {
    state: { past, future: state.future.slice(0, -1), lastKind: null },
    value,
  };
}

export function composerEditKind(previous: string, next: string): ComposerEditKind {
  if (next.length === 0) return 'clear';
  if (next.length < previous.length) return 'delete';
  if (next.length - previous.length > 1) return 'paste';
  return 'typing';
}
