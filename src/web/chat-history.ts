/**
 * ↑/↓ recall of already-sent prompts in the chat composer.
 *
 * The rules live here (no DOM, no React) so they can be verified without a
 * browser: the unsent draft is remembered before the first ↑ and restored by ↓
 * past the newest entry; recall stops at the earliest prompt; history is built
 * only from the user's sent messages, oldest first.
 */

export interface HistoryState {
  /** Index into the recall list, or null while showing the live draft. */
  index: number | null;
  /** The unsent value captured when navigation started. */
  saved: string;
}

export interface RecalledValue {
  state: HistoryState;
  value: string;
}

/** A message shape that carries the fields history cares about. */
export interface HistoryMessage {
  role: string;
  text?: string;
  kind?: string;
  state?: string;
}

export function createHistoryState(): HistoryState {
  return { index: null, saved: '' };
}

/** True while the composer is showing a recalled prompt rather than the draft. */
export function isNavigating(state: HistoryState): boolean {
  return state.index !== null;
}

/**
 * Sent user prompts of one conversation, oldest first. Briefings and messages
 * that were queued or cancelled were never sent by hand, so they are ignored;
 * an immediately repeated prompt is folded into one entry.
 */
export function sentPrompts(messages: HistoryMessage[]): string[] {
  const prompts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (message.kind === 'briefing') continue;
    if (message.state === 'queued' || message.state === 'cancelled') continue;
    const text = (message.text ?? '').trim();
    if (!text) continue;
    if (prompts[prompts.length - 1] === text) continue;
    prompts.push(text);
  }
  return prompts;
}

/**
 * Whether the arrow key should recall history instead of moving the caret.
 * A single-line composer always recalls; a multi-line draft only recalls from
 * the first line (↑) or the last line (↓), so normal caret movement still works
 * in the middle of a draft.
 */
export function shouldRecallHistory(direction: 'older' | 'newer', value: string, cursor: number): boolean {
  const firstBreak = value.indexOf('\n');
  if (firstBreak === -1) return true;
  if (direction === 'older') return cursor <= firstBreak;
  const lastBreak = value.lastIndexOf('\n');
  return cursor >= lastBreak + 1;
}

/** Recall the previous (older) prompt. Null when there is nothing older. */
export function recallOlder(state: HistoryState, prompts: string[], current: string): RecalledValue | null {
  if (!prompts.length) return null;
  if (state.index === null) {
    const index = prompts.length - 1;
    return { state: { index, saved: current }, value: prompts[index]! };
  }
  if (state.index <= 0 || state.index >= prompts.length) return null;
  const index = state.index - 1;
  return { state: { ...state, index }, value: prompts[index]! };
}

/** Recall the next (newer) prompt; past the newest it returns the saved draft. */
export function recallNewer(state: HistoryState, prompts: string[], _current?: string): RecalledValue | null {
  if (state.index === null) return null;
  if (state.index >= prompts.length - 1) {
    return { state: createHistoryState(), value: state.saved };
  }
  const index = state.index + 1;
  return { state: { ...state, index }, value: prompts[index]! };
}
