import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { canonicalJson } from '../../src/core/store.ts';
import { ensureRequiredPeers, installRootGaps, packageGaps } from '../../src/runtime/pi-extension-source.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

/**
 * The incident this covers: `<graphHome>/extensions/…/node_modules/zod` existed but was
 * truncated (its whole `v4/` directory was missing), so `pi-mcp-adapter` failed to load with
 * `Cannot find module './v4/classic/external.js'`. The guard at the time tested only
 * `existsSync` of the peer directory, so a partial install counted as installed and was never
 * repaired — and because the adapter became a base capability, that blocked every Agent.
 */
test('a truncated peer package is reported as a gap while a complete one is not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-peer-gaps-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const complete = join(root, 'complete');
  const truncated = join(root, 'truncated');
  await Promise.all([mkdir(join(complete, 'v4', 'classic'), { recursive: true }), mkdir(truncated, { recursive: true })]);
  await writeFile(join(complete, 'index.js'), 'export * from "./v4/classic/external.js";\n');
  await writeFile(join(complete, 'v4', 'classic', 'external.js'), 'export const external = 1;\n');
  await writeFile(join(truncated, 'index.js'), 'export * from "./v4/classic/external.js";\n');
  const manifest = canonicalJson({
    name: 'zod', version: '4.6.5', main: './index.js',
    exports: { '.': { import: './index.js' }, './v4/classic/external.js': './v4/classic/external.js', './*': './*' },
  });
  await Promise.all([
    writeFile(join(complete, 'package.json'), manifest),
    writeFile(join(truncated, 'package.json'), manifest),
  ]);

  expect(await packageGaps(complete)).toEqual([]);
  expect(await packageGaps(truncated)).toContain('v4/classic/external.js');
  expect((await packageGaps(join(root, 'missing'))).length).toBeGreaterThan(0);
});

test('a required peer that is present but incomplete is reinstalled before the extension loads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-peer-repair-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { entry, peer } = await truncatedPeerFixture(root);
  const calls = await stubNpm(root, { heal: true });

  await ensureRequiredPeers(entry);

  expect(calls()).toContain('zod@^4.0.0');
  expect(existsSync(join(peer, 'v4', 'classic', 'external.js'))).toBe(true);
});

test('a peer that stays incomplete after reinstalling is still handed to the load, never blocked by the guess', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-peer-still-broken-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { entry } = await truncatedPeerFixture(root);
  const calls = await stubNpm(root, { heal: false });

  // The repair runs, but a static gap check must never become a new way to stop a session: the
  // extension load itself is the authority on whether the installed tree works.
  await expect(ensureRequiredPeers(entry)).resolves.toBeUndefined();
  expect(calls()).toContain('zod@^4.0.0');
});

test('a package that declares an extension-less main is not mistaken for a truncated one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-peer-extensionless-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  // `ms` ships `index.js` while declaring `main: "./index"`.
  await writeFile(join(root, 'package.json'), canonicalJson({ name: 'ms', version: '2.1.3', main: './index' }));
  await writeFile(join(root, 'index.js'), 'module.exports = () => {};\n');

  expect(await packageGaps(root)).toEqual([]);
});

test('a custom export condition pointing at a source file is not a gap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-peer-custom-condition-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  // `@standard-schema/spec` ships only its built output while declaring a custom condition that
  // points at `./src/index.ts`. That condition is not a runtime entry here, so it is not a gap.
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', 'index.js'), 'export const spec = 1;\n');
  await writeFile(join(root, 'package.json'), canonicalJson({
    name: '@standard-schema/spec', version: '1.0.0',
    exports: { '.': { 'standard-schema-spec': './src/index.ts', import: { types: './dist/index.d.ts', default: './dist/index.js' } } },
  }));

  expect(await packageGaps(root)).toEqual([]);
});

test('a damaged dependency anywhere in the install root is reported as a gap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-install-root-gaps-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const nodeModules = join(root, 'node_modules');
  const healthy = join(nodeModules, 'healthy');
  const damaged = join(nodeModules, '@scope', 'damaged');
  await Promise.all([healthy, damaged].map(path => mkdir(path, { recursive: true })));
  for (const [dir, name] of [[healthy, 'healthy'], [damaged, 'damaged']] as const) {
    await writeFile(join(dir, 'index.js'), 'export const value = 1;\n');
    await writeFile(join(dir, 'package.json'), canonicalJson({
      name, version: '1.0.0', main: './index.js', exports: { '.': { import: './dist/index.js' } },
    }));
  }
  await mkdir(join(healthy, 'dist'), { recursive: true });
  await writeFile(join(healthy, 'dist', 'index.js'), 'export const value = 1;\n');

  const gaps = await installRootGaps(root);
  expect(gaps.join('\n')).toContain('@scope/damaged');
  expect(gaps.join('\n')).not.toContain('healthy');
});

test('a declared root entry the publisher never shipped is still reported, but is only a diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-install-diagnostic-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const nodeModules = join(root, 'node_modules');
  const pkg = join(nodeModules, '@modelcontextprotocol', 'sdk');
  await mkdir(join(pkg, 'dist', 'esm'), { recursive: true });
  await writeFile(join(pkg, 'dist', 'esm', 'inMemory.js'), 'export const memory = 1;\n');
  await writeFile(join(pkg, 'package.json'), canonicalJson({
    name: '@modelcontextprotocol/sdk', version: '1.30.1',
    exports: { '.': { import: './dist/esm/index.js' } },
  }));

  // `npm pack @modelcontextprotocol/sdk@1.30.1` declares this entry and ships no such file, so a
  // gap is a published-package quirk — it must stay a diagnostic, never a reason to delete or
  // rebuild the shared install root. See `shared-extension-install-2026-09-25.md`.
  expect((await installRootGaps(root)).join('\n')).toContain('@modelcontextprotocol/sdk');
});

test('a peer that declares a bare relative main is still checked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-peer-bare-main-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  // `ajv` and `cross-spawn` declare `main` without a `./` prefix.
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), canonicalJson({ name: 'ajv', version: '8.17.1', main: 'dist/ajv.js' }));

  expect(await packageGaps(root)).toContain('dist/ajv.js');
  await writeFile(join(root, 'dist', 'ajv.js'), 'module.exports = () => {};\n');
  expect(await packageGaps(root)).toEqual([]);
});

/** An extension entry whose declared peer `zod` exists but is missing its `v4` directory. */
async function truncatedPeerFixture(root: string): Promise<{ entry: string; peer: string }> {
  const installRoot = join(root, 'install');
  const packageDir = join(installRoot, 'node_modules', 'pi-probe-adapter');
  const peer = join(installRoot, 'node_modules', 'zod');
  const entry = join(packageDir, 'index.ts');
  await Promise.all([packageDir, peer].map(path => mkdir(path, { recursive: true })));
  await writeFile(entry, 'export default function () {}\n');
  await writeFile(join(packageDir, 'package.json'), canonicalJson({
    name: 'pi-probe-adapter', version: '2.37.0', peerDependencies: { zod: '^4.0.0' },
  }));
  await writeFile(join(peer, 'index.js'), 'export * from "./v4/classic/external.js";\n');
  await writeFile(join(peer, 'package.json'), canonicalJson({
    name: 'zod', version: '4.6.5', main: './index.js',
    exports: { './v4/classic/external.js': './v4/classic/external.js' },
  }));
  return { entry, peer };
}

/** A fake `npm` first on PATH that records its argv and optionally heals the peer package. */
async function stubNpm(root: string, options: { heal: boolean }): Promise<() => string[]> {
  const bin = join(root, 'bin');
  const argvLog = join(root, 'npm-argv.txt');
  await mkdir(bin, { recursive: true });
  const healLine = options.heal
    ? `const dir = join(${JSON.stringify(join(root, 'install'))}, 'node_modules', 'zod', 'v4', 'classic');\nmkdirSync(dir, { recursive: true });\nwriteFileSync(join(dir, 'external.js'), 'export const external = 1;\\n');`
    : '';
  await writeFile(join(bin, 'npm'), [
    '#!/usr/bin/env node',
    "const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    `appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');`,
    healLine,
    '',
  ].join('\n'));
  await chmod(join(bin, 'npm'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ''}`;
  cleanup.push(() => { process.env.PATH = previous; });
  return () => {
    if (!existsSync(argvLog)) return [];
    const first = readFileSync(argvLog, 'utf8').split('\n').filter(Boolean)[0] ?? '';
    return first.split(' ').filter(Boolean);
  };
}
