
export const COMPOSER_HISTORY_LIMIT = 100;

export interface ComposerHistoryState {
  entries: string[];
  cursor: number | null;
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

export function recordComposerPrompt(state: ComposerHistoryState, prompt: string): ComposerHistoryState {
  const value = prompt.trim();
  if (!value) return { entries: state.entries, cursor: null, draft: '' };
  const entries = state.entries[state.entries.length - 1] === value
    ? state.entries
    : [...state.entries, value].slice(-COMPOSER_HISTORY_LIMIT);
  return { entries, cursor: null, draft: '' };
}

export function resetComposerHistory(state: ComposerHistoryState): ComposerHistoryState {
  return state.cursor === null ? state : { entries: state.entries, cursor: null, draft: '' };
}

export function submitComposerPrompt(
  state: ComposerHistoryState,
  prompt: string,
  parentOwned = false,
): ComposerHistoryState {
  const reset = resetComposerHistory(state);
  return parentOwned ? reset : recordComposerPrompt(reset, prompt);
}

export interface ComposerHistoryMove {
  state: ComposerHistoryState;
  value: string;
}

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
