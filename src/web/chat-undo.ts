/**
 * Pure undo/redo stack behind the composer's ⌘Z / ⇧⌘Z.
 *
 * React writes the textarea value programmatically, so the browser never sees
 * a native edit and its built-in undo history is dead. The composer therefore
 * owns an explicit stack of value snapshots; every rule lives here so it can be
 * verified without a browser.
 */

/** Snapshots kept in each direction. The 101st edit drops the oldest one. */
export const COMPOSER_UNDO_LIMIT = 100;

/**
 * Why a value changed. A run of `typing` edits coalesces into one step so a
 * sentence typed by hand undoes as a unit, while paste/delete/clear are always
 * their own step.
 */
export type ComposerEditKind = 'typing' | 'paste' | 'delete' | 'clear' | 'insert';

export interface ComposerUndoState {
  /** Snapshots older → newer; the last entry is the value right before the current one. */
  past: string[];
  /** Values undone from newest to oldest; surviving edits clear this. */
  future: string[];
  /** The kind that produced the current value, used to coalesce a typed run. */
  lastKind: ComposerEditKind | null;
}

export function createComposerUndoState(): ComposerUndoState {
  return { past: [], future: [], lastKind: null };
}

/** True when the two values differ by exactly one inserted or deleted character. */
function singleCharacterChange(previous: string, next: string): boolean {
  if (Math.abs(previous.length - next.length) !== 1) return false;
  const shorter = previous.length < next.length ? previous : next;
  const longer = previous.length < next.length ? next : previous;
  let index = 0;
  while (index < shorter.length && shorter[index] === longer[index]) index += 1;
  return shorter.slice(index) === longer.slice(index + 1);
}

/**
 * Record an edit from `previous` to `next`. A one-character typing continuation
 * keeps the snapshot the run started from; anything else appends `previous`.
 * Every outcome invalidates the redo branch.
 */
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

/** Step back one edit, or `null` when there is nothing left to undo. */
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

/** Reapply the newest undone edit, or `null` when there is nothing to redo. */
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

/** Classify an edit by how the text changed, for snapshot bookkeeping. */
export function composerEditKind(previous: string, next: string): ComposerEditKind {
  if (next.length === 0) return 'clear';
  if (next.length < previous.length) return 'delete';
  if (next.length - previous.length > 1) return 'paste';
  return 'typing';
}
