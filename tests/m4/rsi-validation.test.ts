import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('an RSI check drops a foreign DYLD search path and keeps the rest', async () => {
  const { validationCommand } = await import('../../src/runtime/rsi.ts');
  const resolved = validationCommand({ command: 'node', args: ['--run', 'check'] }, {
    PATH: '/opt/homebrew/bin:/usr/bin',
    HOME: '/Users/someone',
    DYLD_FALLBACK_LIBRARY_PATH: '/Applications/matlab/MATLAB_Runtime/R2025b/bin/maca64',
  });
  // Without a bundled runtime the developer's own node runs the gate.
  expect(resolved.executable).toBe('node');
  expect(resolved.args).toEqual(['--run', 'check']);
  expect(resolved.env.DYLD_FALLBACK_LIBRARY_PATH).toBeUndefined();
  expect(String(resolved.env.PATH).split(':').slice(0, 2)).toEqual(['/opt/homebrew/bin', '/usr/bin']);
  expect(resolved.env.HOME).toBe('/Users/someone');
  expect(resolved.env.GIT_TERMINAL_PROMPT).toBe('0');
});

test('a packaged app validates the checkout with its bundled node runtime', async () => {
  const { validationCommand } = await import('../../src/runtime/rsi.ts');
  const resolved = validationCommand({ command: 'node', args: ['--run', 'test'] }, {
    GRAPH_APP_NODE: '/App/Contents/Resources/app/runtime/node',
    PATH: '/usr/bin:/bin',
  });
  expect(resolved.executable).toBe('/App/Contents/Resources/app/runtime/node');
});

test('the resolved check command starts', async () => {
  const { validationCommand } = await import('../../src/runtime/rsi.ts');
  const resolved = validationCommand({ command: 'node', args: ['--version'] });
  expect(execFileSync(resolved.executable, resolved.args, { encoding: 'utf8', env: resolved.env })).toMatch(/^v\d+/);
});

test('a minimal desktop PATH gains the standard developer toolchain locations', async () => {
  const { developerPath } = await import('../../src/runtime/rsi.ts');
  const existing = new Set(['/opt/homebrew/bin', '/usr/local/bin']);
  const exists = (path: string) => existing.has(path);
  expect(developerPath('/usr/bin:/bin:/usr/sbin:/sbin', exists))
    .toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin');
  // An inherited directory keeps its position and is never added twice.
  expect(developerPath('/opt/homebrew/bin:/usr/bin', exists)).toBe('/opt/homebrew/bin:/usr/bin:/usr/local/bin');
  expect(developerPath(undefined, () => false)).toBe('');

  // The daemon widens its own environment in place, so the children it starts inherit it.
  const { widenProcessPath } = await import('../../src/runtime/developer-path.ts');
  expect(widenProcessPath({ PATH: '/usr/bin:/bin' }, exists).PATH)
    .toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin');
  expect(widenProcessPath({ PATH: '/opt/homebrew/bin:/usr/bin:/usr/local/bin' }, exists).PATH)
    .toBe('/opt/homebrew/bin:/usr/bin:/usr/local/bin');
});

test('a check reaches the host toolchain an app started from the desktop would miss', async () => {
  const { validationCommand } = await import('../../src/runtime/rsi.ts');
  const { existsSync } = await import('node:fs');
  const npm = '/opt/homebrew/bin/npm';
  if (!existsSync(npm)) return;
  const resolved = validationCommand({ command: 'node', args: ['--version'] }, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  expect(execFileSync('/usr/bin/which', ['npm'], { encoding: 'utf8', env: { PATH: resolved.env.PATH } }).trim()).toBe(npm);
});

test('the dirty-path refusal names the RSI write path an Agent must use', async () => {
  const { rsiDirtyMessage } = await import('../../src/runtime/rsi.ts');
  const text = rsiDirtyMessage('/repo', ['src/a.ts', 'src/b.ts']);
  expect(text).toContain('src/a.ts, src/b.ts');
  // The route that works: hand edits go back to the tool as changes.
  expect(text).toContain('apply_rsi_change');
  expect(text).toContain('revert them');
  expect(text).toContain('must be written by the tool');
});
