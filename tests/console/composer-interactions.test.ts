import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { TaskStore } from '../../src/core/store.ts';
import { appendMessage } from '../../src/core/conversation.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-composer-interactions-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-composer-interactions-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterAll(() => rm(webDir, { recursive: true, force: true }));

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

/** A read-only console with no master turn: enough to exercise the composer. */
async function viewServer(root: string) {
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  return server;
}

const distanceFromBottom = () => {
  const thread = document.querySelector('[data-testid="message-list"]');
  if (!thread) return -1;
  return Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight);
};

test('the composer grows with its content and caps into a scrollable field', async () => {
  const root = await temp('height');
  const server = await viewServer(root);
  const created = await server.runtime.conversations.create({ text: '高度测试', requestId: 'height-create' });
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const input = page.getByTestId('chat-input');
  await input.waitFor();

  const oneLine = await input.evaluate(element => (element as HTMLTextAreaElement).clientHeight);
  await input.fill(Array.from({ length: 40 }, (_, index) => `第 ${index} 行内容`).join('\n'));
  await expect.poll(() => input.evaluate(element => (element as HTMLTextAreaElement).clientHeight))
    .toBeGreaterThan(oneLine);
  const grown = await input.evaluate(element => {
    const field = element as HTMLTextAreaElement;
    return { height: field.clientHeight, overflow: field.scrollHeight - field.clientHeight };
  });
  expect(grown.height).toBeLessThanOrEqual(180);
  expect(grown.height).toBeGreaterThan(oneLine);
  expect(grown.overflow).toBeGreaterThan(1);

  // Shrinking the content releases the extra height again.
  await input.fill('一行');
  await expect.poll(() => input.evaluate(element => (element as HTMLTextAreaElement).clientHeight))
    .toBeLessThan(grown.height);
}, 60_000);

test('an unsent draft survives a conversation switch and a window reload', async () => {
  const root = await temp('draft');
  const server = await viewServer(root);
  const first = await server.runtime.conversations.create({ text: '第一个会话', requestId: 'draft-first' });
  const second = await server.runtime.conversations.create({ text: '第二个会话', requestId: 'draft-second' });
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const draft = '这段内容还没发送，切换会话后应该还在。';

  await page.goto(`${server.url}/#/conversations/${first.conversationId}`);
  const input = page.getByTestId('chat-input');
  await input.waitFor();
  await input.fill(draft);
  await expect.poll(() => page.evaluate(() => Object.keys(window.localStorage).some(key => key.startsWith('graph.conversation.composer.')))).toBe(true);

  await page.goto(`${server.url}/#/conversations/${second.conversationId}`);
  await page.getByTestId('chat-input').waitFor();
  await expect.poll(() => page.getByTestId('chat-input').inputValue()).toBe('');

  await page.goto(`${server.url}/#/conversations/${first.conversationId}`);
  await expect.poll(() => page.getByTestId('chat-input').inputValue()).toBe(draft);

  await page.reload();
  await expect.poll(() => page.getByTestId('chat-input').inputValue()).toBe(draft);
}, 60_000);

test('re-entering a conversation lands on its newest message', async () => {
  const root = await temp('scroll');
  const server = await viewServer(root);
  const long = await server.runtime.conversations.create({ text: '长会话', requestId: 'scroll-long' });
  const other = await server.runtime.conversations.create({ text: '另一个会话', requestId: 'scroll-other' });
  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  for (let index = 0; index < 80; index += 1) {
    appendMessage(store, {
      conversationId: long.conversationId, role: 'assistant', kind: 'chat',
      text: `回答 ${index}：${'这是一段足够长的内容。'.repeat(6)}`,
    });
  }

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${other.conversationId}`);
  await page.getByTestId('chat-input').waitFor();

  await page.goto(`${server.url}/#/conversations/${long.conversationId}`);
  await page.getByTestId('message-list').waitFor();
  expect(await page.evaluate(() => {
    const thread = document.querySelector('[data-testid="message-list"]');
    return Boolean(thread && thread.scrollHeight > thread.clientHeight + 40);
  })).toBe(true);
  await expect.poll(() => page.evaluate(distanceFromBottom)).toBeLessThanOrEqual(2);
}, 60_000);

test('the primary button pauses, resumes, and sends+continues from one control', async () => {
  const root = await temp('pause');
  let release: () => void = () => undefined;
  const blocked = new Promise<void>(resolve => { release = () => resolve(); });
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [],
    actions: {
      master: {
        kind: 'agent',
        reserveTokens: 100,
        prepare: async () => async () => {
          await blocked;
          return { outcome: 'completed', output: { text: '继续处理完成。' }, usage };
        },
      },
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
    autoDrive: true,
    webDir,
    startup: { mode: 'execute', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ text: '先讨论一下', requestId: 'pause-create' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const primary = page.getByTestId('chat-send');
  const input = page.getByTestId('chat-input');
  await input.waitFor();
  await expect.poll(async () => (await server.runtime.conversations.view(created.conversationId)).master?.status).toBe('running');

  // State 1: while the master outputs, an empty composer offers pause.
  await expect.poll(() => primary.getAttribute('data-mode')).toBe('pause');
  await primary.click();
  await page.getByTestId('conversation-paused-notice').waitFor();
  await expect.poll(() => primary.getAttribute('data-mode')).toBe('resume');

  // State 2: paused with nothing to send, the same control resumes.
  await primary.click();
  await page.getByTestId('conversation-paused-notice').waitFor({ state: 'detached' });
  await expect.poll(async () => (await server.runtime.conversations.view(created.conversationId)).paused).toBe(false);

  // State 4: paused again, now with input: one click sends it and continues.
  await expect.poll(() => primary.getAttribute('data-mode')).toBe('pause');
  await primary.click();
  await page.getByTestId('conversation-paused-notice').waitFor();
  await input.fill('这条要发出去并自动继续。');
  await expect.poll(() => primary.getAttribute('data-mode')).toBe('resume');
  await primary.click();
  await page.getByTestId('conversation-paused-notice').waitFor({ state: 'detached' });
  await expect.poll(async () => {
    const view = await server.runtime.conversations.view(created.conversationId);
    return { paused: view.paused, sent: view.messages.some(message => message.text === '这条要发出去并自动继续。') };
  }).toEqual({ paused: false, sent: true });

  release();
  await expect.poll(async () => (await server.runtime.conversations.view(created.conversationId)).master?.status).toBe('succeeded');
}, 60_000);
