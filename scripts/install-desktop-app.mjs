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
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBundleSigning, signingIdentity } from './signing-identity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const flag = name => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : (process.argv[at + 1] ?? '');
};
const root = resolve(flag('root') || join(here, '..'));
const bundle = resolve(flag('bundle') || join(root, 'dist/app/mac-arm64/Graph.app'));
const dest = resolve(flag('dest') || '/Applications/Graph.app');
const dryRun = process.argv.includes('--dry-run');

/** The newest modification time of the shell sources this checkout builds from.
 * Only the files directly in `app/`: `go tool mygo build` writes throwaway
 * staging trees under `app/build/`, and a build artefact newer than the binary
 * it just produced is not a stale package. */
async function newestSource(source) {
  let newest = { at: 0, name: '' };
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const path = join(source, entry.name);
    const { mtimeMs } = await stat(path);
    if (mtimeMs > newest.at) newest = { at: mtimeMs, name: entry.name };
  }
  return newest;
}

/**
 * The package has to be built from the sources of THIS checkout. A stale bundle
 * installs a version of the app that silently disagrees with the commit the
 * receipt names, which is the exact failure this script exists to stop: a
 * source file newer than the packaged binary means the package predates it.
 */
async function stalePackage() {
  const source = join(root, 'app');
  const binary = join(bundle, 'Contents/MacOS/Graph');
  if (!existsSync(source) || !existsSync(binary)) return null;
  const newest = await newestSource(source);
  const { mtimeMs } = await stat(binary);
  if (newest.at > mtimeMs) return { relative: newest.name, reason: 'is newer than the packaged binary' };
  return null;
}

function executableIn(target) {
  const directory = join(target, 'Contents', 'MacOS');
  const binaries = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name);
  if (binaries.length !== 1) {
    throw new Error(`${target} carries ${binaries.length} files in Contents/MacOS, so the shell binary is ambiguous`);
  }
  return join(directory, binaries[0]);
}

function sign(target) {
  try {
    const requirement = installBundleSigning(target, executableIn(target));
    console.log(`[graph] signed with ${signingIdentity}: ${requirement}`);
    return;
  } catch (error) {
    console.warn(
      `[graph] the local signing identity is unavailable (${error instanceof Error ? error.message : String(error)}); ` +
      'falling back to an ad-hoc signature, so macOS will drop the accessibility grant on the next rebuild',
    );
  }
  execFileSync('codesign', ['--force', '--sign', '-', target], { stdio: 'pipe' });
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
const stale = await stalePackage();
if (stale) {
  console.error(
    `${bundle} does not match ${root}/app (${stale.relative}: ${stale.reason}). ` +
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
  sign(dest);
} catch (error) {
  await rm(dest, { recursive: true, force: true });
  if (hadPrevious) await rename(previous, dest);
  console.error(`could not install ${bundle}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(4);
}
console.log(`installed ${dest} from ${bundle}${hadPrevious ? `; the replaced copy is at ${previous}` : ''}`);
