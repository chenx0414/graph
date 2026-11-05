import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * An image the reader attaches reaches the model.
 *
 * The product reads the attachment, counts it against the message limits and
 * stores it - and then the turn has to carry it to the provider. Measured
 * 2026-11-05: the kernel's prompt had no images parameter at all, so the image
 * was read, accepted and silently dropped on the way out; the reader saw a
 * model that could not read a screenshot although it can.
 *
 * The proof is the provider's own request body: the stub records what the daemon
 * sent, and the assertion is that the user message carries an image_url part
 * with the attachment's bytes rather than text alone.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

// One transparent pixel: small enough to inline, and the bytes are the proof.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-image-passthrough-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await openaiServer([{ text: 'The screenshot shows a dialog.' }, { text: 'Noted.' }, { text: 'Still here.' }]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_IMAGE_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_IMAGE_KEY: 'synthetic-image-key' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  return { daemon, provider, request };
}

type SentMessage = { role: string; content: unknown };
type SentRequest = { messages: SentMessage[] };

/** Every image_url part any request carried, as its url string. */
function imageParts(requests: unknown[]): string[] {
  const urls: string[] = [];
  for (const request of requests as SentRequest[]) {
    for (const message of request.messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content as { type?: string; image_url?: { url?: string } }[]) {
        if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') urls.push(part.image_url.url);
      }
    }
  }
  return urls;
}

test('an image attached to a message reaches the provider as an image part', async () => {
  const f = await fixture();
  const created = await f.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Hello', requestId: 'image-conversation-1' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;

  const sent = await f.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      text: 'What does this dialog say?',
      requestId: 'image-message-1',
      attachments: [{ name: 'dialog.png', type: 'image/png', size: PNG.length, data: PNG }],
    }),
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);

  await expect.poll(() => imageParts(f.provider.requests).length, { timeout: 30000 }).toBeGreaterThan(0);
  const urls = imageParts(f.provider.requests);
  expect(urls[0], 'the image part must carry the attachment bytes, not a placeholder').toBe(`data:image/png;base64,${PNG}`);
});
