/**
 * Pure helpers behind the chat composer's right-click paste gesture.
 *
 * The DOM layer reads the clipboard and re-selects the textarea; everything
 * that decides the new text and caret position stays here so it can be tested
 * without a browser.
 */

export interface CaretInsertion {
  value: string;
  caret: number;
}

function clamp(position: number, max: number) {
  if (!Number.isFinite(position)) return max;
  return Math.max(0, Math.min(position, max));
}

/**
 * Insert `text` at the caret, replacing the selection when one is present.
 * An empty `text` (empty, non-text or denied clipboard) leaves the input
 * untouched and keeps the caret at the start of the current selection.
 */
export function insertAtCaret(input: { value: string; start: number; end: number; text: string }): CaretInsertion {
  const { value, text } = input;
  const from = clamp(Math.min(input.start, input.end), value.length);
  const to = clamp(Math.max(input.start, input.end), value.length);
  if (!text) return { value, caret: from };
  return { value: `${value.slice(0, from)}${text}${value.slice(to)}`, caret: from + text.length };
}

/** A clipboard read that may be unavailable, denied or non-textual. */
export type ClipboardReader = (() => Promise<string> | string) | undefined;

/**
 * Read clipboard plain text. Missing reader, a missing Clipboard API, a denied
 * permission or a non-string result all resolve to an empty string so the
 * caller can stay silent instead of surfacing an error.
 */
export async function readClipboardText(read: ClipboardReader): Promise<string> {
  if (!read) return '';
  try {
    const text = await read();
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}
