import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Make sure the Go backend the E2E suite drives actually exists.
 *
 * The suite spawns the real binary, so a checkout that never built it would
 * fail every backend test for a reason that has nothing to do with the code
 * under test. Building here keeps the failure to the thing being tested.
 */
export function ensureBackendBinary(): string {
  const script = join(repoRoot, 'scripts', 'build-backend.mjs');
  const output = join(repoRoot, 'dist', process.platform === 'win32' ? 'graphd.exe' : 'graphd');
  const build = spawnSync(process.execPath, [script, '--if-missing'], { cwd: repoRoot, stdio: 'inherit' });
  if (build.status !== 0 || !existsSync(output)) {
    throw new Error('The Go backend could not be built. Run `npm run build:backend` and read the compiler output above.');
  }
  return output;
}
