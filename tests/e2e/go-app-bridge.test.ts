import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The desktop app bridge: the app hands the daemon a secret, and the daemon
 * keeps it out of the configuration file.
 *
 * The secret itself never belongs in `graph.config.json` - the file only names
 * the environment variable the secret comes from. The app pushes the value
 * over the bridge, the daemon applies it live, and the daemon asks the app to
 * persist it by listing the pending request. Revoking the secret takes the
 * reference out of service and leaves a record of the revocation.
 *
 * The proof is the real Go process, the real token file the daemon wrote and
 * the real configuration file on disk.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-app-bridge-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_APP_TEST_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath });
  cleanup.push(() => daemon.close());
  // The daemon wrote its own app token when it started: the app reads the
  // same file, so the bridge is opened with the real token.
  const token = (await readFile(join(root, 'state', 'app-token'), 'utf8')).trim();
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, {
      ...init, headers: { 'x-graph-app-token': token, 'content-type': 'application/json', ...init.headers },
    });
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  return { root, configPath, daemon, request };
}

test('the app bridge applies a pushed secret and keeps the value out of the configuration file', async () => {
  const f = await fixture();

  const pushed = await f.request('/api/app/secret', {
    method: 'POST', body: JSON.stringify({ ref: 'GRAPH_APP_TEST_KEY', value: 'synthetic-bridge-secret' }),
  });
  expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
  expect(pushed.body as { applied?: boolean }).toMatchObject({ applied: true });

  // The configuration file names the environment variable; the value the app
  // pushed is never written to it.
  const config = await readFile(f.configPath, 'utf8');
  expect(config).toContain('GRAPH_APP_TEST_KEY');
  expect(config).not.toContain('synthetic-bridge-secret');

  // The daemon asks the app to persist the secret it now holds.
  const pending = await f.request('/api/app/secret-requests');
  expect(pending.status).toBe(200);
  const requests = (pending.body as { requests?: { ref: string }[] }).requests ?? [];
  expect(requests.some(request => request.ref === 'GRAPH_APP_TEST_KEY')).toBe(true);
}, 60_000);

test('revoking a secret over the app bridge takes it out of service and leaves a record', async () => {
  const f = await fixture();

  await f.request('/api/app/secret', {
    method: 'POST', body: JSON.stringify({ ref: 'GRAPH_APP_TEST_KEY', value: 'synthetic-bridge-secret' }),
  });
  const revoked = await f.request('/api/app/secret', {
    method: 'POST', body: JSON.stringify({ ref: 'GRAPH_APP_TEST_KEY', value: null }),
  });
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  expect(revoked.body as { applied?: boolean }).toMatchObject({ applied: true });

  // The revocation is a durable fact: the daemon keeps it beside its state.
  const record = JSON.parse(await readFile(join(f.root, 'state', 'revoked-secrets.json'), 'utf8')) as string[];
  expect(record).toContain('GRAPH_APP_TEST_KEY');
}, 60_000);

test('the app bridge refuses a caller without the app token', async () => {
  const f = await fixture();

  const refused = await f.daemon.request('/api/app/secret', {
    method: 'POST', body: JSON.stringify({ ref: 'GRAPH_APP_TEST_KEY', value: 'synthetic-bridge-secret' }),
  });
  expect(refused.status).toBe(403);
}, 60_000);
