import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The configuration of a running daemon: what a save does to the process that
 * is already serving, and what a refusal does to the file on disk.
 *
 * The console edits the configuration while the daemon runs. A candidate that
 * the daemon accepts takes effect on the running process: a project added in
 * the console can carry work at once, and a credential that was revoked stays
 * revoked even when the operating system offers the key again. A candidate the
 * daemon refuses never reaches the disk, and the daemon keeps serving the
 * configuration it already had.
 *
 * The proof is the real Go process, the real configuration file and the real
 * state directory.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface Fixture {
  root: string;
  configPath: string;
  daemon: Awaited<ReturnType<typeof launchCli>>;
  request: (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;
  close: () => Promise<void>;
}

async function fixture(options: { document?: unknown; env?: Record<string, string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-hot-config-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const other = join(root, 'other-project');
  await mkdir(project, { recursive: true });
  await mkdir(other, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  const document = options.document ?? {
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_HOT_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  };
  await writeFile(configPath, JSON.stringify(document, null, 2));
  const daemon = await launchCli(root, {
    configPath,
    env: { GRAPH_HOT_KEY: 'synthetic-hot-key', ...options.env },
  });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  return { root, configPath, daemon, request, close: () => daemon.close() } satisfies Fixture;
}

test('a project added by a hot configuration save is usable by the running daemon at once', async () => {
  const f = await fixture();

  const before = await f.request('/api/settings');
  expect((before.body as { projects: { id: string }[] }).projects.map(entry => entry.id)).toEqual(['p']);

  const document = JSON.parse(await readFile(f.configPath, 'utf8')) as {
    projects: { id: string; root: string }[];
  };
  document.projects = [...document.projects, { id: 'q', root: join(f.root, 'other-project') }];
  const saved = await f.request('/api/config', {
    method: 'POST', body: JSON.stringify({ expectedRevision: 0, document }),
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body as { applied?: boolean }).toMatchObject({ applied: true });

  // The running daemon knows the new project without a restart.
  const after = await f.request('/api/settings');
  expect((after.body as { projects: { id: string }[] }).projects.map(entry => entry.id).sort()).toEqual(['p', 'q']);

  // And the new project can carry a task right away.
  const begun = await f.request('/api/tasks', {
    method: 'POST', body: JSON.stringify({ projectId: 'q', request: 'Work in the new project', requestId: 'begin' }),
  });
  expect(begun.status, JSON.stringify(begun.body)).toBe(200);
  expect((begun.body as { taskId?: string }).taskId).toBeTruthy();
}, 60_000);

test('a rejected configuration candidate never reaches disk and the daemon keeps the previous one', async () => {
  const f = await fixture();
  const before = await readFile(f.configPath, 'utf8');

  // Two credentials that resolve to one key cannot claim two different shared
  // limit groups: the candidate is refused, and it says which field is wrong.
  const refused = await f.request('/api/config', {
    method: 'POST',
    body: JSON.stringify({
      expectedRevision: 0,
      document: {
        version: 1,
        projects: [{ id: 'p', root: join(f.root, 'project') }],
        credentials: {
          first: { secretRef: 'GRAPH_HOT_KEY', sharedLimitGroupId: 'group-one' },
          second: { secretRef: 'GRAPH_HOT_KEY', sharedLimitGroupId: 'group-two' },
        },
        models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000, maxTokens: 256, credentialId: 'first' }] },
      },
    }),
  });
  expect(refused.status).toBe(400);
  const error = refused.body as { code?: string; message?: string; field?: string };
  expect(error.code).toBe('invalid_config');
  expect(error.message).toContain('sharedLimitGroupId');
  expect(error.field).toContain('sharedLimitGroupId');

  // The file is byte-identical: a refused candidate is not a half-saved one.
  expect(await readFile(f.configPath, 'utf8')).toBe(before);

  // The daemon still serves the configuration it had.
  const view = await f.request('/api/config');
  expect(view.status).toBe(200);
  const stored = view.body as { config: { credentials: Record<string, { sharedLimitGroupId?: string }> } };
  expect(stored.config.credentials.local).toBeTruthy();
  expect(stored.config.credentials.local?.sharedLimitGroupId).toBeUndefined();
}, 60_000);

test('a revoked credential stays revoked after a restart, even when the environment offers the key again', async () => {
  const f = await fixture();
  const token = (await readFile(join(f.root, 'state', 'app-token'), 'utf8')).trim();

  const revoked = await f.request('/api/app/secret', {
    method: 'POST',
    headers: { 'x-graph-app-token': token },
    body: JSON.stringify({ ref: 'GRAPH_HOT_KEY', value: null }),
  });
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

  // The revocation is on disk, and it is read by the next process.
  const record = JSON.parse(await readFile(join(f.root, 'state', 'revoked-secrets.json'), 'utf8')) as string[];
  expect(record).toContain('GRAPH_HOT_KEY');

  await f.daemon.close();
  const restarted = await launchCli(f.root, {
    configPath: f.configPath,
    env: { GRAPH_HOT_KEY: 'synthetic-hot-key' },
  });
  cleanup.push(() => restarted.close());
  const startup = await restarted.request('/api/startup');
  const body = await startup.json() as { configured: boolean; enabledModelCount: number };
  // The key is in the environment again, but the revocation wins: the model
  // stays disabled instead of quietly coming back.
  expect(body.configured).toBe(false);
  expect(body.enabledModelCount).toBe(0);
}, 60_000);

test('a corrupt revocation file starts the daemon fail-closed instead of restoring the keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-hot-config-corrupt-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await mkdir(join(root, 'state'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_HOT_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  await writeFile(join(root, 'state', 'revoked-secrets.json'), '{ this is not a revocation list');

  const daemon = await launchCli(root, { configPath, env: { GRAPH_HOT_KEY: 'synthetic-hot-key' } });
  cleanup.push(() => daemon.close());

  // The daemon says the file is unusable and starts with every credential off.
  expect(daemon.stdout).toContain('Revocation file unusable');
  const startup = await daemon.request('/api/startup');
  const body = await startup.json() as { configured: boolean; enabledModelCount: number };
  expect(body.configured).toBe(false);
  expect(body.enabledModelCount).toBe(0);
}, 60_000);

test('two credentials revoked through the bridge are both recorded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-hot-config-two-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: {
      first: { secretRef: 'GRAPH_FIRST_KEY' },
      second: { secretRef: 'GRAPH_SECOND_KEY' },
    },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000, maxTokens: 256, credentialId: 'first' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_FIRST_KEY: 'synthetic-first', GRAPH_SECOND_KEY: 'synthetic-second' } });
  cleanup.push(() => daemon.close());
  const token = (await readFile(join(root, 'state', 'app-token'), 'utf8')).trim();

  for (const ref of ['GRAPH_FIRST_KEY', 'GRAPH_SECOND_KEY']) {
    const revoked = await daemon.request('/api/app/secret', {
      method: 'POST',
      headers: { 'x-graph-app-token': token },
      body: JSON.stringify({ ref, value: null }),
    });
    expect(revoked.status).toBe(200);
  }

  const record = JSON.parse(await readFile(join(root, 'state', 'revoked-secrets.json'), 'utf8')) as string[];
  expect(record).toContain('GRAPH_FIRST_KEY');
  expect(record).toContain('GRAPH_SECOND_KEY');
}, 60_000);
