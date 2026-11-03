import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { cacheControl, freshShell, rebuild } from '../helpers/fresh-shell.ts';

/**
 * A rebuilt console must reach the browser at the same address.
 *
 * The failure this covers is not "the new feature is broken" but "the browser
 * never asked for it": the shell document (index.html) names the bundle, so a
 * client that keeps the old document keeps loading the old bundle, and a person
 * reloading the console sees the previous build. That is indistinguishable from
 * a change that did not ship.
 *
 * This file is the half that any machine can run: a real graphd, a real web
 * directory rewritten underneath it, and real HTTP requests to the same URL.
 * The browser half lives in console-fresh-shell-browser.test.ts and needs
 * window services, so that one is registered in tests/env-layers.json.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('console-shell-reload HTTP：同一个 URL 返回新文档', async () => {
  const { webDir, url } = await freshShell(cleanup);

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

test('console-shell-reload HTTP：内容哈希的资源可以永久缓存，普通名字必须回源', async () => {
  const { webDir, url } = await freshShell(cleanup);

  // The shell names the bundle, so the name is the identity of those bytes:
  // a rebuilt console publishes new names (vite emits index-<hash>.js) and the
  // old ones can never change meaning. Re-fetching them on every reload is the
  // cost this header removes, and the shell's no-store is what keeps the names
  // fresh.
  await writeFile(join(webDir, 'assets', 'index-CdM9mI3F.js'), 'const n = 1;\n');
  const hashed = await fetch(`${url}assets/index-CdM9mI3F.js`);
  expect(hashed.status).toBe(200);
  expect(cacheControl(hashed.headers), 'a content-hashed asset may be cached forever')
    .toContain('immutable');

  // A name without a hash keeps its identity while its bytes may change, so it
  // must not be cached as if it were immutable.
  const plain = await fetch(`${url}assets/bundle-a.js`);
  expect(plain.status).toBe(200);
  expect(cacheControl(plain.headers), 'an unhashed asset must revalidate').toContain('no-cache');
  expect(cacheControl(plain.headers)).not.toContain('immutable');
});

test('console-shell-reload HTTP：占位页分支同样不可缓存', async () => {
  const { webDir, url } = await freshShell(cleanup);

  // serveHome falls back to appDefaultPage when the shell cannot be read. The
  // startup check only proves the document exists when the daemon starts, so
  // the fallback is reachable at runtime - measured here, not assumed: the
  // first version of this test claimed the opposite and never covered it.
  await rm(join(webDir, 'index.html'));

  const fallback = await fetch(url);
  expect(fallback.status).toBe(200);
  expect(cacheControl(fallback.headers), 'the fallback page is served from the same handler').toContain('no-store');
  const body = await fallback.text();
  expect(body).toContain('id="root"');
  expect(body).not.toContain('/assets/');
});
