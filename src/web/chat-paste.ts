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

export interface ClipboardRead {
  /** Plain text from the clipboard; empty when there is nothing to insert. */
  text: string;
  /**
   * The clipboard could not be read at all (no reader, no Clipboard API, a denied permission or a
   * non-textual result) rather than simply being empty. A blocked read is a capability problem the
   * user can act on, so the caller may report it; an empty clipboard stays silent.
   */
  blocked: boolean;
}

export async function readClipboardText(read: ClipboardReader): Promise<ClipboardRead> {
  if (!read) return { text: '', blocked: true };
  try {
    const text = await read();
    return typeof text === 'string' ? { text, blocked: false } : { text: '', blocked: true };
  } catch {
    return { text: '', blocked: true };
  }
}
