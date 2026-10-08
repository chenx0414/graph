import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

/**
 * The pre-push gate must not bury the reason a push failed, and the evidence of a
 * failing run must survive the next run: both logs share one path, so a flake that
 * passes on the second attempt used to leave nothing behind to diagnose.
 */
test('a failing pre-push gate keeps its evidence where the next run cannot overwrite it', () => {
  const hook = fileURLToPath(new URL('../../.githooks/pre-push', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-hook-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const state = join(dir, 'exit-code');
  // The hook runs `node --run check`; the stub replaces it so this test never
  // recurses into the real gate.
  writeFileSync(join(bin, 'node'), `#!/bin/sh
if [ "$(cat ${state})" = "0" ]; then echo "stub check ok"; exit 0; fi
echo "FAIL tests/console/example.test.ts > a flaky case"
echo "Test Files  1 failed (1)"
exit 1
`, { mode: 0o755 });
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME, TMPDIR: dir };
  const run = (code: number) => {
    writeFileSync(state, String(code));
    try {
      return { status: 0, stdout: execFileSync('sh', [hook], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }), stderr: '' };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string };
      return { status: failure.status ?? -1, stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr || failure.message || '') };
    }
  };

  // A passing gate stays quiet: one line, so a network error stays visible.
  const passing = run(0);
  expect(passing.status, passing.stderr).toBe(0);
  expect(passing.stdout.trim().split('\n')).toHaveLength(1);

  // A failing gate shows the failing line and keeps a copy of the full log.
  const failing = run(1);
  expect(failing.status).toBe(1);
  expect(failing.stderr).toContain('FAIL tests/console/example.test.ts');
  const kept = failing.stderr.match(/\/\S*failed-\S*\.log/)?.[0];
  expect(kept).toBeTruthy();
  expect(readFileSync(kept!, 'utf8')).toContain('FAIL tests/console/example.test.ts');

  // The next run reuses the shared log path, so it must not disturb the copy.
  run(0);
  expect(existsSync(kept!)).toBe(true);
  expect(readFileSync(kept!, 'utf8')).toContain('FAIL tests/console/example.test.ts');
  expect(readdirSync(dir).filter(name => name.includes('failed-'))).toHaveLength(1);
});
