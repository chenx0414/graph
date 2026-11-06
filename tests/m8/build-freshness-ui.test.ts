/**
 * A console tab running an old bundle has to become current without the person
 * hunting for a refresh button - but never while they are typing.
 *
 * An app update (RSI reload, upgrade) leaves an open tab looking current while its
 * code is old: measured 2026-11-01 twice, and again 2026-11-06 when a deploy that
 * shipped new UI looked like "nothing happened". This
 * drives the real console in a real browser and makes the daemon report a different
 * bundle: with a draft in the composer nothing reloads and the bar says why; with an
 * empty composer the tab reloads itself.
 */
import { expect, test } from 'vitest';
import { cleanup, temp, consoleServer } from './app-shell-ux.fixture.ts';
// The browser has to start from this sandbox as well as outside it.
import { launchBrowser } from '../helpers/host-browser.ts';

test('a tab running an old bundle makes itself current unless a draft is being written', async () => {
  const root = await temp('build-freshness');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });
  const { browser } = await launchBrowser();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();

  const navigations: string[] = [];
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });

  // The root lands on the global Agent's conversation, which is the composer this
  // test writes into - there is no separate new-conversation page any more.
  await page.goto(`${server.url}/#/`);
  await page.getByTestId('chat-input').waitFor({ timeout: 30_000 });
  // The goto itself is a navigation; only what happens after it is the question.
  navigations.length = 0;

  // A half-written message belongs to the person: nothing reloads under it, and the
  // bar says the tab is old. The deployment is announced only now, so the check that
  // follows is the one that sees it.
  await page.getByTestId('chat-input').fill('还没发出去的问题');
  await page.route('**/api/build', route => route.fulfill({ json: { bundle: 'assets/index-OLDVERSION.js' } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  const banner = page.getByTestId('build-stale-banner');
  await banner.waitFor({ timeout: 30_000 });
  expect(await banner.innerText()).toContain('还在跑旧版本');
  await new Promise(resolve => setTimeout(resolve, 2_000));
  expect(navigations.length, 'the page reloaded under a draft').toBe(0);
  expect(await page.getByTestId('chat-input').innerText()).toContain('还没发出去的问题');

  // With nothing being written, the tab makes itself current.
  await page.getByTestId('chat-input').fill('');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => navigations.length, { timeout: 20_000 }).toBeGreaterThan(0);
}, 120_000);
