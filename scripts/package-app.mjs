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
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, '.stage');
const repo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

if (!existsSync(join(root, 'dist/web/index.html'))) {
  throw new Error('dist/web is missing; run node --run build:web first');
}

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
  ['desktop', 'desktop'],
  ['src', 'src'],
  ['build', 'build'],
  // The built-in skills/MCP/talent pack must ship with the app: the daemon
  // installs definitions from this directory on first start.
  ['presets', 'presets'],
]) {
  await cp(join(root, from), join(stage, to), { recursive: true });
}
await cp(join(root, 'dist/web'), join(stage, 'web'), { recursive: true });

console.log('installing production dependencies into .stage (flat npm tree)');
execFileSync('npm', ['install', '--omit=dev', '--package-lock=false', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });

await writeFile(join(stage, 'electron-builder.json'), `${JSON.stringify({
  appId: 'dev.graph.console',
  productName: 'Graph',
  directories: { output: join(root, 'dist/app'), buildResources: 'build' },
  files: ['desktop/**/*', 'src/**/*', 'web/**/*', 'build/**/*', 'presets/**/*', 'node_modules/**/*', 'package.json'],
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
