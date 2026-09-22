import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  cleanAttachments,
  isImageAttachment,
  promptImagesFromAttachments,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_IMAGE_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
} from '../../src/core/attachments.ts';
import { briefing } from '../../src/catalog/briefing.ts';
import { sdkPromptOptions } from '../../src/runtime/prompt-options.ts';
import { appendMessage, listMessages, publicMessage, type MessageRow } from '../../src/core/conversation.ts';
import { TaskStore } from '../../src/core/store.ts';
import type { AttachmentInput, Json, Operation } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nT8AAAAASUVORK5CYII=',
  'base64',
);
const PNG_BASE64 = PNG.toString('base64');

function textAttachment(overrides: Partial<AttachmentInput> = {}): AttachmentInput {
  return { name: 'notes.md', type: 'text/markdown', size: 8, text: '# Notes\n', ...overrides };
}

function imageAttachment(overrides: Partial<AttachmentInput> = {}): AttachmentInput {
  return { name: 'photo.png', type: 'image/png', size: PNG.length, text: '', data: PNG_BASE64, ...overrides };
}

test('a text attachment keeps its text and contributes no images', () => {
  const cleaned = cleanAttachments([textAttachment()]);
  expect(cleaned).toEqual([{ name: 'notes.md', type: 'text/markdown', size: 8, text: '# Notes\n' }]);
  expect(promptImagesFromAttachments(cleaned)).toEqual([]);
  expect(isImageAttachment(cleaned[0]!)).toBe(false);

  const operation: Operation = {
    id: 'operation', taskId: 'task', nodeId: 'master', instanceId: 'instance', generation: 1,
    attempt: 1, kind: 'agent', action: 'master', input: null, dependencies: {}, proposalVersion: 0,
    requirementVersion: 1,
    context: { previousOutput: null, answers: [], messages: [{ text: '请查看', requirementVersion: 1, attachments: cleaned }] },
    grants: [], activationId: 'activation', graphVersion: 0, dependencySources: {}, inputVersions: {},
  };
  const text = briefing(operation, { request: 'request', acceptance: [] });
  expect(text).toContain('notes.md (8 bytes, text/markdown)');
  expect(text).toContain('# Notes');
});

test('an image attachment maps to SDK ImageContent with its mime and base64', () => {
  const cleaned = cleanAttachments([imageAttachment()]);
  expect(cleaned).toEqual([{ name: 'photo.png', type: 'image/png', size: PNG.length, text: '', data: PNG_BASE64 }]);
  expect(isImageAttachment(cleaned[0]!)).toBe(true);
  expect(promptImagesFromAttachments(cleaned)).toEqual([
    { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
  ]);
});

test('a mixed message maps text to the briefing and images to ImageContent', () => {
  const cleaned = cleanAttachments([textAttachment(), imageAttachment({ name: 'diagram.webp', type: 'image/webp' })]);
  const images = promptImagesFromAttachments(cleaned);
  expect(images).toHaveLength(1);
  expect(images[0]).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/webp' });
  const operation: Operation = {
    id: 'operation', taskId: 'task', nodeId: 'master', instanceId: 'instance', generation: 1,
    attempt: 1, kind: 'agent', action: 'master', input: null, dependencies: {}, proposalVersion: 0,
    requirementVersion: 1,
    context: { previousOutput: null, answers: [], messages: [{ text: '看看', requirementVersion: 1, attachments: cleaned }] },
    grants: [], activationId: 'activation', graphVersion: 0, dependencySources: {}, inputVersions: {},
  };
  const text = briefing(operation, { request: 'request', acceptance: [] });
  expect(text).toContain('# Notes');
  expect(text).toContain('diagram.webp');
  // The briefing names the image but must never inline its bytes.
  expect(text).not.toContain(PNG_BASE64);
});

test('unsupported types and over-limit payloads are rejected with a visible reason', () => {
  // An image mime outside the whitelist still carries data: it must be refused,
  // never silently downgraded to an empty text attachment.
  expect(() => cleanAttachments([{ name: 'scan.bmp', type: 'image/bmp', size: 4, text: '', data: PNG_BASE64 }]))
    .toThrow(/不支持的附件类型/);
  expect(() => cleanAttachments([{ name: 'doc.pdf', type: 'application/pdf', size: 4, text: '', data: PNG_BASE64 }]))
    .toThrow(/不支持的附件类型/);

  // A whitelisted image without base64 data is incomplete.
  expect(() => cleanAttachments([{ name: 'photo.png', type: 'image/png', size: PNG.length, text: '' }]))
    .toThrow(/缺少图片数据/);

  // Single-image ceiling: 5 MiB.
  expect(() => cleanAttachments([imageAttachment({ size: MAX_IMAGE_ATTACHMENT_BYTES + 1 })]))
    .toThrow(/5 MiB/);

  // Per-message image ceiling: 8 MiB, even when each file is under 5 MiB.
  const largeHalf = MAX_MESSAGE_IMAGE_BYTES / 2 + 1;
  expect(() => cleanAttachments([
    imageAttachment({ name: 'a.png', size: largeHalf }),
    imageAttachment({ name: 'b.png', size: largeHalf }),
  ])).toThrow(/8 MiB/);

  // Text ceiling: 1 MiB per file.
  expect(() => cleanAttachments([textAttachment({ size: MAX_TEXT_ATTACHMENT_BYTES + 1, text: 'x'.repeat(MAX_TEXT_ATTACHMENT_BYTES + 1) })]))
    .toThrow(/1 MiB/);

  // A NUL byte is not a text file.
  expect(() => cleanAttachments([textAttachment({ text: 'a\0b' })])).toThrow(/不是文本文件/);
});

test('sdkPromptOptions puts images inside PromptOptions so the SDK receives them', () => {
  // A text-only prompt passes no options at all; the SDK falls back to its
  // default. This is the exact shape AgentSession.prompt(text, options?) wants.
  expect(sdkPromptOptions(undefined)).toBeUndefined();
  expect(sdkPromptOptions([])).toBeUndefined();

  const images = promptImagesFromAttachments(cleanAttachments([imageAttachment()]));
  const options = sdkPromptOptions(images);
  expect(options).toEqual({ images });
  expect(options).toEqual({ images: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }] });
  // The images live under `options.images`, never as a bare second argument.
  expect(options?.images).toBe(images);
});

test('the ledger keeps image base64 but the message view returns metadata only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-attachments-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
  store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,phase,created_seq,conversation_id) VALUES(?,?,?,?,?,?,?)')
    .run('t', 'p', 'request', 1, 'chatting', 1, 'c');
  store.db.prepare('INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('c', 'p', 'p', 't', 'title', 1, Date.now());

  const attachments = cleanAttachments([textAttachment(), imageAttachment()]);
  appendMessage(store, { conversationId: 'c', role: 'user', kind: 'chat', text: '请看附件', data: { attachments } as unknown as Json });

  // The durable ledger row still carries the base64 payload ...
  const raw = store.db.prepare('SELECT data FROM messages WHERE conversation_id=?').get('c') as { data: string };
  expect(raw.data).toContain(PNG_BASE64);

  // ... but the read projection only exposes name/type/size.
  const [message] = listMessages(store, 'c');
  const viewAttachments = (message!.data as { attachments: Record<string, unknown>[] }).attachments;
  expect(viewAttachments).toEqual([
    { name: 'notes.md', type: 'text/markdown', size: 8, text: '# Notes\n' },
    { name: 'photo.png', type: 'image/png', size: PNG.length, text: '' },
  ]);
  expect(viewAttachments[1]).not.toHaveProperty('data');
  expect(JSON.stringify(message)).not.toContain(PNG_BASE64);

  // The event projection and the direct publicMessage helper agree.
  const row = store.db.prepare('SELECT * FROM messages WHERE conversation_id=?').get('c') as unknown as MessageRow;
  expect(JSON.stringify(publicMessage(row))).not.toContain(PNG_BASE64);
});
