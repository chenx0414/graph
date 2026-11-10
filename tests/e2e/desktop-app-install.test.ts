/**
 * The packaged app the reader launches has to be the one this checkout built.
 *
 * RSI reported `app:build` as activation for months while /Applications kept a
 * bundle from 2026-10-20: the shell half of every change since then never ran,
 * and the receipt said it had. This exercises the step that was missing, through
 * its real CLI, a real bundle layout and real code signing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

const script = join(process.cwd(), 'scripts/install-desktop-app.mjs');

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Graph</string>
  <key>CFBundleIdentifier</key><string>dev.graph.fixture</string>
  <key>CFBundleName</key><string>Graph</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
</dict>
</plist>
`;

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'graph-app-install-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'checkout');
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(join(root, 'app/main.go'), 'package main\n');
  await writeFile(join(root, 'app/mygo.json'), JSON.stringify({ identifier: 'dev.graph.fixture' }));
  const bundle = join(parent, 'stage/Graph.app');
  await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
  await mkdir(join(bundle, 'Contents/Resources'), { recursive: true });
  await writeFile(join(bundle, 'Contents/Info.plist'), plist);
  await writeFile(join(bundle, 'Contents/MacOS/Graph'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(bundle, 'Contents/Resources/AppIcon.icns'), 'icon\n');
  await older(join(root, 'app/main.go'));
  await older(join(root, 'app/mygo.json'));
  await older(join(bundle, 'Contents/MacOS/Graph'));
  const dest = join(parent, 'Applications/Graph.app');
  return { parent, root, bundle, dest };
}

const install = (root: string, bundle: string, dest: string) => spawnSync(
  process.execPath,
  [script, '--root', root, '--bundle', bundle, '--dest', dest],
  { encoding: 'utf8' },
);

const older = (target: string) => utimes(target, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

test('installs the bundle this checkout built, signed and verifiable', async () => {
  const { root, bundle, dest } = await fixture();
  const binary = join(bundle, 'Contents/MacOS/Graph');
  const run = install(root, bundle, dest);
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  expect(await readFile(join(dest, 'Contents/MacOS/Graph'), 'utf8')).toBe(await readFile(binary, 'utf8'));
  const verify = spawnSync('codesign', ['--verify', '--strict', dest], { encoding: 'utf8' });
  expect(verify.stderr).toBe('');
  expect(verify.status).toBe(0);
});

test('keeps the copy it replaces, so a bad launch can be undone', async () => {
  const { root, bundle, dest } = await fixture();
  await mkdir(join(dest, 'Contents'), { recursive: true });
  await writeFile(join(dest, 'Contents/Info.plist'), plist.replace('dev.graph.fixture', 'dev.graph.previous'));
  const run = install(root, bundle, dest);
  expect(run.status).toBe(0);
  expect(await readFile(join(`${dest}.previous/Contents/Info.plist`), 'utf8')).toContain('dev.graph.previous');
});

test('refuses a package older than the sources it claims to contain', async () => {
  const { root, bundle, dest } = await fixture();
  const future = new Date(Date.now() + 60_000);
  await utimes(join(root, 'app/main.go'), future, future);
  const run = install(root, bundle, dest);
  expect(run.status).toBe(3);
  expect(run.stderr).toContain('main.go');
  expect(run.stderr).toContain('run: node --run app:build');
  expect(existsSync(dest)).toBe(false);
});

test('refuses a bundle whose identifier keys permissions to another app', async () => {
  const { root, bundle, dest } = await fixture();
  await writeFile(join(root, 'app/mygo.json'), JSON.stringify({ identifier: 'dev.graph.previous' }));
  await older(join(root, 'app/mygo.json'));
  const run = install(root, bundle, dest);
  expect(run.status).toBe(3);
  expect(run.stderr).toContain('dev.graph.previous');
  expect(existsSync(dest)).toBe(false);
});

test('a bundle that is not an app at all never replaces the app that works', async () => {
  const { root, bundle, dest } = await fixture();
  await mkdir(join(dest, 'Contents'), { recursive: true });
  await writeFile(join(dest, 'Contents/Info.plist'), plist);
  await rm(join(bundle, 'Contents/Info.plist'));
  const run = install(root, bundle, dest);
  expect(run.status).toBe(4);
  expect(existsSync(join(dest, 'Contents/Info.plist'))).toBe(true);
});

test('a dry run names both sides and installs nothing', async () => {
  const { root, bundle, dest } = await fixture();
  const run = spawnSync(process.execPath, [script, '--root', root, '--bundle', bundle, '--dest', dest, '--dry-run'], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  expect(run.stdout).toContain(`would install ${bundle} -> ${dest}`);
  expect(existsSync(dest)).toBe(false);
});

test('the identifier check reads app/mygo.json, not a hardcoded string', async () => {
  const { root, bundle, dest } = await fixture();
  await writeFile(join(root, 'app/mygo.json'), JSON.stringify({ identifier: 'dev.graph.other' }));
  await older(join(root, 'app/mygo.json'));
  const run = install(root, bundle, dest);
  expect(run.status).toBe(3);
  expect(run.stderr).toContain('dev.graph.other');
  expect(readFileSync(join(root, 'app/mygo.json'), 'utf8')).toContain('dev.graph.other');
  expect((await stat(join(bundle, 'Contents/MacOS/Graph'))).isFile()).toBe(true);
});
