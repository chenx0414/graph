import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const run = promisify(execFile);

// These are actual macOS packaging volumes, not an injected statfs result.
// Sparse images reserve virtual capacity without allocating gigabytes of data.
test.skipIf(process.platform !== 'darwin').each([
  { capacity: '900m', unit: 'MiB', warning: true },
  { capacity: '3500m', unit: 'GiB', warning: false },
])('packaging on a $capacity volume reports real free space and warns before staging without blocking it', async row => {
  const root = await mkdtemp(join(tmpdir(), 'graph-package-preflight-'));
  const volume = join(root, 'volume');
  const image = join(root, 'image.sparsebundle');
  let mounted = false;
  try {
    await mkdir(volume);
    await run('hdiutil', ['create', '-size', row.capacity, '-fs', 'HFS+', '-type', 'SPARSEBUNDLE', '-volname', 'GraphTestPreflight', '-quiet', image], { timeout: 30_000 });
    await run('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-mountpoint', volume, image], { timeout: 30_000 });
    mounted = true;
    await mkdir(join(volume, 'scripts'));
    await mkdir(join(volume, 'src/runtime'), { recursive: true });
    await mkdir(join(volume, 'dist/web'), { recursive: true });
    await copyFile(join(process.cwd(), 'scripts/package-app.mjs'), join(volume, 'scripts/package-app.mjs'));
    await copyFile(join(process.cwd(), 'src/runtime/disk-space.ts'), join(volume, 'src/runtime/disk-space.ts'));
    await copyFile(join(process.cwd(), 'package.json'), join(volume, 'package.json'));
    await writeFile(join(volume, 'dist/web/index.html'), '<!doctype html><title>Packaging input</title>');
    // Missing shipped resources are an external input failure. Reaching that
    // later filesystem error and the staged package proves the warning itself
    // remains advisory; this fixture does not claim a successful app release.
    let stdout = '';
    let stderr = '';
    try {
      await run(process.execPath, [join(volume, 'scripts/package-app.mjs')], { cwd: volume, timeout: 30_000 });
      throw new Error('Incomplete packaging input unexpectedly succeeded');
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      expect(failure.code).toBe(1);
      stdout = failure.stdout ?? '';
      stderr = failure.stderr ?? '';
    }
    expect(stdout).toMatch(new RegExp(`packaging: [0-9.]+ ${row.unit} free on the output volume \\(needs ~2\\.0 GiB\\)`));
    expect(stderr).toContain('ENOENT');
    expect(stderr).toContain('AGENTS.md');
    const staged = JSON.parse(await readFile(join(volume, '.stage/package.json'), 'utf8'));
    expect(staged).toMatchObject({ name: 'graph-console', main: 'desktop/main.mjs' });
    if (row.warning) {
      expect(stderr).toContain('app:build 只剩');
      expect(stderr).toContain('打包约需 2.0 GiB');
      expect(stderr).toContain('设备上无剩余空间');
      expect(stderr).toContain('.agent-browser/tmp');
      expect(stderr.indexOf('app:build 只剩')).toBeLessThan(stderr.indexOf('ENOENT'));
    } else {
      expect(stderr).not.toContain('app:build 只剩');
      expect(stderr).not.toContain('先回收再重跑');
    }
  } finally {
    if (mounted) await run('hdiutil', ['detach', volume], { timeout: 30_000 });
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
