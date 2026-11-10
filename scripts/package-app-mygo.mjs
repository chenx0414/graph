/**
 * Builds the MyGo shell bundle that replaces the Electron one. It writes to
 * dist/app-mygo so an RSI activation that only touched the shell cannot swap
 * the app in /Applications before the migration reaches S1d.
 *
 * Run: node --run app:build:mygo
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'dist', 'app-mygo', 'mac-arm64');
const bundle = join(output, 'Graph.app');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

execFileSync('go', ['-C', join(root, 'app'), 'tool', 'mygo', 'build'], { stdio: 'inherit' });

const built = join(root, 'app', 'build', 'darwin-arm64', 'Graph.app');
await cp(built, bundle, { recursive: true, verbatimSymlinks: true });

const binary = join(bundle, 'Contents', 'MacOS', 'Graph');
const bytes = (await stat(binary)).size;
const total = await directorySize(bundle);
console.log(`[app-mygo] ${bundle}`);
console.log(`[app-mygo] shell binary ${(bytes / 1024 ** 2).toFixed(1)} MiB, bundle ${(total / 1024 ** 2).toFixed(1)} MiB`);

async function directorySize(path) {
  const { readdir, stat: size } = await import('node:fs/promises');
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await size(child)).size;
  }
  return total;
}
