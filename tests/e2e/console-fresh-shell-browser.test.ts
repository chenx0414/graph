import { afterEach, expect, test } from 'vitest';
import { chromium } from 'playwright';
import { cacheControl, freshShell, rebuild } from '../helpers/fresh-shell.ts';

/**
 * The browser half of the console freshness proof: the same URL reloaded in a
 * real Chromium must show the new bundle.
 *
 * It is a separate file because it needs window services: keeping it beside the
 * HTTP assertions would make the machine-checkable half disappear on machines
 * without a browser, which is exactly where the deterministic half matters.
 * tests/env-layers.json registers this file, not console-fresh-shell.test.ts.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('console-shell-reload browser：同一个 URL 重载显示新包', async () => {
  const { webDir, url } = await freshShell(cleanup);
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();

  await page.goto(url);
  const marker = page.locator('[data-testid="bundle-marker"]');
  expect(await marker.textContent()).toBe('a');

  await rebuild(webDir);

  // The document request of the reload is what has to be fresh; its response
  // header is the machine-readable half of the same fact the DOM shows.
  const [document] = await Promise.all([
    page.waitForResponse(response => response.request().resourceType() === 'document'),
    page.reload(),
  ]);
  expect(cacheControl(new Headers(document.headers())), 'the reloaded document must not be stored').toContain('no-store');
  // A read that lands while the new document is still replacing the old one
  // loses its execution context; that is the reload in progress, not a verdict.
  await expect.poll(async () => marker.textContent({ timeout: 1_000 }).catch(() => null)).toBe('b');
  // Still the same address: no query string, no new tab, no cache-busting.
  expect(page.url()).toBe(url);
});
