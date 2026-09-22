/**
 * Pure rules behind the composer's ↑/↓ prompt history.
 *
 * The composer only wires keyboard events and text; deciding what "one step
 * back in history" means, when to remember the draft and where the earliest
 * prompt is stays here so it can be tested without a browser.
 */

/** Remembered prompts per composer session. Older prompts fall off the front. */
export const COMPOSER_HISTORY_LIMIT = 100;

export interface ComposerHistoryState {
  /** Sent prompts oldest → newest. */
  entries: string[];
  /** `null` while editing the live draft; `0` is the newest prompt, larger is older. */
  cursor: number | null;
  /** The draft that was in the box when browsing started, restored on the way down. */
  draft: string;
}

function normalizeEntries(entries: string[]): string[] {
  const normalized: string[] = [];
  for (const entry of entries) {
    const value = entry.trim();
    if (!value || normalized[normalized.length - 1] === value) continue;
    normalized.push(value);
  }
  return normalized.slice(-COMPOSER_HISTORY_LIMIT);
}

export function createComposerHistoryState(entries: string[] = []): ComposerHistoryState {
  return { entries: normalizeEntries(entries), cursor: null, draft: '' };
}

/**
 * Remember one sent prompt. Consecutive duplicates collapse, the newest value
 * wins, and browsing resets because the box is empty right after a send.
 */
export function recordComposerPrompt(state: ComposerHistoryState, prompt: string): ComposerHistoryState {
  const value = prompt.trim();
  if (!value) return { entries: state.entries, cursor: null, draft: '' };
  const entries = state.entries[state.entries.length - 1] === value
    ? state.entries
    : [...state.entries, value].slice(-COMPOSER_HISTORY_LIMIT);
  return { entries, cursor: null, draft: '' };
}

/** A user edit leaves the browsing position but keeps the remembered prompts. */
export function resetComposerHistory(state: ComposerHistoryState): ComposerHistoryState {
  return state.cursor === null ? state : { entries: state.entries, cursor: null, draft: '' };
}

export interface ComposerHistoryMove {
  state: ComposerHistoryState;
  value: string;
}

/**
 * Move to an older prompt. The first ↑ out of the draft saves the draft and
 * shows the newest prompt; at the oldest prompt it returns `null` so the key
 * falls back to the caret moving.
 */
export function composerHistoryUp(state: ComposerHistoryState, liveValue: string): ComposerHistoryMove | null {
  if (!state.entries.length) return null;
  if (state.cursor === null) {
    const cursor = 0;
    return {
      state: { entries: state.entries, cursor, draft: liveValue },
      value: state.entries[state.entries.length - 1 - cursor]!,
    };
  }
  if (state.cursor >= state.entries.length - 1) return null;
  const cursor = state.cursor + 1;
  return {
    state: { ...state, cursor },
    value: state.entries[state.entries.length - 1 - cursor]!,
  };
}

/**
 * Move to a newer prompt, and past the newest back to the remembered draft.
 * `null` while already on the draft.
 */
export function composerHistoryDown(state: ComposerHistoryState): ComposerHistoryMove | null {
  if (state.cursor === null) return null;
  if (state.cursor <= 0) {
    return { state: { entries: state.entries, cursor: null, draft: '' }, value: state.draft };
  }
  const cursor = state.cursor - 1;
  return {
    state: { ...state, cursor },
    value: state.entries[state.entries.length - 1 - cursor]!,
  };
}

/** The prompt the cursor points at, for tests and hints. */
export function composerHistoryValue(state: ComposerHistoryState): string | null {
  if (state.cursor === null) return null;
  return state.entries[state.entries.length - 1 - state.cursor] ?? null;
}
