import type { TranscriptRow } from './transcript-model.ts';

export type ClipboardWriter = {
  writeText(text: string): Promise<void>;
};

export type CopyNotice = (message: string, tone: 'success' | 'danger') => void;

export function copyText(row: TranscriptRow): string {
  if (row.kind === 'assistant') return row.streaming ? '' : row.text;
  if (row.kind === 'message' && row.message.role === 'user') return row.message.text;
  return '';
}

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
