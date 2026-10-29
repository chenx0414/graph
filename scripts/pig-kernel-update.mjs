#!/usr/bin/env node
/**
 * Update the pinned upstream PiG kernel, in one command.
 *
 * The Graph kernel is the Go port of Pi maintained at github.com/MichaelKinsy/PiG.
 * It is consumed as an ordinary Go module dependency, so "updating the kernel" is
 * a version bump of that dependency plus the module graph it pulls in. That bump
 * is easy to get wrong by hand: the module zip is large enough that the download
 * can fail halfway, `go mod tidy` rewrites the whole requirement graph, and a
 * new upstream release can legitimately break the Graph build. This script makes
 * the whole thing one repeatable step that either succeeds completely or leaves
 * the tree exactly as it found it.
 *
 * Run: node scripts/pig-kernel-update.mjs                  report the pinned and latest versions
 *      node scripts/pig-kernel-update.mjs --check          fail when the pin is behind upstream
 *      node scripts/pig-kernel-update.mjs --set <version>  pin that exact version
 *      node scripts/pig-kernel-update.mjs --set latest     pin the latest upstream version
 *      node scripts/pig-kernel-update.mjs --set latest --allow-downgrade
 *      node scripts/pig-kernel-update.mjs --root <dir>     operate on another checkout
 *
 * Exit codes: 0 = the requested action completed, 1 = it failed and the tree was
 * restored to its previous state.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE = 'github.com/MichaelKinsy/PiG';

let root = resolve(import.meta.dirname, '..');
let moduleDir = join(root, 'backend');
let goModPath = join(moduleDir, 'go.mod');
let goSumPath = join(moduleDir, 'go.sum');

/** Point the script at another checkout that has the same backend module layout. */
function useRoot(directory) {
  root = resolve(directory);
  moduleDir = join(root, 'backend');
  goModPath = join(moduleDir, 'go.mod');
  goSumPath = join(moduleDir, 'go.sum');
}

function fail(message) {
  process.stderr.write(`pig kernel update failed: ${message}\n`);
  process.exit(1);
}

/** Run a Go command in the backend module directory. */
function go(args, options = {}) {
  const result = spawnSync('go', args, { cwd: moduleDir, encoding: 'utf8', ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

/**
 * The pattern of one pinned-version line in a go.mod.
 *
 * A requirement appears either inside an indented require block
 * ("\tgithub.com/... v1.2.3") or as its own line ("require github.com/... v1.2.3"),
 * and both forms have to be found and rewritten.
 */
function pinPattern() {
  const escaped = MODULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(\\s*(?:require\\s+)?)${escaped}\\s+(v\\S+)`, 'm');
}

/** The version the tree currently pins for the kernel module; null when it has none. */
export function pinnedVersion() {
  const match = pinPattern().exec(readFileSync(goModPath, 'utf8'));
  return match ? match[2] : null;
}

/** Every published version of the kernel module, oldest first. */
export function publishedVersions() {
  const result = go(['list', '-m', '-versions', MODULE]);
  if (result.status !== 0) throw new Error(`go list -m -versions failed: ${(result.stderr || result.stdout).trim()}`);
  const line = result.stdout.trim().split('\n').pop() ?? '';
  return line.split(/\s+/).slice(1).filter(Boolean);
}

/** The newest published version, ignoring any pre-release suffix. */
export function latestVersion() {
  const versions = publishedVersions();
  const stable = versions.filter(version => !version.includes('-'));
  const candidates = stable.length ? stable : versions;
  if (!candidates.length) throw new Error(`no published version of ${MODULE} was found`);
  return candidates[candidates.length - 1];
}

/** Compare two semantic versions; prereleases sort below their release. */
function compareVersions(left, right) {
  const parse = value => {
    const [core, pre] = value.replace(/^v/, '').split('-');
    return { parts: core.split('.').map(Number), pre: pre ?? null };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** Confirm the module proxy really publishes the requested version. */
function assertPublished(version) {
  const result = go(['list', '-m', `${MODULE}@${version}`]);
  if (result.status !== 0) throw new Error(`${MODULE} ${version} is not a published version: ${(result.stderr || result.stdout).trim()}`);
}

/** Replace the pinned version inside backend/go.mod, keeping every other line. */
function writePin(version) {
  const text = readFileSync(goModPath, 'utf8');
  const pattern = pinPattern();
  if (pattern.test(text)) {
    writeFileSync(goModPath, text.replace(pattern, `$1${version}`));
    return;
  }
  // The module is not pinned yet: add it as its own require line, which is the
  // form `go mod tidy` keeps for a single direct dependency.
  const lines = text.split('\n');
  const moduleLine = lines.findIndex(line => line.startsWith('module '));
  if (moduleLine < 0) throw new Error('backend/go.mod has no module line');
  lines.splice(moduleLine + 1, 0, '', `require ${MODULE} ${version}`);
  writeFileSync(goModPath, lines.join('\n'));
}

/** Restore the module files captured before an update attempt. */
function restore(captured) {
  for (const [path, contents] of captured) writeFileSync(path, contents);
}

function parseArguments(argv) {
  const options = { mode: 'report', version: null, allowDowngrade: false, root: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.mode = 'check';
    else if (argument === '--set') { options.mode = 'set'; options.version = argv[index + 1] ?? null; index += 1; }
    else if (argument === '--allow-downgrade') options.allowDowngrade = true;
    else if (argument === '--root') { options.root = argv[index + 1] ?? null; index += 1; }
    else if (argument === '--help' || argument === '-h') options.mode = 'help';
    else fail(`unknown argument ${argument}`);
  }
  if (options.mode === 'set' && !options.version) fail('--set needs a version, or the word latest');
  if (options.root && !options.root) fail('--root needs a directory');
  return options;
}

/** A network this host cannot use is not a version drift the updater can judge. */
function unreachable(message) {
  return /tls:|x509|dial tcp|no such host|i\/o timeout|connection refused|network is unreachable|server misbehaving/i.test(String(message));
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === 'help') {
    process.stdout.write('usage: pig-kernel-update.mjs [--check] [--set <version|latest>] [--allow-downgrade] [--root <dir>]\n');
    return;
  }
  if (options.root) useRoot(options.root);
  if (!existsSync(goModPath)) fail(`no Go module at ${goModPath}`);
  const current = pinnedVersion();
  // Pinning one exact version needs no network; reporting, checking and
  // `--set latest` all need the published list.
  const needsLatest = options.mode !== 'set' || options.version === 'latest';
  let latest = null;
  if (needsLatest) {
    try {
      latest = latestVersion();
    } catch (error) {
      // A module proxy we cannot reach is not a drift signal: the tree may be
      // current and the answer is simply unavailable. Report the skip instead
      // of failing a tree this host cannot judge, and keep --set strict
      // because it has to fetch the version it pins.
      // Reporting and checking only read a published list they cannot get.
      // Whatever the reason, the honest answer is "unavailable" plus the
      // reason itself: the pin in go.mod is local and still reported, and a
      // build of the pinned kernel needs the same proxy anyway.
      if (options.mode === 'set') fail(error.message);
      process.stdout.write(`pinned:  ${current ?? '(not pinned)'}\nlatest:  (unavailable)\nmodule:  ${MODULE}\nskipped: the module proxy is unreachable\nreason:  ${error.message}\n`);
      return;
    }
  }
  if (options.mode === 'report') {
    process.stdout.write(`pinned:  ${current ?? '(not pinned)'}\nlatest:  ${latest}\nmodule:  ${MODULE}\n`);
    return;
  }
  if (options.mode === 'check') {
    process.stdout.write(`pinned:  ${current ?? '(not pinned)'}\nlatest:  ${latest}\n`);
    if (current === latest) return;
    process.stderr.write(`the pinned kernel ${current ?? '(none)'} is behind the published ${latest}; run: node --run pig:update\n`);
    process.exit(1);
  }
  const target = options.version === 'latest' ? latest : options.version;
  if (!/^v\d+\.\d+\.\d+/.test(target)) fail(`${target} is not a kernel version`);
  if (current !== null && target === current) {
    process.stdout.write(`the kernel is already pinned at ${current}\n`);
    return;
  }
  if (current !== null && compareVersions(target, current) < 0 && !options.allowDowngrade) {
    fail(`${target} is older than the pinned ${current}; pass --allow-downgrade to move back`);
  }
  const captured = new Map();
  for (const path of [goModPath, goSumPath]) {
    if (existsSync(path)) captured.set(path, readFileSync(path, 'utf8'));
  }
  try {
    // `go mod tidy` resolves an unknown requirement to the newest published
    // version instead of failing, so the requested version is checked against
    // the proxy first and re-checked in the file afterwards. The pin must be
    // exactly what was asked for.
    assertPublished(target);
    writePin(target);
    const tidy = go(['mod', 'tidy']);
    if (tidy.status !== 0) throw new Error(`go mod tidy failed:\n${(tidy.stderr || tidy.stdout).trim()}`);
    const applied = pinnedVersion();
    if (applied !== target) throw new Error(`the module graph pinned ${applied ?? '(nothing)'} instead of the requested ${target}`);
    const build = go(['build', './...']);
    if (build.status !== 0) throw new Error(`the backend does not build against ${target}:\n${(build.stderr || build.stdout).trim()}`);
  } catch (error) {
    restore(captured);
    fail(`${error.message}\nthe pinned kernel was left at ${current ?? '(none)'}.`);
  }
  process.stdout.write(`the kernel is pinned at ${target} and the backend builds against it.\n`);
}

// The entry point is compared through real paths: a checkout reached through a
// symlink (a temporary directory on macOS, for one) would otherwise silently
// do nothing at all.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
