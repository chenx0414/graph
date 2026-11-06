import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { evidenceDir } from '../helpers/evidence.ts';
import { launchBrowser } from '../helpers/host-browser.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// A deploy replaces the bundle the daemon serves; an open tab keeps running the one
// it loaded, and the person sees yesterday's console while believing it is today's.
// Measured 2026-11-06: a deploy that turned the goal card into the goal bar was
// reported as "not taking effect" because the tab was never reloaded.
//
// So the console watches the served bundle:
//  - nothing in the composer (or the tab is hidden): it reloads itself, silently,
//    and the new UI is simply there;
//  - a draft in the composer: it never reloads under the person's hands, and shows a
//    bar that stays until they press it;
//  - and it reloads at most once per served bundle, so a tab that comes back still
//    stale shows the bar instead of looping.
//
// The proof is a real daemon, the real bundle and a real browser. Only /api/build is
// answered by the test - the deployment itself is what is being simulated, and it is
// the one input the page uses to decide.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function consoleWithConversation() {
  const root = await mkdtemp(join(tmpdir(), 'graph-console-stale-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const webDir = join(root, 'web');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
  const provider = await openaiServer([{ text: '好。', usage: { prompt_tokens: 8, completion_tokens: 2 } }]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_STALE_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, webDir, extraArgs: ['--execute'], env: { GRAPH_STALE_KEY: 'synthetic-only' } });
  cleanup.push(() => daemon.close());
  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', title: 'Stale build', text: '你好', requestId: 'stale-first' }),
  });
  const createdText = await created.text();
  expect(created.status, createdText).toBe(200);
  return { root, daemon, conversationId: (JSON.parse(createdText) as { conversationId: string }).conversationId };
}

/** Tell the page that the daemon serves `bundle`. */
async function deferBuild(page: import('playwright').Page, bundle: string) {
  await page.route('**/api/build', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bundle }) }));
}

test('a new build reloads the console by itself when nothing is being typed', async () => {
  const { root, daemon, conversationId } = await consoleWithConversation();
  const { browser } = await launchBrowser();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(daemon.url);
  await page.goto(`${daemon.url}/#/conversations/${conversationId}`);
  await page.getByTestId('conversation').waitFor();

  // A deploy happened: the daemon now serves a different bundle. The first answer
  // says so; every answer after it names the bundle the reloaded page runs, which is
  // what a real deployment looks like once the tab is current.
  const running = await page.evaluate(() => [...document.scripts]
    .map(script => script.src.split('/').pop() ?? '')
    .find(name => /^index-.*\.js$/.test(name)) ?? '');
  let answers = 0;
  await page.route('**/api/build', async route => {
    answers += 1;
    const bundle = answers === 1 ? '/assets/index-DEPLOYED.js' : `/assets/${running}`;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bundle }) });
  });
  // The page marks itself; a reload wipes the marker, so a missing marker is proof
  // that the document really reloaded.
  await page.evaluate(() => { (window as unknown as { staleMarker?: number }).staleMarker = 42; });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect.poll(
    () => page.evaluate(() => (window as unknown as { staleMarker?: number }).staleMarker ?? null),
    { timeout: 20_000, interval: 250 },
  ).toBeNull();
  // It came back current, and because the served build now matches the running one
  // there is no bar: nobody had to press anything.
  await page.getByTestId('conversation').waitFor();
  expect(await page.getByTestId('build-stale-banner').count()).toBe(0);
  await page.screenshot({ path: join(evidenceDir(root, 'console-stale-build'), 'reloaded.png'), fullPage: false });
}, 180_000);

test('a draft in the composer is never reloaded away, and the bar stays until it is pressed', async () => {
  const { root, daemon, conversationId } = await consoleWithConversation();
  const { browser } = await launchBrowser();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(daemon.url);
  await page.goto(`${daemon.url}/#/conversations/${conversationId}`);
  await page.getByTestId('conversation').waitFor();

  // Half-written message: the person is working, so nothing may reload.
  await page.getByTestId('chat-input').fill('还没发出去的草稿');
  await deferBuild(page, '/assets/index-DEPLOYED.js');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  const banner = page.getByTestId('build-stale-banner');
  await banner.waitFor({ timeout: 20_000 });
  expect(await banner.innerText()).toContain('还在跑旧版本');
  // The draft survived, so the document did not reload.
  expect(await page.getByTestId('chat-input').innerText()).toContain('还没发出去的草稿');
  await page.screenshot({ path: join(evidenceDir(root, 'console-stale-build'), 'draft-banner.png'), fullPage: false });

  // Pressing the bar is the person's decision: it reloads, and a tab that comes back
  // still stale says so instead of reloading in a loop.
  await page.getByTestId('build-stale-refresh').click();
  await page.getByTestId('conversation').waitFor();
  await expect.poll(async () => await page.getByTestId('build-stale-banner').count(), { timeout: 20_000 }).toBe(1);
  // The console keeps an unsent draft across a reload, so pressing the bar costs the
  // person nothing - and it is still never reloaded without that press.
  await expect.poll(async () => await page.getByTestId('chat-input').innerText(), { timeout: 10_000 })
    .toContain('还没发出去的草稿');
}, 180_000);
