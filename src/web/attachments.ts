/**
 * Pure attachment rules for the console composer.
 *
 * This module owns classification, validation and payload shaping for the
 * composer's paste/drop/attach gesture. It never touches the DOM: the React
 * component reads clipboard/drop files, hands over their metadata and already
 * read content, and renders whatever this module decides. Keeping it pure is
 * what lets the sandbox check exercise every rule without a browser.
 *
 * The wire shape matches `AttachmentInput` in `src/core/types.ts`: text files
 * reuse `text`, images carry base64 in `data` with a whitelisted image mime and
 * an empty `text`. `preview` is a local DataURL for the composer chip only and
 * is stripped before the payload is sent.
 */

export interface ChatAttachment {
  name: string;
  type: string;
  size: number;
  text: string;
  /** Image payload as base64 (no `data:` prefix). Absent for text files. */
  data?: string;
  /** Local DataURL preview shown above the input. Never sent to the server. */
  preview?: string;
}

/** The metadata every paste/drop/file-picker event provides. */
export interface AttachmentCandidate {
  name: string;
  type: string;
  size: number;
}

/** The JSON body shape accepted by the message endpoints. */
export interface AttachmentPayload {
  name: string;
  type: string;
  size: number;
  text: string;
  data?: string;
}

export const MAX_ATTACHMENTS = 5;
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_TEXT_ATTACHMENTS_TOTAL_BYTES = 5 * 1024 * 1024;
export const IMAGE_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'text', 'rst', 'org',
  'json', 'jsonl', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'csv', 'tsv', 'log',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'css', 'scss', 'less', 'sass',
  'html', 'htm', 'xml', 'svg', 'vue', 'svelte',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'sql', 'graphql', 'gql', 'proto', 'patch', 'diff',
]);

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/javascript',
  'application/x-httpd-php',
  'application/sql',
  'image/svg+xml',
]);

export type AttachmentKind = 'image' | 'text';

export function normalizeMime(type: string): string {
  return (type ?? '').split(';')[0]!.trim().toLowerCase();
}

export function fileExtension(name: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function isImageAttachmentType(type: string): boolean {
  return IMAGE_MIME_TYPES.includes(normalizeMime(type));
}

/** The canonical whitelisted mime for an image candidate, or null. */
export function imageMimeFor(candidate: AttachmentCandidate): string | null {
  const type = normalizeMime(candidate.type);
  if (isImageAttachmentType(type)) return type;
  return IMAGE_MIME_BY_EXTENSION[fileExtension(candidate.name)] ?? null;
}

/** SVG is text, not one of the whitelisted raster images. */
export function isSvgText(candidate: AttachmentCandidate): boolean {
  return normalizeMime(candidate.type) === 'image/svg+xml'
    || fileExtension(candidate.name) === 'svg';
}

/** Classify a candidate as an accepted kind, or null when unsupported. */
export function attachmentKind(candidate: AttachmentCandidate): AttachmentKind | null {
  const type = normalizeMime(candidate.type);
  if (isSvgText(candidate)) return 'text';
  if (isImageAttachmentType(type)) return 'image';
  // An explicit, non-whitelisted image (bmp, tiff, pdf-like scans) is refused
  // rather than downgraded, even when the extension looks harmless.
  if (type.startsWith('image/')) return null;
  if (IMAGE_MIME_BY_EXTENSION[fileExtension(candidate.name)]) return 'image';
  if (type.startsWith('text/') || TEXT_MIME_TYPES.has(type)) return 'text';
  if (TEXT_EXTENSIONS.has(fileExtension(candidate.name))) return 'text';
  return null;
}

export function textMimeFor(candidate: AttachmentCandidate): string {
  const type = normalizeMime(candidate.type);
  return type || 'text/plain';
}

export type AttachmentValidation =
  | { ok: true; kind: AttachmentKind }
  | { ok: false; reason: string };

/** Reject with a concrete, user-visible reason; never silently drop a file. */
export function validateAttachment(candidate: AttachmentCandidate, existing: readonly ChatAttachment[]): AttachmentValidation {
  const name = (candidate.name ?? '').trim() || '未命名文件';
  if (existing.length >= MAX_ATTACHMENTS) {
    return { ok: false, reason: `一条消息最多附加 ${MAX_ATTACHMENTS} 个文件` };
  }
  if (existing.some(item => item.name === name && item.size === candidate.size)) {
    return { ok: false, reason: `已添加同名文件：${name}` };
  }
  const kind = attachmentKind({ ...candidate, name });
  if (!kind) {
    if (normalizeMime(candidate.type).startsWith('image/')) {
      return { ok: false, reason: `不支持的图片格式：${candidate.type || fileExtension(name)}（仅支持 png/jpeg/webp/gif）` };
    }
    return { ok: false, reason: `不支持的文件类型：${name}` };
  }
  if (kind === 'image') {
    if (!Number.isFinite(candidate.size) || candidate.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      return { ok: false, reason: `图片 ${name} 超过单文件 5MB 上限` };
    }
    const total = existing.reduce((sum, item) => sum + (isImageAttachment(item) ? item.size : 0), 0) + candidate.size;
    if (total > MAX_MESSAGE_IMAGE_BYTES) {
      return { ok: false, reason: `单条消息的图片总量超过 8MB 上限（${name} 未加入）` };
    }
    return { ok: true, kind };
  }
  if (!Number.isFinite(candidate.size) || candidate.size > MAX_TEXT_ATTACHMENT_BYTES) {
    return { ok: false, reason: `文本附件 ${name} 超过单文件 1MB 上限` };
  }
  const textTotal = existing.reduce((sum, item) => sum + (isImageAttachment(item) ? 0 : item.size), 0) + candidate.size;
  if (textTotal > MAX_TEXT_ATTACHMENTS_TOTAL_BYTES) {
    return { ok: false, reason: `文本类附件合计超过 5MB 上限（${name} 未加入）` };
  }
  return { ok: true, kind };
}

export type AttachmentBuild =
  | { ok: true; attachment: ChatAttachment }
  | { ok: false; reason: string };

/** Strip the `data:*;base64,` prefix from a local preview URL. */
export function base64FromDataUrl(dataUrl: string): string {
  const comma = (dataUrl ?? '').indexOf(',');
  if (comma < 0) return '';
  return dataUrl.slice(comma + 1).replace(/\s/g, '');
}

/**
 * Build a composer attachment from already-read content. Images read a local
 * DataURL (base64 payload + preview); text files read their text and are
 * refused when the bytes are not text at all.
 */
export function buildAttachment(
  candidate: AttachmentCandidate,
  content: { text?: string; dataUrl?: string } = {},
): AttachmentBuild {
  const name = (candidate.name ?? '').trim() || '未命名文件';
  const kind = attachmentKind({ ...candidate, name });
  if (kind === 'image') {
    const dataUrl = content.dataUrl ?? '';
    const data = base64FromDataUrl(dataUrl);
    const mime = imageMimeFor({ ...candidate, name }) ?? 'image/png';
    if (!data) return { ok: false, reason: `无法读取图片 ${name}` };
    return {
      ok: true,
      attachment: { name, type: mime, size: candidate.size, text: '', data, preview: dataUrl },
    };
  }
  const text = content.text ?? '';
  if (text.includes('\0')) return { ok: false, reason: `${name} 不是文本文件` };
  return { ok: true, attachment: { name, type: textMimeFor({ ...candidate, name }), size: candidate.size, text } };
}

export function isImageAttachment(attachment: ChatAttachment): boolean {
  return typeof attachment.data === 'string' && attachment.data.length > 0;
}

/** The wire body for the message endpoints: drops the local `preview`. */
export function attachmentPayload(attachments: readonly ChatAttachment[]): AttachmentPayload[] {
  return attachments.map(attachment => {
    if (isImageAttachment(attachment)) {
      return { name: attachment.name, type: attachment.type, size: attachment.size, text: '', data: attachment.data! };
    }
    return { name: attachment.name, type: attachment.type, size: attachment.size, text: attachment.text };
  });
}

export function attachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 102_400 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Join rejection reasons for one visible toast. */
export function rejectionMessage(reasons: readonly string[]): string {
  if (!reasons.length) return '';
  if (reasons.length === 1) return reasons[0]!;
  const head = reasons.slice(0, 2).join('；');
  return reasons.length > 2 ? `${head}；另有 ${reasons.length - 2} 个文件被拒` : head;
}

export function addComposerAttachment(state: readonly ChatAttachment[], attachment: ChatAttachment): ChatAttachment[] {
  if (state.some(item => item.name === attachment.name && item.size === attachment.size)) return [...state];
  return [...state, attachment];
}

export function removeComposerAttachment(state: readonly ChatAttachment[], target: { name: string; size: number }): ChatAttachment[] {
  return state.filter(item => !(item.name === target.name && item.size === target.size));
}

/** Sending clears the chips; attachments are never written to the draft. */
export function clearComposerAttachments(): ChatAttachment[] {
  return [];
}
