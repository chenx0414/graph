import type { TranscriptRow } from './transcript-model.ts';

export type ClipboardWriter = {
  writeText(text: string): Promise<void>;
};

export type CopyNotice = (message: string, tone: 'success' | 'danger') => void;

/**
 * Original text of a transcript row, or an empty string when the row has no
 * copyable source. Agent rows copy the Markdown source carried by the transcript
 * row (not the rendered DOM); user rows copy the original input text. Rows that
 * are still streaming have no stable source yet.
 */
export function copyText(row: TranscriptRow): string {
  if (row.kind === 'assistant') return row.streaming ? '' : row.text;
  if (row.kind === 'message' && row.message.role === 'user') return row.message.text;
  return '';
}

/**
 * Write one message's original text to the clipboard. Every outcome is reported
 * through the existing toast channel; empty text is a silent no-op.
 */
export async function writeClipboardText(
  text: string,
  clipboard: ClipboardWriter,
  notify: CopyNotice,
): Promise<boolean> {
  if (!text) return false;
  try {
    await clipboard.writeText(text);
    notify('已复制到剪贴板', 'success');
    return true;
  } catch (reason) {
    notify(`复制失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    return false;
  }
}
