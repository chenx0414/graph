import { describe, expect, test } from 'vitest';
import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_IMAGE_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  addComposerAttachment,
  attachmentKind,
  attachmentPayload,
  attachmentSize,
  base64FromDataUrl,
  buildAttachment,
  clearComposerAttachments,
  imageMimeFor,
  isImageAttachment,
  noticeText,
  rejectionNotices,
  removeComposerAttachment,
  validateAttachment,
  type AttachmentCandidate,
  type AttachmentResult,
  type ChatAttachment,
} from '../../src/web/attachments.ts';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nT8AAAAASUVORK5CYII=';
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

function candidate(overrides: Partial<AttachmentCandidate> = {}): AttachmentCandidate {
  return { name: 'photo.png', type: 'image/png', size: 256, ...overrides };
}

function textCandidate(overrides: Partial<AttachmentCandidate> = {}): AttachmentCandidate {
  return { name: 'notes.md', type: 'text/markdown', size: 12, ...overrides };
}

function imageChip(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return { name: 'photo.png', type: 'image/png', size: 256, text: '', data: PNG_BASE64, preview: PNG_DATA_URL, ...overrides };
}

describe('① 附件分类', () => {
  test('图片白名单 png/jpeg/webp/gif 被接受并归一化 mime', () => {
    expect(attachmentKind(candidate({ name: 'a.png', type: 'image/png' }))).toBe('image');
    expect(attachmentKind(candidate({ name: 'a.jpg', type: 'image/jpeg' }))).toBe('image');
    expect(attachmentKind(candidate({ name: 'a.webp', type: 'image/webp' }))).toBe('image');
    expect(attachmentKind(candidate({ name: 'a.gif', type: 'image/gif' }))).toBe('image');
    expect(attachmentKind(candidate({ name: 'a.png', type: 'image/png; charset=binary' }))).toBe('image');
  });

  test('缺少 mime 时按扩展名识别图片', () => {
    expect(attachmentKind(candidate({ name: 'shot.PNG', type: '' }))).toBe('image');
    expect(attachmentKind(candidate({ name: 'shot.jpeg', type: 'application/octet-stream' }))).toBe('image');
    expect(imageMimeFor(candidate({ name: 'shot.JPG', type: '' }))).toBe('image/jpeg');
  });

  test('文本类文件按扩展名或 mime 接受', () => {
    for (const name of ['readme.md', 'notes.txt', 'data.csv', 'config.json', 'main.ts', 'app.py', 'query.sql']) {
      expect(attachmentKind({ name, type: '', size: 10 })).toBe('text');
    }
    expect(attachmentKind({ name: 'noext', type: 'text/plain', size: 10 })).toBe('text');
    expect(attachmentKind({ name: 'data', type: 'application/json', size: 10 })).toBe('text');
    expect(attachmentKind({ name: 'vector.svg', type: 'image/svg+xml', size: 10 })).toBe('text');
  });

  test('其他类型与不支持的图片格式被识别为拒绝', () => {
    expect(attachmentKind({ name: 'doc.pdf', type: 'application/pdf', size: 4 })).toBeNull();
    expect(attachmentKind({ name: 'doc.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 4 })).toBeNull();
    expect(attachmentKind({ name: 'scan.bmp', type: 'image/bmp', size: 4 })).toBeNull();
    expect(attachmentKind({ name: 'photo.tiff', type: 'image/tiff', size: 4 })).toBeNull();
  });
});

describe('② 校验与上限（拒绝必须有可见原因）', () => {
  test('接受的候选返回 kind', () => {
    expect(validateAttachment(imageChipCandidate(), [])).toEqual({ ok: true, kind: 'image' });
    expect(validateAttachment(textCandidate(), [])).toEqual({ ok: true, kind: 'text' });
  });

  test('不支持的 pdf/docx/bmp 给出具体原因', () => {
    expect(validateAttachment({ name: 'doc.pdf', type: 'application/pdf', size: 4 }, []))
      .toEqual({ ok: false, reason: '不支持的文件类型' });
    expect(validateAttachment({ name: 'doc.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 4 }, []))
      .toEqual({ ok: false, reason: '不支持的文件类型' });
    expect(validateAttachment({ name: 'scan.bmp', type: 'image/bmp', size: 4 }, []).ok).toBe(false);
    const bmp = validateAttachment({ name: 'scan.bmp', type: 'image/bmp', size: 4 }, []);
    expect(bmp.ok === false && bmp.reason).toMatch(/不支持的图片格式/);
  });

  test('图片单文件超过 5MB 被拒并说明上限', () => {
    const rejected = validateAttachment(candidate({ size: MAX_IMAGE_ATTACHMENT_BYTES + 1 }), []);
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.reason).toMatch(/5MB/);
  });

  test('单条消息图片总量超过 8MB 被拒，即使每张都小于 5MB', () => {
    const half = MAX_MESSAGE_IMAGE_BYTES / 2 + 1;
    const existing = [imageChip({ name: 'a.png', size: half })];
    const rejected = validateAttachment(imageChipCandidate({ name: 'b.png', size: half }), existing);
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.reason).toMatch(/8MB/);
  });

  test('文本附件单文件超过 1MB 被拒', () => {
    const rejected = validateAttachment(textCandidate({ size: MAX_TEXT_ATTACHMENT_BYTES + 1 }), []);
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.reason).toMatch(/1MB/);
  });

  test('超过附件数量上限与重复文件都被拒', () => {
    const full = Array.from({ length: MAX_ATTACHMENTS }, (_, index) =>
      imageChip({ name: `p${index}.png`, size: 100 }));
    expect(validateAttachment(imageChipCandidate({ name: 'extra.png' }), full).ok).toBe(false);
    const dup = validateAttachment(imageChipCandidate({ name: 'a.png', size: 100 }), [imageChip({ name: 'a.png', size: 100 })]);
    expect(dup.ok).toBe(false);
    expect(dup.ok === false && dup.reason).toMatch(/同名/);
  });

  function imageChipCandidate(overrides: Partial<AttachmentCandidate> = {}): AttachmentCandidate {
    return candidate({ name: 'photo.png', type: 'image/png', size: 256, ...overrides });
  }
});

describe('③ 由已读内容构造载荷', () => {
  test('图片从 DataURL 构造 base64 载荷并带本地预览', () => {
    const built = buildAttachment(candidate(), { dataUrl: PNG_DATA_URL });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.attachment).toEqual({
      name: 'photo.png', type: 'image/png', size: 256, text: '', data: PNG_BASE64, preview: PNG_DATA_URL,
    });
    expect(isImageAttachment(built.attachment)).toBe(true);
  });

  test('文本文件构造文本载荷', () => {
    const built = buildAttachment(textCandidate(), { text: '# Notes\n' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.attachment).toEqual({ name: 'notes.md', type: 'text/markdown', size: 12, text: '# Notes\n' });
    expect(isImageAttachment(built.attachment)).toBe(false);
  });

  test('含 NUL 字节的“文本”与读空的图片被拒', () => {
    const binary = buildAttachment(textCandidate(), { text: 'a\0b' });
    expect(binary.ok).toBe(false);
    expect(binary.ok === false && binary.reason).toMatch(/不是文本文件/);
    const empty = buildAttachment(candidate(), { dataUrl: '' });
    expect(empty.ok).toBe(false);
  });

  test('base64FromDataUrl 取出逗号之后的部分', () => {
    expect(base64FromDataUrl(PNG_DATA_URL)).toBe(PNG_BASE64);
    expect(base64FromDataUrl('not-a-data-url')).toBe('');
  });
});

describe('④ 发送载荷：文本→text，图片→data，且剥离本地预览', () => {
  const attachments: ChatAttachment[] = [
    { name: 'notes.md', type: 'text/markdown', size: 12, text: '# Notes\n' },
    imageChip(),
  ];

  test('文本附件作为 text、图片作为 data 上报', () => {
    expect(attachmentPayload(attachments)).toEqual([
      { name: 'notes.md', type: 'text/markdown', size: 12, text: '# Notes\n' },
      { name: 'photo.png', type: 'image/png', size: 256, text: '', data: PNG_BASE64 },
    ]);
  });

  test('预览 DataURL 绝不进入发送载荷（新对话入口同样走 attachmentPayload）', () => {
    const payload = attachmentPayload(attachments);
    expect(JSON.stringify(payload)).not.toContain('data:image/png;base64');
    for (const item of payload) expect(item).not.toHaveProperty('preview');
  });

  test('图片项的 data 是纯 base64（无 data: 前缀）且 text 为空', () => {
    const [image] = attachmentPayload([imageChip({ preview: PNG_DATA_URL })]);
    expect(image).toBeDefined();
    expect(image!.text).toBe('');
    expect(image!.data).toBe(PNG_BASE64);
    expect(image!.data!.startsWith('data:')).toBe(false);
    expect(image!.data).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  test('文本项带 text 且不带 data', () => {
    const [text] = attachmentPayload([{ name: 'notes.md', type: 'text/markdown', size: 12, text: '# Notes\n' }]);
    expect(text!.text).toBe('# Notes\n');
    expect(text).not.toHaveProperty('data');
  });
});

describe('⑤ 条目增删与发送后清空', () => {
  test('加入条目、按名称与大小去重', () => {
    let state = addComposerAttachment([], imageChip());
    expect(state).toHaveLength(1);
    state = addComposerAttachment(state, imageChip());
    expect(state).toHaveLength(1);
    state = addComposerAttachment(state, { name: 'notes.md', type: 'text/markdown', size: 12, text: 'hi' });
    expect(state.map(item => item.name)).toEqual(['photo.png', 'notes.md']);
  });

  test('可单独移除某个条目', () => {
    const state = [imageChip(), { name: 'notes.md', type: 'text/markdown', size: 12, text: 'hi' }] as ChatAttachment[];
    expect(removeComposerAttachment(state, { name: 'photo.png', size: 256 }).map(item => item.name)).toEqual(['notes.md']);
    expect(removeComposerAttachment(state, { name: 'missing.png', size: 1 })).toHaveLength(2);
  });

  test('发送后清空附件（附件不写入草稿持久化）', () => {
    const before = [imageChip(), { name: 'notes.md', type: 'text/markdown', size: 12, text: 'hi' }] as ChatAttachment[];
    expect(before).toHaveLength(2);
    expect(clearComposerAttachments()).toEqual([]);
  });
});

describe('⑥ 被拒文件的可见原因', () => {
  /** Mirror how the composer turns a validation decision into a notice. */
  function attempt(candidate: AttachmentCandidate, existing: readonly ChatAttachment[] = []): AttachmentResult {
    const decision = validateAttachment(candidate, existing);
    return decision.ok
      ? { name: candidate.name, accepted: true }
      : { name: candidate.name, accepted: false, reason: decision.reason };
  }

  test('不支持的 mime 逐条给出文件名与原因', () => {
    expect(rejectionNotices([attempt({ name: 'run.exe', type: 'application/x-msdownload', size: 10 })]))
      .toEqual(['run.exe：不支持的文件类型']);
    expect(rejectionNotices([attempt({ name: 'scan.bmp', type: 'image/bmp', size: 10 })])[0])
      .toMatch(/^scan\.bmp：不支持的图片格式/);
  });

  test('超限大小给出上限值（图片 >5MB、文本 >1MB）', () => {
    expect(rejectionNotices([attempt(candidate({ name: 'big.png', size: MAX_IMAGE_ATTACHMENT_BYTES + 1 }))]))
      .toEqual(['big.png：图片超过单文件 5MB 上限']);
    expect(rejectionNotices([attempt(textCandidate({ name: 'long.txt', size: MAX_TEXT_ATTACHMENT_BYTES + 1 }))]))
      .toEqual(['long.txt：文本附件超过单文件 1MB 上限']);
  });

  test('单条消息图片总量超限也逐条给出原因', () => {
    const half = MAX_MESSAGE_IMAGE_BYTES / 2 + 1;
    const existing = [imageChip({ name: 'a.png', size: half })];
    expect(rejectionNotices([attempt(candidate({ name: 'b.png', size: half }), existing)]))
      .toEqual(['b.png：单条消息的图片总量超过 8MB 上限（该文件未加入）']);
  });

  test('混合输入只列出被拒项，已接受的文件不出现', () => {
    const results = [
      attempt(candidate({ name: 'ok.png' })),
      attempt({ name: 'run.exe', type: 'application/x-msdownload', size: 10 }),
      attempt(candidate({ name: 'big.png', size: MAX_IMAGE_ATTACHMENT_BYTES + 1 })),
      attempt(textCandidate({ name: 'notes.md' })),
    ];
    const notices = rejectionNotices(results);
    expect(notices).toHaveLength(2);
    expect(notices).toEqual(['run.exe：不支持的文件类型', 'big.png：图片超过单文件 5MB 上限']);
    expect(notices.join('\n')).not.toContain('ok.png');
    expect(notices.join('\n')).not.toContain('notes.md');
    expect(noticeText(results)).toBe('run.exe：不支持的文件类型；big.png：图片超过单文件 5MB 上限');
  });

  test('全部接受时没有任何提示', () => {
    expect(rejectionNotices([attempt(candidate({ name: 'ok.png' }))])).toEqual([]);
    expect(noticeText([{ name: 'ok.png', accepted: true }])).toBe('');
  });

  test('大小文案覆盖 B / KB / MB', () => {
    expect(attachmentSize(512)).toBe('512 B');
    expect(attachmentSize(2048)).toBe('2.0 KB');
    expect(attachmentSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
