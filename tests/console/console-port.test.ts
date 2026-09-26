import { test, expect } from 'vitest';
import { preferredConsolePort } from '../../src/server/console-port.ts';

const record = (url: string) => ({ url, pid: 1, mode: 'execute' as const, startedAt: 1 });

// The point of the preference: a reload keeps the console where the tabs already look.
test('reuses the port this state directory last served on', async () => {
  const port = await preferredConsolePort({
    stateDir: '/tmp/does-not-matter',
    read: async () => record('http://127.0.0.1:56588/'),
    isFree: async candidate => candidate === 56588,
  });
  expect(port).toBe(56588);
});

// The bind is still the authority: a remembered port taken by something else must not fail a start.
test('falls back to a free port when the remembered one is taken', async () => {
  expect(await preferredConsolePort({
    stateDir: '/tmp/does-not-matter',
    read: async () => record('http://127.0.0.1:56588/'),
    isFree: async () => false,
  })).toBeUndefined();
});

// No record, no preference: a first start is a free-port start.
test('has no preference without a readable record', async () => {
  expect(await preferredConsolePort({ stateDir: '/tmp/does-not-matter', read: async () => null })).toBeUndefined();
  expect(await preferredConsolePort({
    stateDir: '/tmp/does-not-matter',
    read: async () => record('not-a-url'),
  })).toBeUndefined();
  expect(await preferredConsolePort({
    stateDir: '/tmp/does-not-matter',
    read: async () => record('http://127.0.0.1:0/'),
  })).toBeUndefined();
});

// A reader that throws is a missing record, not a failed start.
test('a failing reader cannot break a start', async () => {
  expect(await preferredConsolePort({
    stateDir: '/tmp/does-not-matter',
    read: async () => { throw new Error('unreadable'); },
  })).toBeUndefined();
});
