import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The restart queue of the desktop app, behind the app token.
 *
 * The self-improvement surface tells the desktop app that the running code
 * has to be reloaded. The queue is privileged: it is read and acknowledged
 * through the app bridge, which only the app itself may open. A caller
 * without the token is refused, a malformed acknowledgement is refused, and
 * an acknowledgement for a request that is not the current one does not
 * clear anything - the queue never reports a restart as confirmed when it is
 * not.
 *
 * The proof is the real Go process and the real token file the daemon wrote.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-rsi-bridge-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_RSI_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath });
  cleanup.push(() => daemon.close());
  const token = (await readFile(join(root, 'state', 'app-token'), 'utf8')).trim();
  const request = async (path: string, init: RequestInit = {}, withToken = true) => {
    const response = await daemon.request(path, {
      ...init, headers: { ...(withToken ? { 'x-graph-app-token': token } : {}), 'content-type': 'application/json', ...init.headers },
    });
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  return { root, daemon, token, request };
}

test('the restart queue is readable only through the app token', async () => {
  const f = await fixture();

  // Without the token the bridge is closed, even for a valid browser session.
  const refused = await f.request('/api/app/rsi/status', {}, false);
  expect(refused.status).toBe(403);
  expect((refused.body as { code?: string }).code).toBe('forbidden');

  // With the token the queue answers with its documented shape.
  const status = await f.request('/api/app/rsi/status');
  expect(status.status).toBe(200);
  const body = status.body as {
    available?: boolean; pendingRestart?: unknown; canRestart?: boolean; operations?: unknown[];
  };
  expect(body).toHaveProperty('available');
  expect(body).toHaveProperty('operations');
  expect(Array.isArray(body.operations)).toBe(true);
  // Nothing asked for a reload, so nothing is pending and nothing can restart.
  expect(body.pendingRestart).toBeNull();
  expect(body.canRestart).toBe(false);
}, 60_000);

test('the bridge refuses a malformed acknowledgement and does not clear an unknown request', async () => {
  const f = await fixture();

  const malformed = await f.request('/api/app/rsi/restart-ack', {
    method: 'POST', body: JSON.stringify({}),
  });
  expect(malformed.status).toBe(400);
  expect((malformed.body as { code?: string }).code).toBe('invalid_input');

  // An id that is not the current request clears nothing and says so.
  const unknown = await f.request('/api/app/rsi/restart-ack', {
    method: 'POST', body: JSON.stringify({ id: 'no-such-restart-request' }),
  });
  expect(unknown.status).toBe(200);
  expect(unknown.body as { cleared?: boolean }).toMatchObject({ cleared: false });

  // The queue is still empty: an unknown acknowledgement invented nothing.
  const status = await f.request('/api/app/rsi/status');
  expect((status.body as { pendingRestart?: unknown }).pendingRestart).toBeNull();
}, 60_000);
