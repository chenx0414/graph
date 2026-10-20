import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const run = promisify(execFile);
const updaterScript = join(process.cwd(), 'scripts/pig-kernel-update.mjs');
const MODULE = 'github.com/MichaelKinsy/PiG';

// The kernel is a real Go module dependency of the backend. The updater is the
// only sanctioned way to move that pin, so these tests drive the real script
// against the real module proxy and the real Go toolchain. Nothing here fakes a
// release, a download or a compiler result.
async function updater(args: string[], options: { cwd?: string } = {}) {
  try {
    const result = await run(process.execPath, [updaterScript, ...args], { cwd: options.cwd ?? process.cwd(), timeout: 600_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

test('the backend pins a published PiG kernel and the updater reports that pin', async () => {
  const report = await updater([]);
  expect(report.code).toBe(0);
  const pinned = /pinned:\s+(v\d+\.\d+\.\d+)/.exec(report.stdout)?.[1];
  const latest = /latest:\s+(v\d+\.\d+\.\d+)/.exec(report.stdout)?.[1];
  expect(pinned).toBeTruthy();
  expect(latest).toBeTruthy();
  expect(report.stdout).toContain(MODULE);

  // The pin in go.mod must be the version the Go build actually resolves, or
  // the updater would be reporting a number the product does not run.
  const resolved = await run('go', ['list', '-m', MODULE], { cwd: join(process.cwd(), 'backend'), timeout: 120_000 });
  expect(resolved.stdout.trim()).toBe(`${MODULE} ${pinned}`);

  // --check is the drift gate: it agrees with the report, and its exit code
  // tells the truth about whether the tree is behind the published kernel.
  const check = await updater(['--check']);
  expect(check.stdout).toContain(`pinned:  ${pinned}`);
  expect(check.stdout).toContain(`latest:  ${latest}`);
  if (pinned === latest) {
    expect(check.code).toBe(0);
  } else {
    expect(check.code).toBe(1);
    expect(check.stderr).toContain('behind the published');
  }
}, 300_000);

test('the updater pins the kernel in an isolated checkout, builds against it, and leaves the tree untouched when the pin cannot be built', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-kernel-'));
  const moduleDir = join(root, 'backend');
  try {
    await mkdir(moduleDir);
    // A real Go module that imports the kernel, so `go mod tidy` keeps the
    // dependency and `go build` proves the pinned kernel compiles.
    await writeFile(join(moduleDir, 'go.mod'), 'module graph-pig-kernel-probe\n\ngo 1.27.1\n');
    await writeFile(join(moduleDir, 'kernel.go'), [
      'package graph',
      '',
      'import "github.com/MichaelKinsy/PiG/durable"',
      '',
      '// KernelConversationId keeps the durable identifier type in the build so the',
      '// pinned kernel is a compiled dependency rather than a comment.',
      'func KernelConversationId() durable.ConversationId { return durable.ConversationId(1) }',
      '',
    ].join('\n'));

    const first = await updater(['--root', root, '--set', 'latest']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('the kernel is pinned at');
    const goMod = await readFile(join(moduleDir, 'go.mod'), 'utf8');
    const pinned = new RegExp(`${MODULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (v\\S+)`).exec(goMod)?.[1];
    expect(pinned).toBeTruthy();
    const goSum = await readFile(join(moduleDir, 'go.sum'), 'utf8');
    expect(goSum).toContain(`${MODULE} ${pinned}`);
    const built = await run('go', ['build', './...'], { cwd: moduleDir, timeout: 600_000 });
    expect(built.stderr).toBe('');

    // A version that cannot be resolved must not leave the checkout half
    // updated: the pin, the sums and the build all stay as they were.
    const before = { goMod, goSum };
    const broken = await updater(['--root', root, '--set', 'v9.9.9-does-not-exist']);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain('is not a published version');
    expect(broken.stderr).toContain('the pinned kernel was left at');
    expect(await readFile(join(moduleDir, 'go.mod'), 'utf8')).toBe(before.goMod);
    expect(await readFile(join(moduleDir, 'go.sum'), 'utf8')).toBe(before.goSum);
    const stillBuilt = await run('go', ['build', './...'], { cwd: moduleDir, timeout: 600_000 });
    expect(stillBuilt.stderr).toBe('');

    // Moving the kernel backwards is refused unless it is asked for by name.
    const downgrade = await updater(['--root', root, '--set', 'v0.0.1']);
    expect(downgrade.code).toBe(1);
    expect(downgrade.stderr).toContain('pass --allow-downgrade');
    expect(await readFile(join(moduleDir, 'go.mod'), 'utf8')).toBe(before.goMod);
    expect(await readFile(join(moduleDir, 'go.sum'), 'utf8')).toBe(before.goSum);

    // Running the same pin again is a no-op, not a rewrite.
    const again = await updater(['--root', root, '--set', pinned!]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('already pinned');
    expect(await readFile(join(moduleDir, 'go.mod'), 'utf8')).toBe(before.goMod);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 900_000);
