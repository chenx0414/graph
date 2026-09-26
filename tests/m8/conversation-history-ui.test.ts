import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { TaskStore } from '../../src/core/store.ts';
import { persistConversationActivity, publishConversationDelta } from '../../src/core/conversation.ts';
import { evidenceDir } from '../helpers/evidence.ts';

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
  const evidence = evidenceDir(root, 'master-agent-entry');
  await mkdir(evidence, { recursive: true });
  const streamRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/events/stream')) streamRequests.push(request.url()); });
  const userMessages = () => page.getByTestId('message-user');
  await page.goto(`${server.url}/#/conversations/${a.conversationId}`);
  await userMessages().filter({ hasText: 'A-message-500' }).waitFor();
  expect(await userMessages().count()).toBe(200);
  await page.waitForFunction(() => document.querySelector('[data-testid="message-user"]') !== null);
  expect(streamRequests.length).toBeGreaterThan(0);
  expect(Number(new URL(streamRequests[0]!).searchParams.get('after'))).toBeGreaterThan(0);

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
  await page.screenshot({ path: join(evidence, '09-conversation-switch.png'), fullPage: true });

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

test('a burst larger than one page fills the middle records without duplicates', async () => {
  const root = await temp('burst');
  const server = await openGraphServer({ stateDir: join(root, 'state'), autoDrive: false, webDir });
  cleanup.push(() => server.close());
  const runtime = server.runtime;
  const created = await runtime.conversations.create({ text: 'BURST-000', requestId: 'create' });
  for (let index = 1; index <= 19; index++) await runtime.conversations.chat(created.conversationId, { text: `BURST-${String(index).padStart(3, '0')}`, requestId: `b-${index}` });
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const userMessages = () => page.getByTestId('message-user');
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await userMessages().filter({ hasText: 'BURST-019' }).waitFor();
  expect(await userMessages().count()).toBe(20);
  expect(await page.getByTestId('load-older').count()).toBe(0);

  // 260 new records exceed one page while only the first 20 were loaded.
  for (let index = 20; index <= 279; index++) await runtime.conversations.chat(created.conversationId, { text: `BURST-${String(index).padStart(3, '0')}`, requestId: `b-${index}` });
  await userMessages().filter({ hasText: 'BURST-279' }).waitFor();
  // Fill any hole left between the loaded head and the latest window.
  const deadline = Date.now() + 20_000;
  while (await userMessages().count() < 280 && Date.now() < deadline) {
    const button = page.getByTestId('load-older');
    if (await button.count() > 0) await button.click();
    await page.waitForTimeout(200);
  }
  expect(await userMessages().count()).toBe(280);
  expect(await userMessages().filter({ hasText: 'BURST-020' }).count()).toBe(1);
  expect(await userMessages().filter({ hasText: 'BURST-150' }).count()).toBe(1);
  expect(await userMessages().filter({ hasText: 'BURST-000' }).count()).toBe(1);
}, 120_000);

test('processed history messages update from pending to delivered without a reload', async () => {
  const root = await temp('state');
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
  const server = await openGraphServer({
    stateDir: join(root, 'state'), autoDrive: false, webDir,
    actions: { master: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed' as const, output: { text: 'ok' }, usage }) } },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  cleanup.push(() => server.close());
  const runtime = server.runtime;
  const created = await runtime.conversations.create({ text: 'PENDING-000', requestId: 'create' });
  for (let index = 1; index <= 219; index++) await runtime.conversations.chat(created.conversationId, { text: `PENDING-${String(index).padStart(3, '0')}`, requestId: `p-${index}` });
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('message-user').filter({ hasText: 'PENDING-219' }).waitFor();
  const older = page.getByTestId('load-older');
  if (await older.count() > 0) await older.click();
  await page.getByTestId('message-user').filter({ hasText: 'PENDING-000' }).waitFor();
  await page.waitForFunction(() => {
    const element = [...document.querySelectorAll('[data-testid="message-user"]')].find(candidate => candidate.textContent?.includes('PENDING-000'));
    return element?.getAttribute('data-state') === 'pending';
  });

  // The master consumes one queued turn at a time and every state change must
  // reach the cache that loaded the record earlier.
  for (let batch = 0; batch < 6; batch++) await runtime.host.runReady();
  await page.waitForFunction(() => {
    const element = [...document.querySelectorAll('[data-testid="message-user"]')].find(candidate => candidate.textContent?.includes('PENDING-000'));
    return element?.getAttribute('data-state') === 'delivered';
  }, undefined, { timeout: 15_000 });
  const first = (await runtime.conversations.view(created.conversationId, { before: 5 })).messages.find(message => message.text === 'PENDING-000')!;
  expect(first.text).toBe('PENDING-000');
  expect(first.state).toBe('delivered');
}, 120_000);

test('interleaved conversations page by their own records, not by global sequence steps', async () => {
  const root = await temp('interleaved');
  const server = await openGraphServer({ stateDir: join(root, 'state'), autoDrive: false, webDir });
  cleanup.push(() => server.close());
  const runtime = server.runtime;
  const a = await runtime.conversations.create({ text: 'A-000', requestId: 'a' });
  const b = await runtime.conversations.create({ text: 'B-000', requestId: 'b' });
  // B interleaves every record, so A's global seqs are sparse inside A.
  for (let index = 1; index <= 500; index++) {
    await runtime.conversations.chat(a.conversationId, { text: `A-${String(index).padStart(3, '0')}`, requestId: `a-${index}` });
    await runtime.conversations.chat(b.conversationId, { text: `B-${String(index).padStart(3, '0')}`, requestId: `b-${index}` });
  }
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const userMessages = () => page.getByTestId('message-user');
  await page.goto(`${server.url}/#/conversations/${a.conversationId}`);
  await userMessages().filter({ hasText: 'A-500' }).waitFor();
  expect(await userMessages().count()).toBe(200);

  await page.getByTestId('load-older').click();
  await userMessages().filter({ hasText: 'A-101' }).waitFor();
  expect(await userMessages().count()).toBe(400);
  await page.getByTestId('load-older').click();
  await userMessages().filter({ hasText: 'A-000' }).waitFor();
  expect(await userMessages().count()).toBe(501);
  expect(await page.getByTestId('load-older').count()).toBe(0);
  expect(await userMessages().filter({ hasText: 'B-' }).count()).toBe(0);

  // A burst during interleaving must still fill every real hole.
  for (let index = 501; index <= 760; index++) {
    await runtime.conversations.chat(a.conversationId, { text: `A-${String(index).padStart(3, '0')}`, requestId: `a-${index}` });
    await runtime.conversations.chat(b.conversationId, { text: `B-${String(index).padStart(3, '0')}`, requestId: `b-${index}` });
  }
  await userMessages().filter({ hasText: 'A-760' }).waitFor();
  const deadline = Date.now() + 20_000;
  while (await userMessages().count() < 761 && Date.now() < deadline) {
    const button = page.getByTestId('load-older');
    if (await button.count() > 0) await button.click();
    await page.waitForTimeout(200);
  }
  expect(await userMessages().count()).toBe(761);
  expect(await userMessages().filter({ hasText: 'A-501' }).count()).toBe(1);
  expect(await userMessages().filter({ hasText: 'A-700' }).count()).toBe(1);
  expect(await userMessages().filter({ hasText: 'B-' }).count()).toBe(0);
}, 120_000);


test('reopening a live conversation attaches its snapshot without replaying old bubbles', async () => {
  const root = await temp('stream-attach');
  const stateDir = join(root, 'state');
  const server = await openGraphServer({ stateDir, autoDrive: false, webDir });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ text: 'keep working', requestId: 'attach' });
  const view = await server.runtime.conversations.view(created.conversationId);
  const store = new TaskStore(join(stateDir, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  store.db.prepare("INSERT OR IGNORE INTO nodes(task_id,id,spec) VALUES(?,'master','{\"role\":\"master\",\"kind\":\"agent\"}')").run(view.anchorTaskId);
  store.db.prepare("UPDATE nodes SET status='running' WHERE task_id=? AND id='master'").run(view.anchorTaskId);
  store.db.prepare("INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active) VALUES('attach-op',?,'master',1,'{}','dispatched',0,1)").run(view.anchorTaskId);
  for (let index = 0; index < 1000; index++) store.event(view.anchorTaskId, 'message.delta', { operationId: 'old-op', entryId: `old-${index}`, partId: '0', text: 'MUST-NOT-REPLAY', len: 15, reset: true });
  persistConversationActivity(store, created.conversationId, 'attach-op', 1, [{ kind: 'narration', text: 'SAVED-NARRATION', ordinal: 1 }]);
  publishConversationDelta(store, { taskId: view.anchorTaskId, conversationId: created.conversationId, operationId: 'attach-op', entryId: 'e1', partId: '0', ordinal: 1, text: 'SAVED-NARRATION', delta: 'SAVED-NARRATION', length: 15 });
  publishConversationDelta(store, { taskId: view.anchorTaskId, conversationId: created.conversationId, operationId: 'attach-op', entryId: 'e2', partId: '0', ordinal: 2, text: 'CURRENT-TAIL', delta: 'CURRENT-TAIL', length: 12 });
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const cursors: number[] = [];
  page.on('request', request => { if (request.url().includes('/events/stream')) cursors.push(Number(new URL(request.url()).searchParams.get('after'))); });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 0) await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
    else await page.reload();
    await page.getByTestId('streaming').filter({ hasText: 'CURRENT-TAIL' }).waitFor();
    expect(await page.getByTestId('message-narration').filter({ hasText: 'SAVED-NARRATION' }).count()).toBe(1);
    expect(await page.getByText('MUST-NOT-REPLAY', { exact: true }).count()).toBe(0);
    expect(await page.getByTestId('master-status').locator('.spinner').count()).toBe(1);
  }
  await expect.poll(() => cursors.length).toBe(2);
  expect(cursors.every(cursor => cursor > 1000)).toBe(true);
}, 60_000);
