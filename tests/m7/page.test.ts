import { mediaBookmarksSource } from './clone.ts';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { chromium } from 'playwright';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

// The page under test is the sibling MediaBookmarks project's own file. When that checkout has
// moved on (or is absent), this test cannot run: skipping names the real reason instead of failing
// the whole activation gate on a fact about another repository.
const configSource = join(mediaBookmarksSource(), 'src', 'config.js');

test.skipIf(!existsSync(configSource))('B站 page requires login, shows live collect progress, and lets the user read notes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m7-page-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const prior = process.cwd();
  await mkdir(join(root, 'src', 'web'), { recursive: true });
  await mkdir(join(root, 'output', 'bilibili-notes'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await copyFile(configSource, join(root, 'src', 'config.js'));
  await copyFile(new URL('../fixtures/m7/web-server.js', import.meta.url), join(root, 'src', 'web-server.js'));
  await copyFile(new URL('../fixtures/m7/index.html', import.meta.url), join(root, 'src', 'web', 'index.html'));
  await writeFile(join(root, 'src', 'cli.js'), 'process.stdout.write("1/3\\n"); setTimeout(() => process.exit(0), 1200);');
  await writeFile(join(root, 'output', 'bilibili-notes', 'fixture.md'), '# Existing note\nReview this note content.');
  process.chdir(root);
  cleanup.push(async () => { process.chdir(prior); });
  const { createWebServer } = await import(pathToFileURL(join(root, 'src', 'web-server.js')).href) as { createWebServer: () => import('node:http').Server };
  const server = createWebServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById('job')?.textContent?.includes('idle'));
  const login = await (await fetch(`${base}/api/login-status`)).json() as { loggedIn: boolean };
  expect(login.loggedIn).toBe(false);
  const collect = page.waitForResponse(response => response.url().endsWith('/api/collect'));
  await page.locator('#collect-btn').click();
  const denied = await collect;
  expect(denied.status()).toBe(409);
  expect(await page.locator('#collect-error').innerText()).toMatch(/未登录/);
  const backend = await (await fetch(`${base}/api/job`)).json() as { status: string };
  expect(backend.status).toBe('idle');
  await writeFile(join(root, 'output', 'login-state.json'), JSON.stringify({ bilibili: { hasKeyCookie: true, cookieCount: 1 } }));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('job')?.textContent?.includes('idle'));
  await page.locator('#collect-btn').click();
  await page.waitForFunction(() => document.getElementById('job')?.textContent?.includes('running'));
  const live = await (await fetch(`${base}/api/job`)).json() as { status: string };
  expect(live.status).toBe('running');
  await page.waitForFunction(() => document.getElementById('job')?.textContent?.includes('done'), { timeout: 8_000 });
  await page.locator('#notes a').first().click();
  await page.waitForFunction(() => (document.getElementById('note-body')?.textContent ?? '').includes('Existing note'));
  expect(await page.locator('#notes a').count()).toBeGreaterThan(0);
  const note = await fetch(`${base}/api/notes/content?name=fixture.md`);
  expect(note.status).toBe(200);
}, 20_000);
