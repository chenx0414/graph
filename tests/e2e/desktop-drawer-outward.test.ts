import { afterEach, expect, test } from 'vitest';
import { launchShell } from '../helpers/desktop-shell.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('opening the right drawer in the real shell widens the window outward', async () => {
  const { app, page } = await launchShell(cleanup);
  const origin = (await page.url()).split('#')[0];
  await page.goto(`${origin}#/insights`);
  const toggle = page.getByTestId('workspace-drawer-toggle');
  await toggle.waitFor({ timeout: 30_000 });
  const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
  // A drawer left open from an earlier step would already have widened the window.
  if (await toggle.getAttribute('data-open') === 'true') {
    await toggle.click();
    await expect.poll(async () => toggle.getAttribute('data-open'), { timeout: 20_000 }).toBe('false');
  }
  const base = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    const sized = { x: area.x + 40, y: area.y + 20, width: 700, height: Math.min(600, area.height - 40) };
    window.setBounds(sized, false);
    return { sized, room: area.width - 700 >= 440 };
  });
  await expect.poll(bounds, { timeout: 20_000 }).toEqual(base.sized);
  await toggle.click();
  await expect.poll(async () => toggle.getAttribute('data-open'), { timeout: 20_000 }).toBe('true');
  if (base.room) {
    await expect.poll(bounds, { timeout: 20_000 }).toEqual({ ...base.sized, width: base.sized.width + 440 });
    await expect.poll(async () => page.locator('.window-drawer-layer[data-open="true"]').getAttribute('data-overlay'), { timeout: 10_000 }).toBe('false');
    await page.getByTestId('workspace-drawer-toggle').click();
    await expect.poll(async () => toggle.getAttribute('data-open'), { timeout: 20_000 }).toBe('false');
    await expect.poll(bounds, { timeout: 20_000 }).toEqual(base.sized);
  }
  await page.screenshot({ path: '/tmp/desktop-drawer-outward.png' });
}, 120_000);

