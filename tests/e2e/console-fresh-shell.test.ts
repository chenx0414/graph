import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { chromium } from 'playwright';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A rebuilt console must reach the browser at the same address.
 *
 * The failure this covers is not "the new feature is broken" but "the browser
 * never asked for it": the shell document (index.html) names the bundle, so a
 * client that keeps the old document keeps loading the old bundle, and a person
 * reloading the console sees the previous build. That is indistinguishable from
 * a change that did not ship, which is why the fix and this proof are one case:
 * a real graphd, a real web directory that gets rewritten underneath it, and a
 * real HTTP request to the same URL.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

/** The smallest console shell that still has the property under test: it names its bundle. */
function shellHtml(bundle: string) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>shell</title>
<script type="module" src="/assets/${bundle}"></script></head>
<body><div id="root"></div></body></html>
`;
}

/** The bundle is only there to be recognisable: its marker text is the build stamp. */
function bundleJs(stamp: string) {
  return `const marker = document.createElement('div');
marker.setAttribute('data-testid', 'bundle-marker');
marker.textContent = '${stamp}';
document.body.appendChild(marker);
`;
}

async function shell() {
  const root = await mkdtemp(join(tmpdir(), 'graph-fresh-shell-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const webDir = join(root, 'web');
  await mkdir(join(webDir, 'assets'), { recursive: true });
  await mkdir(join(root, 'graph-home', 'capabilities'), { recursive: true });
  await writeFile(join(webDir, 'index.html'), shellHtml('bundle-a.js'));
  await writeFile(join(webDir, 'assets', 'bundle-a.js'), bundleJs('a'));
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }] }));
  const daemon = await launchCli(root, { configPath, webDir });
  cleanup.push(() => daemon.close());
  return { webDir, daemon, url: `${daemon.url}/` };
}

/** A rebuild: a new bundle appears and the shell document starts pointing at it. */
async function rebuild(webDir: string) {
  await writeFile(join(webDir, 'assets', 'bundle-b.js'), bundleJs('b'));
  await writeFile(join(webDir, 'index.html'), shellHtml('bundle-b.js'));
}

function cacheControl(headers: Headers) {
  return headers.get('cache-control') ?? '';
}

test('console-shell-reload HTTP：同一个 URL 返回新文档', async () => {
  const { webDir, url } = await shell();

  const before = await fetch(url);
  expect(before.status).toBe(200);
  // The document names the bundle, so caching it caches the build.
  expect(cacheControl(before.headers), 'the shell document must not be stored by the client').toContain('no-store');
  expect(await before.text()).toContain('/assets/bundle-a.js');

  await rebuild(webDir);

  // Same URL, no cache-busting query string: this is exactly what a reload does.
  const after = await fetch(url);
  expect(after.status).toBe(200);
  expect(cacheControl(after.headers)).toContain('no-store');
  const body = await after.text();
  expect(body).toContain('/assets/bundle-b.js');
  expect(body).not.toContain('bundle-a.js');
});

test('console-shell-reload browser：同一个 URL 重载显示新包', async () => {
  const { webDir, url } = await shell();
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
  expect(document.headers()['cache-control'] ?? '', 'the reloaded document must not be stored').toContain('no-store');
  // A read that lands while the new document is still replacing the old one
  // loses its execution context; that is the reload in progress, not a verdict.
  await expect.poll(async () => marker.textContent({ timeout: 1_000 }).catch(() => null)).toBe('b');
  // Still the same address: no query string, no new tab, no cache-busting.
  expect(page.url()).toBe(url);
});
