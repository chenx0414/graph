
export interface CaretInsertion {
  value: string;
  caret: number;
}

function clamp(position: number, max: number) {
  if (!Number.isFinite(position)) return max;
  return Math.max(0, Math.min(position, max));
}

export function insertAtCaret(input: { value: string; start: number; end: number; text: string }): CaretInsertion {
  const { value, text } = input;
  const from = clamp(Math.min(input.start, input.end), value.length);
  const to = clamp(Math.max(input.start, input.end), value.length);
  if (!text) return { value, caret: from };
  return { value: `${value.slice(0, from)}${text}${value.slice(to)}`, caret: from + text.length };
}

export type ClipboardReader = (() => Promise<string> | string) | undefined;

export interface ClipboardRead {
  text: string;
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
