import type { ImageContent } from '@earendil-works/pi-ai';
import { RuntimeError, type AttachmentInput, type Json } from './types.ts';

/**
 * Attachment contract shared by the request layer, the ledger projection and
 * the Agent delivery path. It stays pure (no fs, no DOM, no store) so both the
 * runtime and the console checks can exercise it directly.
 *
 * Text attachments keep the historical `AttachmentInput.text` shape. Images are
 * carried as base64 in `data` with a mime `type`; they are never written to
 * disk and never round-trip back to the client (the view only sees metadata).
 */
export const MAX_ATTACHMENTS = 5;
export const MAX_TEXT_ATTACHMENT_BYTES = 1_048_576;
export const MAX_TEXT_ATTACHMENTS_TOTAL_BYTES = 5_242_880;
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_ATTACHMENT_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function isImageAttachmentType(type: string): boolean {
  return IMAGE_ATTACHMENT_TYPES.includes(type.trim().toLowerCase());
}

/** An image attachment carries base64 bytes; a text attachment never does. */
export function isImageAttachment(attachment: AttachmentInput): boolean {
  return typeof attachment.data === 'string' && attachment.data.length > 0;
}

function hasBase64Shape(data: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(data);
}

/** Reject, never silently drop: every limit produces a concrete RuntimeError
 * the request layer turns into a visible reason for the user. */
export function cleanAttachments(input: AttachmentInput[] | undefined): AttachmentInput[] {
  const attachments = input ?? [];
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new RuntimeError('invalid_input', `A message can contain at most ${MAX_ATTACHMENTS} attachments`);
  }
  let totalTextBytes = 0;
  let totalImageBytes = 0;
  return attachments.map(attachment => {
    if (!attachment || typeof attachment.name !== 'string' || !attachment.name.trim() || attachment.name.length > 240) {
      throw new RuntimeError('invalid_input', 'Attachment names must be nonempty and bounded');
    }
    if (typeof attachment.type !== 'string' || attachment.type.length > 160) {
      throw new RuntimeError('invalid_input', `Attachment ${attachment.name} is missing its type`);
    }
    const name = attachment.name.trim();
    if (isImageAttachmentType(attachment.type)) {
      if (typeof attachment.data !== 'string' || !attachment.data.trim()) {
        throw new RuntimeError('invalid_input', `图片 ${name} 缺少图片数据`);
      }
      if (!hasBase64Shape(attachment.data)) {
        throw new RuntimeError('invalid_input', `图片 ${name} 不是有效的 base64 数据`);
      }
      if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        throw new RuntimeError('invalid_input', `图片 ${name} 超过单文件 5 MiB 上限`);
      }
      // base64 inflates the raw size by ~4/3; reject a body whose payload
      // cannot decode back to the declared size class.
      if (attachment.data.length > Math.ceil(MAX_IMAGE_ATTACHMENT_BYTES * 4 / 3) + 8) {
        throw new RuntimeError('invalid_input', `图片 ${name} 超过单文件 5 MiB 上限`);
      }
      totalImageBytes += attachment.size;
      if (totalImageBytes > MAX_MESSAGE_IMAGE_BYTES) {
        throw new RuntimeError('invalid_input', '单条消息的图片总大小超过 8 MiB 上限');
      }
      return { name, type: attachment.type.trim().toLowerCase(), size: attachment.size, text: '', data: attachment.data };
    }
    if (typeof attachment.text !== 'string') {
      throw new RuntimeError('invalid_input', `附件 ${name} 的文本内容缺失`);
    }
    // A payload carrying base64 that is not a whitelisted image (pdf, docx,
    // bmp, ...) is unsupported this round; refuse it instead of dropping the
    // bytes and keeping an empty text attachment.
    if (typeof attachment.data === 'string' && attachment.data.length > 0) {
      throw new RuntimeError('invalid_input', `不支持的附件类型：${attachment.type}`);
    }
    const bytes = Buffer.byteLength(attachment.text, 'utf8');
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > MAX_TEXT_ATTACHMENT_BYTES || bytes > MAX_TEXT_ATTACHMENT_BYTES) {
      throw new RuntimeError('invalid_input', `附件 ${name} 超过单文件 1 MiB 文本上限`);
    }
    totalTextBytes += bytes;
    if (totalTextBytes > MAX_TEXT_ATTACHMENTS_TOTAL_BYTES) {
      throw new RuntimeError('invalid_input', '文本类附件合计超过 5 MiB 上限');
    }
    if (attachment.text.includes('\0')) {
      throw new RuntimeError('invalid_input', `附件 ${name} 不是文本文件`);
    }
    return { name, type: attachment.type, size: attachment.size, text: attachment.text };
  });
}

/** The prompt-side mapping: text attachments stay in the briefing, images
 * become SDK `ImageContent` passed as `prompt(text, { images })`. */
export function promptImagesFromAttachments(attachments: readonly AttachmentInput[] | null | undefined): ImageContent[] {
  const images: ImageContent[] = [];
  for (const attachment of attachments ?? []) {
    if (!isImageAttachment(attachment)) continue;
    images.push({ type: 'image', data: attachment.data!, mimeType: attachment.type });
  }
  return images;
}

/** Strip image base64 from one message `data` payload before it crosses the
 * API/stream boundary. Text attachments keep their text; image attachments
 * keep only metadata. */
export function stripAttachmentData(data: Json): Json {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const record = data as Record<string, Json>;
  if (!Array.isArray(record.attachments)) return data;
  return {
    ...record,
    attachments: record.attachments.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const { data: _payload, ...rest } = item as Record<string, Json>;
      return rest as Json;
    }),
  };
}
