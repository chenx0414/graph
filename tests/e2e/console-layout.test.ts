import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { chromium, type Page } from 'playwright';
import { build } from 'vite';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * What the console must always look like, regardless of the data in it.
 *
 * Pixels are the wrong unit here: every number on these pages is live, so a
 * screenshot baseline would churn on its own. Layout is the part that must not
 * move — a page that loses its columns, a rail that overlaps the content, a
 * fold that stops opening. Those are the regressions a person actually notices,
 * and each one is expressible as a measurement.
 */

let webDir: string;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-layout-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 120_000);
afterAll(() => rm(webDir, { recursive: true, force: true }));
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function open() {
  const root = await mkdtemp(join(tmpdir(), 'graph-layout-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await symlink(webDir, join(root, 'web'));
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }] }));
  await mkdir(join(root, 'graph-home', 'capabilities'), { recursive: true });
  const daemon = await launchCli(root, { configPath });
  cleanup.push(() => daemon.close());
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  return { daemon, page };
}

async function box(page: Page, selector: string) {
  const found = await page.locator(selector).first().boundingBox();
  expect(found, `expected ${selector} to be laid out`).not.toBeNull();
  return found!;
}

/** Nothing may overflow the window horizontally: the shell is a fixed grid. */
async function assertNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(overflow.scroll, 'the page grew wider than the window').toBeLessThanOrEqual(overflow.viewport + 1);
}

test('the sidebar carries no brand block and still clears the window controls', async () => {
  const { daemon, page } = await open();
  await page.goto(`${daemon.url}/#/insights`);
  await page.getByTestId('insights-page').waitFor();

  expect(await page.locator('.brand').count(), 'the sidebar brand block is back').toBe(0);
  expect(await page.locator('.brand-mark').count(), 'the sidebar logo is back').toBe(0);
  expect(await page.locator('.brand-name').count(), 'the sidebar wordmark is back').toBe(0);
  // The traffic lights sit at the top-left of the window: the first rail control has
  // to stay below them even with nothing to show above it.
  const first = await box(page, '[data-testid=rail-catalog]');
  expect(Math.round(first.y), 'the rail moved up into the window controls').toBeGreaterThanOrEqual(44);
});

test('the rail and the page never overlap, and the page keeps its width', async () => {
  const { daemon, page } = await open();
  await page.goto(`${daemon.url}/#/insights`);
  await page.getByTestId('insights-page').waitFor();

  const rail = await box(page, '.rail');
  const content = await box(page, '.content');
  // The page starts where the rail ends: an overlap here is the bug that hid
  // the toolbar buttons when the drawer was still an overlay.
  expect(content.x).toBeGreaterThanOrEqual(rail.x + rail.width - 1);
  expect(content.width).toBeGreaterThan(600);
  await assertNoHorizontalScroll(page);
});

test('the overview keeps five cards in one row at a desktop width', async () => {
  const { daemon, page } = await open();
  await page.goto(`${daemon.url}/#/insights`);
  await page.getByTestId('insights-page').waitFor();

  const cards = page.locator('[data-testid=insights-overview] .stat');
  await expect.poll(() => cards.count()).toBe(5);
  const boxes = await Promise.all([0, 1, 2, 3, 4].map(index => box(page, `[data-testid=insights-overview] .stat >> nth=${index}`)));
  // One row means every card shares a top edge; a collapsed grid would stack them.
  const tops = new Set(boxes.map(entry => Math.round(entry.y)));
  expect(tops.size, `cards landed on ${tops.size} rows`).toBe(1);
  for (const entry of boxes) expect(entry.height).toBeGreaterThan(40);
});

test('a fold opens in place and its content stays inside the column', async () => {
  const { daemon, page } = await open();
  await page.goto(`${daemon.url}/#/insights`);
  await page.getByTestId('insights-page').waitFor();

  const fold = page.getByTestId('insights-fold-detail');
  const head = await box(page, '[data-testid=insights-fold-detail] .insights-fold-head');
  expect(head.height).toBeGreaterThan(30);
  expect(await fold.getAttribute('data-open')).toBe('false');
  expect(await page.getByTestId('insights-fold-detail-body').count()).toBe(0);

  const before = await box(page, '.content');
  await page.getByTestId('insights-fold-detail-toggle').click();
  await expect.poll(async () => page.getByTestId('insights-fold-detail-body').count()).toBe(1);
  // The body belongs to the same column: opening a fold must not widen the page.
  const after = await box(page, '.content');
  expect(after.width).toBe(before.width);
  const body = await box(page, '[data-testid=insights-fold-detail-body]');
  expect(body.x).toBeGreaterThanOrEqual(before.x - 1);
  await assertNoHorizontalScroll(page);
});

test('the drawer takes a column and squeezes the page instead of covering it', async () => {
  const { daemon, page } = await open();
  await page.goto(`${daemon.url}/#/insights`);
  await page.getByTestId('rail-insights').waitFor();

  const closed = await box(page, '.content');
  await page.getByTestId('workspace-drawer-toggle').click();
  await expect.poll(async () => page.getByTestId('workspace-drawer-toggle').getAttribute('data-open')).toBe('true');
  await expect.poll(async () => Math.round((await box(page, '.window-drawer-layer')).width), { timeout: 10_000 }).toBeGreaterThan(300);
  const narrow = await box(page, '.content');
  const panel = await box(page, '.window-drawer-layer');

  // Split pane: the page gives the panel its room, so the panel never sits on top of it.
  expect(Math.round(closed.width - narrow.width), 'the page did not give up the panel width').toBeGreaterThanOrEqual(Math.round(panel.width) - 1);
  expect(Math.round(panel.x), 'the drawer covers the page instead of following it').toBeGreaterThanOrEqual(Math.round(narrow.x + narrow.width) - 1);
  expect(Math.round(panel.x + panel.width)).toBe(Math.round(closed.x + closed.width));
  await assertNoHorizontalScroll(page);
});


