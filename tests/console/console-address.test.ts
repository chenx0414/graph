import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearConsoleAddress, consoleAddressPath, readConsoleAddress, writeConsoleAddress,
} from '../../src/server/console-address.ts';

const state = () => mkdtempSync(join(tmpdir(), 'console-address-'));

// The record exists so a tool can find a console it did not start. The round trip is the contract,
// and the port a caller needs is the one inside the url it just read.
test('round-trips the address a reader needs', async () => {
  const stateDir = state();
  await writeConsoleAddress(stateDir, { url: 'http://127.0.0.1:56588/', pid: 4242, mode: 'execute', startedAt: 1_790_000_000_000 });

  expect(await readConsoleAddress(stateDir)).toEqual({
    url: 'http://127.0.0.1:56588/', pid: 4242, mode: 'execute', startedAt: 1_790_000_000_000,
  });
  expect(new URL((await readConsoleAddress(stateDir))!.url).port).toBe('56588');
});

// A missing or unreadable record is a normal state (nothing is running, or something else wrote
// junk), never an exception: callers ask "where is the console" and must get an answer.
test('reports no address rather than throwing', async () => {
  const stateDir = state();
  expect(await readConsoleAddress(stateDir)).toBeNull();
});

test('refuses a record that is not an address', async () => {
  const stateDir = state();
  for (const junk of ['not json', JSON.stringify({ url: 42 }), JSON.stringify({ url: 'nonsense', pid: 1 }), JSON.stringify({ url: 'http://127.0.0.1:1/', pid: 'x' })]) {
    await writeFile(consoleAddressPath(stateDir), junk);
    expect(await readConsoleAddress(stateDir)).toBeNull();
  }
});

// A stopped daemon must not leave an address behind that answers nothing.
test('clearing removes the record, twice over', async () => {
  const stateDir = state();
  await writeConsoleAddress(stateDir, { url: 'http://127.0.0.1:1/', pid: 1, mode: 'view', startedAt: 1 });
  await clearConsoleAddress(stateDir);
  expect(await readConsoleAddress(stateDir)).toBeNull();
  await expect(clearConsoleAddress(stateDir)).resolves.toBeUndefined();
});
