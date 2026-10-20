import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The APP backend is the Go process. This file is the public-surface
 * acceptance for that process: it launches the real binary, drives the
 * documented HTTP and SSE contract against it, and proves the listening
 * process is the Go executable rather than the TypeScript Fastify server.
 *
 * It is a real end-to-end test: a real executable, a real loopback socket,
 * real on-disk state, and no mocks of our own collaborators.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-backend-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'web'));
  await mkdir(join(root, 'state'));
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const start = async () => { const daemon = await launchCli(root); cleanup.push(() => daemon.close()); return daemon; };
  return { root, start };
}

test('the APP backend is the Go process and serves the documented public surface', async () => {
  const f = await fixture();
  const daemon = await f.start();

  // The listening process is the Go executable, not node on src/server/cli.ts.
  expect(daemon.child.spawnfile.endsWith('graphd')).toBe(true);
  expect(daemon.stdout).toContain('Graph console');
  expect(daemon.stdout).toMatch(/mode:\s+view-only/);
  expect(daemon.stdout).toMatch(/address:\s+http:\/\/127\.0\.0\.1:\d+/);

  // The unauthenticated health probe is public and answers exactly {"ok":true}.
  const health = await fetch(`${daemon.url}/api/health`);
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });

  // The web client gets its session cookie from the root document.
  const home = await fetch(daemon.url);
  expect(home.status).toBe(200);
  const cookie = home.headers.get('set-cookie') ?? '';
  expect(cookie).toMatch(/^graph_session=[0-9a-f-]+; HttpOnly; SameSite=Strict; Path=\/$/);

  // The startup document carries the mode and the model counts.
  const startup = await fetch(`${daemon.url}/api/startup`, { headers: { cookie, origin: daemon.url } });
  expect(startup.status).toBe(200);
  const body = await startup.json() as { mode: string; configured: boolean; modelCount: number; enabledModelCount: number };
  expect(body.mode).toBe('view');
  expect(body.configured).toBe(false);
  expect(body.modelCount).toBe(0);
  expect(body.enabledModelCount).toBe(0);
}, 60_000);

test('the Go process keeps the documented auth, origin and app-token guards', async () => {
  const f = await fixture();
  const daemon = await f.start();

  // No session cookie: the API is closed.
  const anonymous = await fetch(`${daemon.url}/api/startup`, { headers: { origin: daemon.url } });
  expect(anonymous.status).toBe(401);
  expect(await anonymous.json()).toEqual({ code: 'unauthorized', message: 'Authentication required' });

  // The APP bridge is closed without its own token.
  const home = await fetch(daemon.url);
  const cookie = home.headers.get('set-cookie') ?? '';
  const bridge = await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { cookie, origin: daemon.url, 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'X', value: 'y' }),
  });
  expect(bridge.status).toBe(403);
  expect(await bridge.json()).toEqual({ code: 'forbidden', message: 'App bridge token required' });

  // A request from a foreign origin is refused, read and write alike.
  const foreignRead = await fetch(`${daemon.url}/api/startup`, { headers: { cookie, origin: 'http://example.invalid' } });
  expect(foreignRead.status).toBe(403);
  expect((await foreignRead.json() as { code: string }).code).toBe('forbidden_origin');
  const foreignWrite = await fetch(`${daemon.url}/api/conversations`, {
    method: 'POST', headers: { cookie, origin: 'http://example.invalid', 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'nope', requestId: 'nope' }),
  });
  expect(foreignWrite.status).toBe(403);
  expect((await foreignWrite.json() as { code: string }).code).toBe('forbidden_origin');
}, 60_000);

test('the Go process serves the conversation SSE stream in the documented frame shape', async () => {
  const f = await fixture();
  const daemon = await f.start();
  const home = await fetch(daemon.url);
  const cookie = home.headers.get('set-cookie') ?? '';

  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ title: 'hello from the go backend', text: 'hello', requestId: 'go-e2e' }),
  });
  expect(created.status).toBe(200);
  const conversation = await created.json() as { conversationId: string; taskId: string };
  expect(conversation.conversationId).toBeTruthy();

  const stream = await fetch(`${daemon.url}/api/conversations/${conversation.conversationId}/events/stream?after=0`, {
    headers: { cookie, origin: daemon.url },
  });
  expect(stream.status).toBe(200);
  expect(stream.headers.get('content-type')).toBe('text/event-stream');
  expect(stream.headers.get('cache-control')).toBe('no-cache');

  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();

  const frames = text.split('\n\n').filter(frame => frame.startsWith('data: '));
  expect(frames.length).toBeGreaterThan(0);
  // No event: line, and the frame object keeps the documented field order.
  expect(text).not.toContain('event: ');
  const frame = JSON.parse(frames[0]!.slice('data: '.length)) as Record<string, unknown>;
  expect(Object.keys(frame)).toEqual(['cursor', 'taskId', 'type', 'data', 'timestamp']);
  expect(typeof frame.cursor).toBe('number');
  expect(typeof frame.taskId).toBe('string');
  expect(typeof frame.type).toBe('string');
  expect(typeof frame.timestamp).toBe('number');
}, 60_000);

test('the Go process keeps the documented on-disk state formats', async () => {
  const f = await fixture();
  const daemon = await f.start();

  const record = JSON.parse(await readFile(join(f.root, 'state', 'console.json'), 'utf8')) as { url: string; pid: number; mode: string; startedAt: number };
  expect(record).toMatchObject({ url: daemon.url, pid: daemon.child.pid, mode: 'view' });
  expect(record.startedAt).toBeGreaterThan(0);
  expect((await stat(join(f.root, 'state', 'console.json'))).mode & 0o777).toBe(0o600);

  const token = await readFile(join(f.root, 'state', 'app-token'), 'utf8');
  expect(token.trim()).toMatch(/^[0-9a-f-]{36}$/);
  expect((await stat(join(f.root, 'state', 'app-token'))).mode & 0o777).toBe(0o600);
}, 60_000);

test('two clean runs of the Go process answer the same way', async () => {
  const f = await fixture();
  const first = await f.start();
  const firstHealth = await (await fetch(`${first.url}/api/health`)).json();
  const firstStartup = await (await fetch(`${first.url}/api/startup`, {
    headers: { cookie: (await fetch(first.url)).headers.get('set-cookie') ?? '', origin: first.url },
  })).json();
  await first.close();

  // A second clean state directory, so nothing is carried over between runs.
  const other = await mkdtemp(join(tmpdir(), 'graph-e2e-go-backend-'));
  cleanup.push(() => rm(other, { recursive: true, force: true }));
  await mkdir(join(other, 'web'));
  await mkdir(join(other, 'state'));
  await writeFile(join(other, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const second = await launchCli(other);
  cleanup.push(() => second.close());

  expect(await (await fetch(`${second.url}/api/health`)).json()).toEqual(firstHealth);
  expect(await (await fetch(`${second.url}/api/startup`, {
    headers: { cookie: (await fetch(second.url)).headers.get('set-cookie') ?? '', origin: second.url },
  })).json()).toEqual(firstStartup);
}, 90_000);
