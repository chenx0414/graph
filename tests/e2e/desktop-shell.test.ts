import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { _electron } from 'playwright';
import { build } from 'vite';

const electronExecutable: string = createRequire(import.meta.url)('electron');
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function shell() {
  const tooling = join(process.cwd(), '.tooling');
  await mkdir(tooling, { recursive: true });
  const root = await mkdtemp(join(tooling, 'desktop-e2e-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const userData = join(root, 'user-data');
  await mkdir(source);
  await mkdir(join(root, '.graph'));
  for (const directory of ['src', 'presets', 'docs']) await cp(join(process.cwd(), directory), join(source, directory), { recursive: true });
  await cp(join(process.cwd(), 'package.json'), join(source, 'package.json'));
  await writeFile(join(root, '.graph/app-root'), `${source}\n`);
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: join(source, 'dist/web'), emptyOutDir: true } });
  const app = await _electron.launch({
    executablePath: electronExecutable,
    timeout: 15000,
    // Chromium's test keychain prevents an OS password dialog in an isolated
    // HOME. These cases cover windows/processes, not keychain encryption.
    args: ['--use-mock-keychain', join(process.cwd(), 'desktop/main.mjs')],
    env: { ...process.env, HOME: root, GRAPH_APP_USER_DATA: userData, GRAPH_RSI_ROOT: join(root, 'stale'), GRAPH_APP_DEBUG: '1', GRAPH_APP_SMOKE: '', ELECTRON_RUN_AS_NODE: '' },
  });
  cleanup.push(() => app.close());
  let daemonLog = '';
  app.process().stdout?.on('data', (chunk: Buffer) => { daemonLog += chunk.toString(); });
  app.process().stderr?.on('data', (chunk: Buffer) => { daemonLog += chunk.toString(); });
  let page;
  try { page = await app.firstWindow({ timeout: 10000 }); }
  catch (error) {
    await writeFile('/tmp/graph-desktop-e2e-startup.log', `No window after launch\n${daemonLog}`);
    throw error;
  }
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => window.graph?.isDesktop === true);
  try {
    await expect.poll(() => readFile(join(userData, 'state/console.json'), 'utf8').then(() => true, () => false), { timeout: 10000 }).toBe(true);
  } catch (error) {
    await writeFile('/tmp/graph-desktop-e2e-startup.log', daemonLog);
    throw error;
  }
  const address = async () => JSON.parse(await readFile(join(userData, 'state/console.json'), 'utf8')) as { url: string; pid: number };
  return { root, source, userData, app, page, address };
}

test('the real desktop drawer reserves display space, restores content bounds and uses an overlay when constrained', async () => {
  const { app, page } = await shell();
  const display = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    const base = { x: area.x + area.width - 500, y: area.y + 20, width: 500, height: Math.min(600, area.height - 40) };
    window.setBounds(base, false);
    return { area, base };
  });
  const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
  await expect.poll(bounds).toEqual(display.base);
  expect(await page.evaluate(() => window.graph!.setDrawer!({ open: true, width: 440 }))).toEqual({ expanded: true });
  await expect.poll(bounds).toEqual({ ...display.base, x: display.area.x + display.area.width - 940, width: 940 });
  expect(await page.evaluate(() => window.graph!.setDrawer!({ open: false, width: 440 }))).toEqual({ expanded: false });
  await expect.poll(bounds).toEqual(display.base);
  const full = { ...display.base, x: display.area.x, width: display.area.width - 100 };
  await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]!.setBounds(value, false), full);
  await expect.poll(bounds).toEqual(full);
  expect(await page.evaluate(() => window.graph!.setDrawer!({ open: true, width: 440 }))).toEqual({ expanded: false });
  expect(await bounds()).toEqual(full);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())).toBe(true);
  const maximized = await bounds();
  expect(await page.evaluate(() => window.graph!.setDrawer!({ open: true, width: 440 }))).toEqual({ expanded: false });
  expect(await bounds()).toEqual(maximized);
}, 90000);

test('desktop relaunch stops only its owned daemon and the replacement survives the old stop deadline', async () => {
  const fixture = await shell();
  const config = JSON.parse(await readFile(join(fixture.userData, 'graph.config.json'), 'utf8'));
  expect(config).toEqual({ version: 1, projects: [] });
  const first = await fixture.address();
  expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const startup = await fixture.page.evaluate(async () => (await fetch('/api/startup')).json());
  expect(startup.source.root).toBe(fixture.source);
  // SIGSTOP makes this fixture-owned child unable to handle SIGTERM. The real
  // desktop must reach its force-kill path without affecting any other daemon.
  process.kill(first.pid, 'SIGSTOP');
  const restarted = await fixture.page.evaluate(() => window.graph!.relaunch());
  await expect.poll(async () => (await fixture.address()).pid).not.toBe(first.pid);
  const second = await fixture.address();
  expect(second.pid).not.toBe(first.pid);
  expect(restarted.url).toBe(second.url);
  expect(() => process.kill(first.pid, 0)).toThrow();
  await fixture.page.goto(restarted.url);
  await expect.poll(async () => (await fetch(`${second.url}/api/health`)).status).toBe(200);
  const normal = await fixture.page.evaluate(() => window.graph!.relaunch());
  await expect.poll(async () => (await fixture.address()).pid).not.toBe(second.pid);
  const third = await fixture.address();
  expect(third.pid).not.toBe(second.pid);
  expect(normal.url).toBe(third.url);
  expect(() => process.kill(second.pid, 0)).toThrow();
  // A real clock is essential here: fake timers cannot prove a replacement
  // process survives the abandoned stop timer in the desktop process.
  await new Promise(resolve => setTimeout(resolve, 6000));
  expect((await fetch(`${third.url}/api/health`)).status).toBe(200);
  expect(() => process.kill(third.pid, 0)).not.toThrow();
}, 90000);
