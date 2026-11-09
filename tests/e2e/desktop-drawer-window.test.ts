import { afterEach, expect, test } from 'vitest';
import { launchShell } from '../helpers/desktop-shell.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('the real desktop drawer opens in its own window and leaves the main window alone', async () => {
  const { app, page } = await launchShell(cleanup);
  const base = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    const sized = { x: area.x + 40, y: area.y + 20, width: 700, height: Math.min(600, area.height - 40) };
    window.setBounds(sized, false);
    return sized;
  });
  const windows = () => app.evaluate(async ({ BrowserWindow }) => Promise.all(BrowserWindow.getAllWindows().map(async window => ({
    bounds: window.getBounds(),
    drawer: await window.webContents.executeJavaScript("document.documentElement.dataset.window === 'drawer'").catch(() => false),
  }))));
  await expect.poll(async () => (await windows()).length).toBe(1);
  expect((await windows())[0]!.bounds).toEqual(base);
  expect(await page.evaluate(() => window.graph!.setDrawer!({ open: true, width: 440, route: '#/' }))).toEqual({ detached: true });
  await expect.poll(async () => (await windows()).length, { timeout: 20_000 }).toBe(2);
  await expect.poll(async () => (await windows()).filter(window => window.drawer).length, { timeout: 20_000 }).toBe(1);
  const opened = await windows();
  const main = opened.find(window => !window.drawer)!;
  const drawer = opened.find(window => window.drawer)!;
  expect(main.bounds, 'the main window keeps every pixel').toEqual(base);
  expect(drawer.bounds).toMatchObject({ width: 440, height: base.height });
  expect(drawer.bounds.x, 'the drawer sits to the right of the main window').toBeGreaterThanOrEqual(base.x + base.width);
  expect(await page.evaluate(() => window.graph!.setDrawer!({ open: false, width: 440 }))).toEqual({ detached: true });
  await expect.poll(async () => (await windows()).length, { timeout: 20_000 }).toBe(1);
  expect((await windows())[0]!.bounds).toEqual(base);
}, 120_000);

