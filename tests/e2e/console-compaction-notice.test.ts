import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { launchBrowser } from '../helpers/host-browser.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// The kernel compacts a long context into a summary before the next request. Two
// things are proved here - the summary tells the model where the earlier
// conversation went (the durable transcript, searchable with history_search), and
// the compaction itself stays out of the chat: the reader sees the conversation,
// not a machine card about it.
//
// The ceiling is small on purpose (GRAPH_COMPACTION_CONTEXT_CEILING), so the
// second turn crosses it with one long answer instead of a 70%-of-window setup.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

interface ConversationView {
  messages: { role: string; kind: string; text: string; data?: { tokensAfter?: number } | null }[];
}

test('a compaction stays out of the chat while its summary names the durable transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-compaction-visible-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const webDir = join(root, 'web');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
  // The first answer is long enough to cross a 3000-token ceiling; the second plan
  // is the summarizer, the third answers the second question.
  const longAnswer = `LONG-ANSWER-MARKER ${'the request took this route. '.repeat(900)}`;
  const provider = await openaiServer([
    { text: longAnswer, usage: { prompt_tokens: 1_200, completion_tokens: 3_000 } },
    { text: 'Summary of the earlier work.', usage: { prompt_tokens: 3_400, completion_tokens: 60 } },
    { text: 'Second answer.', usage: { prompt_tokens: 300, completion_tokens: 12 } },
  ]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_COMPACTION_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath, webDir, extraArgs: ['--execute'],
    env: { GRAPH_COMPACTION_KEY: 'synthetic-only', GRAPH_COMPACTION_CONTEXT_CEILING: '3000' },
  });
  cleanup.push(() => daemon.close());
  const view = async (id: string) => await (await daemon.request(`/api/conversations/${id}`)).json() as ConversationView;

  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', title: 'Compaction', text: 'First question.', requestId: 'compaction-first' }),
  });
  const createdText = await created.text();
  expect(created.status, createdText).toBe(200);
  const conversationId = (JSON.parse(createdText) as { conversationId: string }).conversationId;
  await expect.poll(async () => (await view(conversationId)).messages.some(message => (message.text ?? '').includes('LONG-ANSWER-MARKER')),
    { timeout: 30_000, interval: 100 }).toBe(true);

  const second = await daemon.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ text: 'Second question.', requestId: 'compaction-second' }),
  });
  expect(second.status, await second.text()).toBe(200);
  await expect.poll(async () => (await view(conversationId)).messages.some(message => (message.text ?? '').includes('Second answer.')),
    { timeout: 30_000, interval: 100 }).toBe(true);

  // The summarizer is asked in its own provider call, and its prompt carries the
  // pointer: the earlier conversation is durable and searchable, not gone.
  expect(provider.requests.length).toBeGreaterThanOrEqual(3);
  const summarizer = JSON.stringify(provider.requests[1]);
  expect(summarizer).toContain('history_search');
  expect(summarizer).toContain('durable transcript');

  // The compaction is still recorded as a system message with the size the context
  // was left at, and the earlier turns are still in the conversation.
  const compacted = (await view(conversationId)).messages.filter(message => message.kind === 'compaction');
  expect(compacted).toHaveLength(1);
  expect(compacted[0]!.role).toBe('system');
  expect(compacted[0]!.text).toContain('上下文已自动压缩');
  expect(compacted[0]!.text).toContain('history_search');
  expect(typeof compacted[0]!.data?.tokensAfter).toBe('number');
  expect((await view(conversationId)).messages.some(message => (message.text ?? '').includes('LONG-ANSWER-MARKER'))).toBe(true);

  // And the reader does not see it: the chat renders the messages, with no card and
  // no summary block for the compaction that happened.
  const { browser } = await launchBrowser();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(daemon.url);
  await page.goto(`${daemon.url}/#/conversations/${conversationId}`);
  await page.getByTestId('conversation').waitFor();
  const thread = page.getByTestId('message-list');
  await expect.poll(async () => thread.innerText(), { timeout: 30_000 }).toContain('Second answer.');
  expect(await page.locator('.compaction-notice').count()).toBe(0);
  expect(await page.locator('.compaction-summary').count()).toBe(0);
  expect(await thread.innerText()).not.toContain('上下文已压缩');
  await page.screenshot({ path: join(root, 'test-evidence/compaction-hidden.png') });
});
