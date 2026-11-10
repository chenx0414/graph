/**
 * Install the packaged Graph.app this checkout built into the folder the reader
 * actually launches.
 *
 * RSI treated `app:build` as activation. The package it built lived in the
 * isolated worktree and in `dist/app`, and /Applications kept the bundle from
 * 2026-10-20: the desktop half of every change since then never ran, while the
 * receipt said it was live. Measured 2026-11-05, after three receipts that
 * claimed a keychain fix the reader could not see.
 *
 * Run: node scripts/install-desktop-app.mjs [--root DIR] [--bundle PATH] [--dest PATH] [--dry-run]
 * Exit: 0 installed, 2 usage, 3 package does not match the checkout, 4 signing failed.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, rename } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const flag = name => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : (process.argv[at + 1] ?? '');
};
const root = resolve(flag('root') || join(here, '..'));
const bundle = resolve(flag('bundle') || join(root, 'dist/app/mac-arm64/Graph.app'));
const dest = resolve(flag('dest') || '/Applications/Graph.app');
const dryRun = process.argv.includes('--dry-run');

/** Every file the package carries from `source`, relative to it. */
async function filesUnder(source, prefix = '') {
  const names = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...await filesUnder(join(source, entry.name), relative));
    else names.push(relative);
  }
  return names;
}

/**
 * The package has to carry the desktop code of THIS checkout. A stale bundle
 * installs a version of the app that silently disagrees with the commit the
 * receipt names, which is the exact failure this script exists to stop.
 */
async function staleCheckoutFile() {
  const source = join(root, 'desktop');
  const packaged = join(bundle, 'Contents/Resources/app/desktop');
  if (!existsSync(source) || !existsSync(packaged)) return null;
  for (const relative of await filesUnder(source)) {
    const expected = join(source, relative);
    const actual = join(packaged, relative);
    if (!existsSync(actual)) return { relative, reason: 'missing from the package' };
    const [left, right] = await Promise.all([readFile(expected), readFile(actual)]);
    if (!left.equals(right)) return { relative, reason: 'differs from this checkout' };
  }
  return null;
}

async function sign(target) {
  // `--deep` is not decoration: electron-builder leaves the nested frameworks
  // without a usable signature, and a shallow sign then fails on the first
  // subcomponent (measured 2026-11-05: "In subcomponent: Mantle.framework").
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'pipe' });
  execFileSync('codesign', ['--verify', '--strict', target], { stdio: 'pipe' });
}

function identifierMismatch() {
  const config = join(root, 'app', 'mygo.json');
  const info = join(bundle, 'Contents/Info.plist');
  if (!existsSync(config) || !existsSync(info)) return null;
  const expected = JSON.parse(readFileSync(config, 'utf8')).identifier;
  if (!expected) return null;
  const actual = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', info], { encoding: 'utf8' }).trim();
  return actual === expected ? null : { expected, actual };
}

if (!existsSync(bundle)) {
  console.error(`no packaged app at ${bundle}; run: node --run app:build`);
  process.exit(3);
}
const mismatch = identifierMismatch();
if (mismatch) {
  console.error(
    `${bundle} is ${mismatch.actual} and app/mygo.json says ${mismatch.expected}; ` +
    'installing it would key permissions to another app; run: node --run app:build',
  );
  process.exit(3);
}
const stale = await staleCheckoutFile();
if (stale) {
  console.error(
    `${bundle} does not match ${root}/desktop (${stale.relative}: ${stale.reason}). ` +
    'Installing it would run code the commit does not contain; run: node --run app:build',
  );
  process.exit(3);
}
if (!existsSync(join(bundle, 'Contents/Info.plist'))) {
  console.error(`${bundle} is not an application bundle (no Contents/Info.plist); refusing to install it`);
  process.exit(4);
}
if (dryRun) {
  console.log(`would install ${bundle} -> ${dest}`);
  process.exit(0);
}

const previous = `${dest}.previous`;
await mkdir(dirname(dest), { recursive: true });
const hadPrevious = existsSync(dest);
if (hadPrevious) {
  await rm(previous, { recursive: true, force: true });
  await rename(dest, previous);
}
try {
  // ditto, not a recursive copy: a framework carries symlinks (Versions/Current,
  // the binary alias) and a copy that dereferences them leaves a file in the
  // framework root, which codesign then refuses to seal (measured 2026-11-05).
  execFileSync('ditto', [bundle, dest], { stdio: 'pipe' });
  await sign(dest);
} catch (error) {
  await rm(dest, { recursive: true, force: true });
  if (hadPrevious) await rename(previous, dest);
  console.error(`could not install ${bundle}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(4);
}
console.log(`installed ${dest} from ${bundle}${hadPrevious ? `; the replaced copy is at ${previous}` : ''}`);
