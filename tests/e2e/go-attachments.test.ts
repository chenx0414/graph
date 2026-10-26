import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * The attachment limits of a message.
 *
 * A user can send a file with a message. The product states the limits in
 * the file's own terms: a text file is at most 1 MiB, a message carries at
 * most 5 MiB of text, an image at most 5 MiB, and a message at most 8 MiB of
 * images. A file beyond a limit is refused with a message that names the
 * limit, and the message is not stored — a refused attachment is not a
 * half-sent one.
 *
 * The proof is the real Go process: a file that fits goes to the provider
 * with its text, a file that does not fit never reaches the provider and
 * leaves no message behind.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

const MIB = 1024 * 1024;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-attachments-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await openaiServer(Array.from({ length: 8 }, () => ({ text: 'Working on it.' })));
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_ATTACHMENT_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_ATTACHMENT_KEY: 'synthetic-attachment-key' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const conversation = async (text: string, requestId: string) => {
    const created = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text, requestId }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return (created.body as { conversationId: string }).conversationId;
  };
  return { root, daemon, request, conversation, provider };
}

test('a text file within the limit goes to the model with its text', async () => {
  const f = await fixture();
  const conversationId = await f.conversation('Start', 'conversation-1');

  const sent = await f.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      text: 'Read the attached notes',
      requestId: 'message-1',
      attachments: [{ name: 'notes.md', type: 'text/markdown', size: 7, text: '# Notes\n' }],
    }),
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);

  // The file's text reaches the model: the attachment is not dropped on the way.
  // The observation point is the provider request, because that is where the
  // file's text has to arrive for the model to read it.
  await expect.poll(() => f.provider.requests.some(request => {
    const body = request as { messages?: { role: string; content: unknown }[] };
    return body.messages?.some(message => message.role === 'user'
      && JSON.stringify(message.content).includes('# Notes')) ?? false;
  }), { timeout: 30_000, interval: 250 }).toBe(true);
}, 60_000);

test('a text file over the limit is refused and leaves no message behind', async () => {
  const f = await fixture();
  const conversationId = await f.conversation('Start', 'conversation-2');
  const before = await f.request(`/api/conversations/${conversationId}`);
  const countBefore = ((before.body as { messages?: unknown[] }).messages ?? []).length;

  const refused = await f.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      text: 'Read the attached notes',
      requestId: 'message-oversized',
      attachments: [{ name: 'huge.md', type: 'text/markdown', size: MIB + 1, text: 'x' }],
    }),
  });
  expect(refused.status).toBe(400);
  expect((refused.body as { code?: string }).code).toBe('invalid_input');
  expect((refused.body as { message?: string }).message).toContain('1 MiB');

  // The refused message was not stored: nothing new reached the conversation.
  const after = await f.request(`/api/conversations/${conversationId}`);
  const countAfter = ((after.body as { messages?: unknown[] }).messages ?? []).length;
  expect(countAfter).toBe(countBefore);
  expect(f.provider.requests.every(request => !JSON.stringify(request).includes('huge.md'))).toBe(true);
}, 60_000);

test('an attachment of an unsupported type is refused by name', async () => {
  const f = await fixture();
  const conversationId = await f.conversation('Start', 'conversation-3');

  const refused = await f.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      text: 'Read the attached file',
      requestId: 'message-unsupported',
      attachments: [{ name: 'thing.bin', type: 'application/octet-stream', size: 3, data: 'YWJj' }],
    }),
  });
  expect(refused.status).toBe(400);
  expect((refused.body as { code?: string }).code).toBe('invalid_input');
  expect((refused.body as { message?: string }).message).toContain('不支持的附件类型');
  expect((refused.body as { message?: string }).message).toContain('application/octet-stream');
}, 60_000);
