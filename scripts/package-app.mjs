/**
 * Builds the macOS app bundle (and dmg) for Graph.
 *
 * A staging directory gets the app sources plus a flat npm install of the
 * production dependencies, so packaging never depends on the repository's
 * pnpm symlink farm; electron-builder only sees a plain app directory.
 *
 * Run: export PATH="$PWD/node_modules/.bin:$PATH"; node --run app:build
 */
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_FREE_BYTES, diskSpaceWarning, formatBytes, freeBytesAt } from '../src/runtime/disk-space.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, '.stage');
const repo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

if (!existsSync(join(root, 'dist/web/index.html'))) {
  throw new Error('dist/web is missing; run node --run build:web first');
}

// Checked before the staging copy rather than discovered by the dmg step at the end, and reported
// without blocking: a build that cannot finish should say so before it spends the time.
const freeBytes = freeBytesAt(root);
console.log(`packaging: ${formatBytes(freeBytes)} free on the output volume (needs ~${formatBytes(MIN_FREE_BYTES)})`);
const spaceWarning = diskSpaceWarning(freeBytes);
if (spaceWarning) console.warn(spaceWarning);

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

await writeFile(join(stage, 'package.json'), `${JSON.stringify({
  name: 'graph-console',
  productName: 'Graph',
  version: repo.version,
  main: 'desktop/main.mjs',
  private: true,
  type: 'module',
  dependencies: repo.dependencies,
}, null, 2)}\n`);

for (const [from, to] of [
  ['AGENTS.md', 'AGENTS.md'],
  ['.agents/skills', '.agents/skills'],
  ['.agents/matt-skills-lock.json', '.agents/matt-skills-lock.json'],
  ['.agents/matt-skills-LICENSE', '.agents/matt-skills-LICENSE'],
  ['CODING_STANDARDS.md', 'CODING_STANDARDS.md'],
  ['CONTEXT.md', 'CONTEXT.md'],
  ['docs/agents', 'docs/agents'],
  ['docs/adr', 'docs/adr'],
  ['docs/architecture.md', 'docs/architecture.md'],
  ['docs/implementation-plan.md', 'docs/implementation-plan.md'],
  ['docs/graph-mvp.md', 'docs/graph-mvp.md'],
  ['docs/agent', 'docs/agent'],
  ['docs/planning/baseline-cleanup-2026-10-20.md', 'docs/planning/baseline-cleanup-2026-10-20.md'],
  ['docs/design-graph-examples.md', 'docs/design-graph-examples.md'],
  ['docs/specs/graph-rebuild-v2.md', 'docs/specs/graph-rebuild-v2.md'],
  ['examples', 'examples'],
  ['desktop', 'desktop'],
  ['src', 'src'],
  ['backend', 'backend'],
  ['build', 'build'],
  // The built-in skills/MCP/talent pack must ship with the app: the daemon
  // installs definitions from this directory on first start.
  ['presets', 'presets'],
]) {
  await cp(join(root, from), join(stage, to), { recursive: true });
}
await cp(join(root, 'dist/web'), join(stage, 'web'), { recursive: true });
// Build after validating shipped resources so preflight failures stay actionable.
execFileSync(process.execPath, [join(root, 'scripts/build-backend.mjs'), '--if-missing'], { stdio: 'inherit' });
// Every package carries the current Go executable and its source for harness maintenance.
const graphd = join(root, 'dist/graphd');
await mkdir(join(stage, 'dist'), { recursive: true });
await cp(graphd, join(stage, 'dist/graphd'));
await chmod(join(stage, 'dist/graphd'), 0o755);
// A real Node runtime for sandboxed helpers: packaged Electron cannot start
// its own binary inside the OS sandbox (missing Helper apps).
await mkdir(join(stage, 'runtime'), { recursive: true });
// The copy has to be self-contained. An interpreter that reaches its libnode by
// @rpath only resolves inside its own install prefix, so the shipped copy dies
// with "Library not loaded: @rpath/libnode.147.dylib" on the first helper
// start - and on the first Agent turn, because the worker runtime is the same
// binary. GRAPH_APP_NODE_BIN names a standalone node to ship instead.
const nodeRuntime = process.env.GRAPH_APP_NODE_BIN?.trim() || process.execPath;
await cp(nodeRuntime, join(stage, 'runtime/node'));
try {
  execFileSync(join(stage, 'runtime/node'), ['--version'], { stdio: 'ignore' });
} catch {
  throw new Error(
    `The Node runtime that would ship is not self-contained: ${nodeRuntime}. ` +
    'Point GRAPH_APP_NODE_BIN at a standalone node binary (a real install, not a shim ' +
    'that links libnode by @rpath) and build again.',
  );
}

console.log('installing production dependencies into .stage (flat npm tree)');
execFileSync('npm', ['install', '--omit=dev', '--package-lock=false', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });

await writeFile(join(stage, 'electron-builder.json'), `${JSON.stringify({
  appId: 'dev.graph.console',
  productName: 'Graph',
  directories: { output: join(root, 'dist/app'), buildResources: 'build' },
  files: ['AGENTS.md', 'CODING_STANDARDS.md', 'CONTEXT.md', '.agents/**/*', 'docs/agents/**/*', 'docs/adr/**/*', 'docs/architecture.md', 'docs/implementation-plan.md', 'docs/graph-mvp.md', 'docs/agent/**/*', 'docs/planning/baseline-cleanup-2026-10-20.md', 'docs/design-graph-examples.md', 'docs/specs/graph-rebuild-v2.md', 'examples/**/*', 'desktop/**/*', 'src/**/*', 'backend/**/*', 'web/**/*', 'dist/graphd', 'build/**/*', 'presets/**/*', 'runtime/**/*', 'node_modules/**/*', 'package.json'],
  asar: false,
  npmRebuild: false,
  electronVersion: repo.devDependencies.electron,
  mac: {
    target: ['dir', 'dmg'],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.png',
    identity: null,
  },
}, null, 2)}\n`);

const candidates = [
  join(root, 'node_modules/.bin/electron-builder'),
  join(root, '.tooling/node_modules/.bin/electron-builder'),
];
const builder = candidates.find(candidate => existsSync(candidate));
if (!builder) throw new Error('electron-builder is not installed; run pnpm install or npm install --prefix .tooling electron-builder');

console.log('packaging with electron-builder');
execFileSync(builder, ['--mac', '--config', join(stage, 'electron-builder.json')], {
  cwd: stage,
  stdio: 'inherit',
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});

console.log(`app bundle: ${join(root, 'dist/app/mac-arm64/Graph.app')}`);

// The build is not finished when the bundle exists: a shell change that never reached the package is
// the same failure as one that was never written (`app-verify.mjs` carries that story). Running it here
// means `app:build` cannot forget the check; the standalone `app:verify` script stays for checking a
// package built in another checkout.
console.log('verifying the packaged app');
execFileSync(process.execPath, [join(root, 'scripts/app-verify.mjs')], { cwd: root, stdio: 'inherit' });
