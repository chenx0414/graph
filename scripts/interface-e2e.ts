/** UI/UX regression owner: real daemon, persisted project config and Chromium; no app mocks.
 * Run after build:web: node scripts/interface-e2e.ts. Screenshots stay under tmpdir.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from 'playwright/test';

/**
 * Where the console is listening. The daemon publishes this file in its state
 * directory once the socket is bound; nothing else records the port, because the
 * daemon is started with `--port 0`.
 */
async function readConsoleAddress(stateDir) {
  const raw = await readFile(join(stateDir, 'console.json'), 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    return typeof value?.url === 'string' && value.url.startsWith('http') ? { url: value.url } : null;
  } catch {
    return null;
  }
}

const repo = join(import.meta.dirname, '..');
const root = await mkdtemp(join(tmpdir(), 'graph-interface-e2e-'));
const state = join(root, 'state');
const workspace = join(root, 'project');
await mkdir(workspace);
const config = join(root, 'config.json');
await writeFile(config, JSON.stringify({ version: 1, projects: [] }));
const daemon = spawn(process.execPath, [join(repo, 'src/server/cli.ts'), '--view-only', '--config', config,
  '--state-dir', state, '--graph-home', join(root, 'home'), '--web-dir', join(repo, 'dist/web'), '--port', '0'],
{ cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
daemon.stdout.on('data', chunk => { log += String(chunk); });
daemon.stderr.on('data', chunk => { log += String(chunk); });
const browser = await chromium.launch();
try {
  let url = '';
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const record = await readConsoleAddress(state);
    if (record) { url = record.url; break; }
    if (daemon.exitCode !== null) throw new Error(log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(url, log);
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await expect(page.getByRole('heading', { name: '开始新对话' })).toBeVisible();
  await expect(page.getByRole('link', { name: '连接模型', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /了解项目/ }).click();
  const input = page.getByTestId('new-conversation-input');
  await expect(input).toContainText('帮我梳理这个项目');
  await expect(input).toBeFocused();
  await page.getByRole('button', { name: /开发功能/ }).click({ force: true });
  await expect(input).toContainText('帮我梳理这个项目');
  const conversations = await page.request.get(new URL('/api/conversations', url).href);
  assert.deepEqual(await conversations.json(), [], 'Choosing an example must not send a message');
  await page.screenshot({ animations: 'disabled', path: join(root, 'home-desktop.png') });

  await page.getByTestId('sidebar-toggle').click();
  await expect(page.locator('.sidebar').getByRole('link', { name: '新对话', exact: true })).toBeVisible();
  await page.getByTestId('sidebar-toggle').click();
  const trigger = page.getByTestId('project-create-open');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '创建项目' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('textbox', { name: '项目名称' })).toBeFocused();
  for (let i = 0; i < 9; i += 1) {
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(el => el.contains(document.activeElement) || document.activeElement === document.body), true, 'No background control may receive focus; Chromium may focus its browser chrome');
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('textbox', { name: '项目名称' }).fill('interface-project');
  await page.getByRole('textbox', { name: '源文件夹' }).fill(workspace);
  await page.getByTestId('project-create').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.sidebar-project-name')).toHaveText('interface-project');
  const settings = await page.request.get(new URL('/api/settings', url).href);
  assert.ok((await settings.json()).projects.some((project: { id: string; root: string }) => project.id === 'interface-project' && project.root === workspace));
  await page.reload();
  await expect(page.locator('.sidebar-project-name')).toHaveText('interface-project');

  // Reflow, not a scaled screenshot: controls must be reachable in the actual scroll tree.
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(url);
    await expect(page.getByTestId('new-conversation-start')).toBeAttached();
    const send = page.getByTestId('new-conversation-start');
    await send.scrollIntoViewIfNeeded();
    await expect(send).toBeInViewport();
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true, `reflow ${width}`);
    await page.screenshot({ animations: 'disabled', path: join(root, `home-${width}.png`) });
  }
  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByTestId('sidebar-toggle').click();
  // The toggle may close a desktop-open sidebar after resizing; open it explicitly if needed.
  if (await trigger.isHidden()) await page.getByTestId('sidebar-toggle').click();
  await trigger.click();
  await expect(dialog).toBeInViewport();
  await page.getByTestId('project-cancel').click();
  await expect(trigger).toBeFocused();

  for (const route of ['inbox', 'catalog', 'tools', 'models', 'settings']) {
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(new URL(`/#/${route}`, url).href);
      await expect(page.locator('body')).toContainText(route === 'settings' ? '常规' : 'Graph');
      assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true, `${route} ${width}`);
      await page.screenshot({ animations: 'disabled', path: join(root, `${route}-${width}.png`) });
    }
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log(`PASS: onboarding, no accidental send, persisted project, modal keyboard/focus, 4 widths and 5 routes. Screenshots: ${root}`);
} finally {
  await browser.close();
  daemon.kill('SIGTERM');
  await new Promise<void>(resolve => {
    if (daemon.exitCode !== null) { resolve(); return; }
    const timeout = setTimeout(() => { daemon.kill('SIGKILL'); resolve(); }, 6_000);
    daemon.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}
