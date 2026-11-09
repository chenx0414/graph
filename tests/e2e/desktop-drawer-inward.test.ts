import { afterEach, expect, test } from 'vitest';
import { launchShell } from '../helpers/desktop-shell.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('opening the right drawer in the real shell stays inside the window', async () => {
  const { app, page } = await launchShell(cleanup);
  await expect.poll(() => page.locator('.workspace-bar').count(), { timeout: 60_000 }).toBeGreaterThan(0);
  await page.evaluate(() => { location.hash = '#/insights'; });
  const toggle = page.getByTestId('workspace-drawer-toggle');
  await expect.poll(() => page.locator('[data-testid="workspace-drawer-toggle"]:visible').count(), { timeout: 60_000 }).toBeGreaterThan(0);
  const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
  // A drawer left open from an earlier step would already be on screen.
  if (await toggle.getAttribute('data-open') === 'true') {
    await toggle.click();
    await expect.poll(async () => toggle.getAttribute('data-open'), { timeout: 20_000 }).toBe('false');
  }
  const base = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    const sized = { x: area.x + 40, y: area.y + 20, width: 700, height: Math.min(600, area.height - 40) };
    window.setBounds(sized, false);
    return sized;
  });
  await expect.poll(bounds, { timeout: 20_000 }).toEqual(base);
  const corner = () => page.getByTestId('workspace-drawer-toggle').evaluate(node => {
    const box = node.getBoundingClientRect();
    return { fromRight: Math.round(window.innerWidth - box.right), top: Math.round(box.top) };
  });
  const resting = await corner();

  await toggle.click();
  await expect.poll(async () => toggle.getAttribute('data-open'), { timeout: 20_000 }).toBe('true');
  await expect.poll(() => page.locator('[data-testid="detail-drawer"]:visible').count(), { timeout: 20_000 }).toBeGreaterThan(0);
  // The panel opens inside the window: the shell keeps the size the reader gave it.
  expect(await bounds(), 'the drawer resized the window').toEqual(base);
  expect(await corner(), 'the drawer toggle left the top-right corner').toEqual(resting);

  await toggle.click();
  await expect.poll(async () => toggle.getAttribute('data-open'), { timeout: 20_000 }).toBe('false');
  expect(await bounds()).toEqual(base);
  await page.screenshot({ path: '/tmp/desktop-drawer-inward.png' });
}, 120_000);
