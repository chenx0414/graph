/**
 * Explicit undo/redo history for the chat composer.
 *
 * The textarea is a controlled React input: every keystroke is written back
 * through `onChange`, which discards the browser's native undo stack. This
 * module keeps the snapshots itself, so Cmd+Z / Cmd+Shift+Z keep working.
 *
 * The rules live here (no DOM, no React) so they can be verified without a
 * browser: a snapshot is pushed for every edit; adjacent single-character
 * keystrokes of the same kind coalesce into one undo step; pastes, clears and
 * multi-character changes always start a new step; and editing after an undo
 * drops the redo branch.
 */

/** Coalescing bucket for adjacent single-character edits. */
export type EditGroup = 'typing' | 'deleting';

/**
 * Maximum number of undo steps retained. The base snapshot is additional, so a
 * full stack holds `UNDO_LIMIT + 1` values and can be undone `UNDO_LIMIT` times.
 */
export const UNDO_LIMIT = 100;

export interface UndoState {
  /** Snapshots oldest → newest; the entry at `index` is the live value. */
  entries: string[];
  /** Position of the live value inside `entries`. */
  index: number;
  /** Coalescing bucket of the live entry, or null when it is closed. */
  group: EditGroup | null;
}

export function createUndoState(initial = ''): UndoState {
  return { entries: [initial], index: 0, group: null };
}

/** The current live value of the stack. */
export function undoValue(state: UndoState): string {
  return state.entries[state.index] ?? '';
}

export function canUndo(state: UndoState): boolean {
  return state.index > 0;
}

export function canRedo(state: UndoState): boolean {
  return state.index < state.entries.length - 1;
}

/**
 * Classify a plain value change so adjacent keystrokes coalesce:
 * a one-character append is `typing`, a one-character removal from the same
 * spot is `deleting`. Newlines, pastes, clears, multi-character edits and any
 * non-prefix change return null and therefore start a fresh undo step.
 */
export function editGroup(previous: string, next: string): EditGroup | null {
  if (next === previous) return null;
  if (next.length === previous.length + 1 && next.startsWith(previous)) {
    return next.endsWith('\n') ? null : 'typing';
  }
  if (previous.length === next.length + 1 && previous.startsWith(next)) {
    return next.endsWith('\n') ? null : 'deleting';
  }
  return null;
}

function capped(entries: string[], index: number, group: EditGroup | null): UndoState {
  let kept = entries;
  let position = index;
  while (kept.length > UNDO_LIMIT + 1) {
    kept = kept.slice(1);
    position -= 1;
  }
  return { entries: kept, index: Math.max(0, position), group };
}

/**
 * Record a new live value from an edit. `group` lets consecutive keystrokes of
 * the same kind collapse into one undo step; `null` (paste, clear, history
 * recall, external change) always starts a new step. The previous value is
 * never mutated.
 */
export function recordUndo(state: UndoState, value: string, group: EditGroup | null = null): UndoState {
  if (value === undoValue(state)) return state;
  if (state.index < state.entries.length - 1) {
    // Editing after an undo drops the redo branch.
    return capped([...state.entries.slice(0, state.index + 1), value], state.index + 1, group);
  }
  if (group !== null && state.group === group) {
    const entries = [...state.entries];
    entries[state.index] = value;
    return { entries, index: state.index, group };
  }
  return capped([...state.entries, value], state.entries.length, group);
}

/** Step one edit back; null when there is nothing to undo. */
export function undoStep(state: UndoState): { state: UndoState; value: string } | null {
  if (!canUndo(state)) return null;
  const index = state.index - 1;
  // Close the coalescing bucket so new typing starts a fresh step.
  return { state: { ...state, index, group: null }, value: state.entries[index]! };
}

/** Step one edit forward; null when there is nothing to redo. */
export function redoStep(state: UndoState): { state: UndoState; value: string } | null {
  if (!canRedo(state)) return null;
  const index = state.index + 1;
  return { state: { ...state, index, group: null }, value: state.entries[index]! };
}
