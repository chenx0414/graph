/**
 * A console tab running an old bundle must say so, and only a person refreshes.
 *
 * An app update (RSI reload, upgrade) leaves an open tab looking current while
 * its code is old: measured 2026-11-01, the same stale page was twice read as
 * "the change did not take". This drives the real console in a real browser and
 * makes the daemon report a different bundle, which is exactly what the tab
 * would face after a reload.
 */
import { chromium } from 'playwright';
import { expect, test } from 'vitest';
import { cleanup, temp, consoleServer } from './app-shell-ux.fixture.ts';

test('a tab running an old bundle says so and waits for the person', async () => {
  const root = await temp('build-freshness');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();

  // The daemon now serves a newer entry bundle than the page loaded.
  await page.route('**/api/build', route => route.fulfill({ json: { bundle: 'assets/index-OLDVERSION.js' } }));
  await page.goto(`${server.url}/#/`);

  const banner = page.getByTestId('build-stale-banner');
  await banner.waitFor({ timeout: 30_000 });
  expect(await banner.innerText()).toContain('还在跑旧版本');

  // Nothing reloads by itself: the button is the only way forward.
  const navigations: string[] = [];
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  await new Promise(resolve => setTimeout(resolve, 2_000));
  expect(navigations.length, 'the page reloaded on its own').toBe(0);

  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.getByTestId('build-stale-refresh').click(),
  ]);
}, 120_000);
