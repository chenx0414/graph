import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-discovery-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'web'));
  await mkdir(join(root, 'state'));
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [] }));
  const start = async () => { const daemon = await launchCli(root, { configPath }); cleanup.push(() => daemon.close()); return daemon; };
  const record = async () => JSON.parse(await readFile(join(root, 'state', 'console.json'), 'utf8'));
  return { root, start, record };
}

test('a real CLI publishes its bound address and reuses the stopped address after a busy socket is released', async () => {
  const f = await fixture();
  const first = await f.start();
  const address = await f.record();
  expect(address).toMatchObject({ url: first.url, pid: first.child.pid, mode: 'view' });
  expect(address.startedAt).toBeGreaterThan(0);
  expect((await first.request('/api/health')).status).toBe(200);
  await first.close();
  expect(await f.record()).toEqual(address);
  const port = Number(new URL(first.url).port);
  const held = createServer();
  await new Promise<void>(resolve => held.listen(port, '127.0.0.1', resolve));
  let closed = false;
  const closeHeld = async () => { if (!closed) { closed = true; await new Promise<void>(resolve => held.close(() => resolve())); } };
  cleanup.push(closeHeld);
  // Release only after the replacement process is actually spawned, while its real socket probe waits.
  const pending = f.start();
  const timer = setTimeout(() => { void closeHeld(); }, 750);
  cleanup.push(async () => { clearTimeout(timer); });
  const second = await pending;
  expect(second.url).toBe(first.url);
  expect((await f.record()).pid).toBe(second.child.pid);
  expect(second.child.pid).not.toBe(first.child.pid);
  expect((await second.request('/api/health')).status).toBe(200);
}, 60_000);

test('a permanently occupied remembered address falls back to an actually free loopback port', async () => {
  const f = await fixture();
  const held = createServer();
  await new Promise<void>(resolve => held.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { await new Promise<void>(resolve => held.close(() => resolve())); });
  const port = (held.address() as AddressInfo).port;
  await writeFile(join(f.root, 'state', 'console.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: 1, mode: 'view', startedAt: 1 }));
  const started = Date.now();
  const daemon = await f.start();
  expect(Number(new URL(daemon.url).port)).not.toBe(port);
  expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
  expect((await daemon.request('/api/health')).status).toBe(200);
}, 60_000);

test.each(['not json', '{"url":42}', '{"url":"nonsense","pid":1}', '{"url":"http://127.0.0.1:1","pid":"x"}', '{"url":"http://127.0.0.1:0","pid":1}'])('a malformed discovery record does not prevent a real CLI start (%s)', async record => {
  const f = await fixture();
  await writeFile(join(f.root, 'state', 'console.json'), record);
  const daemon = await f.start();
  expect(Number(new URL(daemon.url).port)).toBeGreaterThan(0);
  expect((await daemon.request('/api/health')).status).toBe(200);
  expect(await f.record()).toMatchObject({ url: daemon.url, pid: daemon.child.pid, mode: 'view' });
}, 30_000);
