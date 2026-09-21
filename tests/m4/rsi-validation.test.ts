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
  expect(resolved.env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
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
