/**
 * The packaged app the reader launches has to be the one this checkout built.
 *
 * RSI reported `app:build` as activation for months while /Applications kept a
 * bundle from 2026-10-20: the desktop half of every change since then never ran,
 * and the receipt said it had (measured 2026-11-05, keychain fix reported live
 * three times without a single line of it running). This exercises the step that
 * was missing, through its real CLI, a real bundle layout and real code signing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

const frameworkPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Mantle</string>
  <key>CFBundleIdentifier</key><string>dev.graph.fixture.mantle</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
</dict></plist>
`;

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'graph-app-install-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'checkout');
  await mkdir(join(root, 'desktop'), { recursive: true });
  await writeFile(join(root, 'desktop/main.mjs'), 'export const main = "checkout";\n');
  await writeFile(join(root, 'desktop/lib.ts'), 'export const lib = "checkout";\n');
  const bundle = join(parent, 'stage/Graph.app');
  await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
  await mkdir(join(bundle, 'Contents/Resources/app/desktop'), { recursive: true });
  await writeFile(join(bundle, 'Contents/Info.plist'), plist);
  await writeFile(join(bundle, 'Contents/MacOS/Graph'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(bundle, 'Contents/Resources/app/desktop/main.mjs'), 'export const main = "checkout";\n');
  await writeFile(join(bundle, 'Contents/Resources/app/desktop/lib.ts'), 'export const lib = "checkout";\n');
  const dest = join(parent, 'Applications/Graph.app');
  return { parent, root, bundle, dest };
}

const install = (root: string, bundle: string, dest: string) => spawnSync(
  process.execPath,
  [script, '--root', root, '--bundle', bundle, '--dest', dest],
  { encoding: 'utf8' },
);

test('installs the bundle this checkout built, signed and verifiable', async () => {
  const { root, bundle, dest } = await fixture();
  const run = install(root, bundle, dest);
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  expect(await readFile(join(dest, 'Contents/Resources/app/desktop/main.mjs'), 'utf8'))
    .toBe(await readFile(join(root, 'desktop/main.mjs'), 'utf8'));
  const verify = spawnSync('codesign', ['--verify', '--strict', dest], { encoding: 'utf8' });
  expect(verify.stderr).toBe('');
  expect(verify.status).toBe(0);
});

test('keeps the copy it replaces, so a bad launch can be undone', async () => {
  const { root, bundle, dest } = await fixture();
  expect(install(root, bundle, dest).status).toBe(0);
  await writeFile(join(root, 'desktop/main.mjs'), 'export const main = "second";\n');
  await writeFile(join(bundle, 'Contents/Resources/app/desktop/main.mjs'), 'export const main = "second";\n');
  const again = install(root, bundle, dest);
  expect(again.status).toBe(0);
  expect(await readFile(join(dest, 'Contents/Resources/app/desktop/main.mjs'), 'utf8')).toContain('second');
  expect(await readFile(`${dest}.previous/Contents/Resources/app/desktop/main.mjs`, 'utf8')).toContain('checkout');
});

test('signs the nested code electron-builder leaves unsigned, instead of giving up on it', async () => {
  const { root, bundle, dest } = await fixture();
  // A real Mach-O in a real framework layout: copying the binary is enough for
  // codesign to treat it as nested code it has to seal.
  const framework = join(bundle, 'Contents/Frameworks/Mantle.framework');
  await mkdir(join(framework, 'Versions/A/Resources'), { recursive: true });
  await cpSync('/bin/echo', join(framework, 'Versions/A/Mantle'));
  await writeFile(join(framework, 'Versions/A/Resources/Info.plist'), frameworkPlist);
  await symlink('A', join(framework, 'Versions/Current'));
  await symlink('Versions/Current/Mantle', join(framework, 'Mantle'));
  const run = install(root, bundle, dest);
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', dest], { encoding: 'utf8' });
  expect(verify.stderr).toBe('');
  expect(verify.status).toBe(0);
});

test('refuses a package that does not carry this checkout, and leaves the installed app alone', async () => {
  const { root, bundle, dest } = await fixture();
  expect(install(root, bundle, dest).status).toBe(0);
  const before = await readFile(join(dest, 'Contents/Resources/app/desktop/main.mjs'), 'utf8');
  await writeFile(join(root, 'desktop/main.mjs'), 'export const main = "never packaged";\n');
  const stale = install(root, bundle, dest);
  expect(stale.status).toBe(3);
  expect(stale.stderr).toContain('app:build');
  expect(await readFile(join(dest, 'Contents/Resources/app/desktop/main.mjs'), 'utf8')).toBe(before);
});

test('a bundle that is not an app at all never replaces the app that works', async () => {
  const { root, bundle, dest } = await fixture();
  expect(install(root, bundle, dest).status).toBe(0);
  const before = await readFile(join(dest, 'Contents/Resources/app/desktop/main.mjs'), 'utf8');
  await rm(join(bundle, 'Contents/Info.plist'));
  await writeFile(join(root, 'desktop/main.mjs'), 'export const main = "unsigned";\n');
  await writeFile(join(bundle, 'Contents/Resources/app/desktop/main.mjs'), 'export const main = "unsigned";\n');
  const broken = install(root, bundle, dest);
  expect(broken.status).toBe(4);
  expect(broken.stderr).toContain('Info.plist');
  expect(await readFile(join(dest, 'Contents/Resources/app/desktop/main.mjs'), 'utf8')).toBe(before);
  expect(existsSync(`${dest}.previous`)).toBe(false);
});
