import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-conversation-history-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-conversation-history-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('history pages to the earliest record, survives new messages, and never crosses conversations', async () => {
  const root = await temp('flow');
  const server = await openGraphServer({ stateDir: join(root, 'state'), autoDrive: false, webDir });
  cleanup.push(() => server.close());
  const runtime = server.runtime;
  const a = await runtime.conversations.create({ text: 'A-message-000', requestId: 'a' });
  for (let index = 1; index <= 500; index++) {
    await runtime.conversations.chat(a.conversationId, { text: `A-message-${String(index).padStart(3, '0')}`, requestId: `a-${index}` });
  }
  const b = await runtime.conversations.create({ text: 'B-only-message', requestId: 'b' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const userMessages = () => page.getByTestId('message-user');
  await page.goto(`${server.url}/#/conversations/${a.conversationId}`);
  await userMessages().filter({ hasText: 'A-message-500' }).waitFor();
  expect(await userMessages().count()).toBe(200);

  // The cursor advances from the earliest loaded record: three pages reach the start.
  await page.getByTestId('load-older').click();
  await userMessages().filter({ hasText: 'A-message-101' }).waitFor();
  expect(await userMessages().count()).toBe(400);
  await page.getByTestId('load-older').click();
  await userMessages().filter({ hasText: 'A-message-000' }).waitFor();
  expect(await userMessages().count()).toBe(501);
  expect(await page.getByTestId('load-older').count()).toBe(0);

  // A new message must not tear a hole in the already-loaded window.
  await runtime.conversations.chat(a.conversationId, { text: 'A-message-501', requestId: 'a-new' });
  await userMessages().filter({ hasText: 'A-message-501' }).waitFor();
  expect(await userMessages().filter({ hasText: 'A-message-301' }).count()).toBe(1);
  expect(await userMessages().count()).toBe(502);

  // Switching conversations must not mix their histories.
  await page.evaluate(id => { location.hash = `#/conversations/${id}`; }, b.conversationId);
  await userMessages().filter({ hasText: 'B-only-message' }).waitFor();
  expect(await userMessages().filter({ hasText: 'A-message-' }).count()).toBe(0);
  await page.screenshot({ path: join(process.cwd(), 'docs', 'planning', 'acceptance-evidence', 'master-agent-entry', '09-conversation-switch.png'), fullPage: true });

  // Browser back restores A without leaking B, and an in-flight history load
  // cannot modify the conversation it was never part of.
  await page.goBack();
  await userMessages().filter({ hasText: 'A-message-501' }).waitFor();
  expect(await userMessages().filter({ hasText: 'B-only-message' }).count()).toBe(0);
  await page.getByTestId('load-older').click();
  await page.evaluate(id => { location.hash = `#/conversations/${id}`; }, b.conversationId);
  await userMessages().filter({ hasText: 'B-only-message' }).waitFor();
  await page.waitForTimeout(600);
  expect(await userMessages().filter({ hasText: 'A-message-' }).count()).toBe(0);
  expect(await userMessages().count()).toBe(1);
}, 120_000);
