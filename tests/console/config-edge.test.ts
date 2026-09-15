import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startGraphDaemon, type GraphDaemon } from '../../src/server/start.ts';
import { buildTemplateConfigDocument } from '../../src/web/setup.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

interface Session { cookie: string; headers: Record<string, string> }

async function session(url: string): Promise<Session> {
  const home = await fetch(url, { headers: { origin: url } });
  const cookie = home.headers.get('set-cookie') ?? '';
  return { cookie, headers: { origin: url, cookie, 'content-type': 'application/json' } };
}

async function fixture(name: string, options: { document: Record<string, unknown>; env?: Record<string, string> }) {
  const root = await mkdtemp(join(tmpdir(), `graph-edge-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const web = join(root, 'web');
  await mkdir(web, { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><html><body><div id="root">Graph</div></body></html>');
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, revision: 0, projects: [{ id: 'p', root: projectRoot }], ...options.document }, null, 2));
  const stateDir = join(root, 'state');
  const env = options.env ?? {};
  const daemon = await startGraphDaemon({ configPath, stateDir, webDir: web, port: 0, mode: 'execute', dynamic: true, env, log: () => undefined });
  cleanup.push(() => daemon.close());
  const api = await session(daemon.url);
  const token = (await readFile(join(stateDir, 'app-token'), 'utf8')).trim();
  return { root, projectRoot, configPath, stateDir, env, daemon, api, token };
}

const modelEntry = (baseUrl: string, extra: Record<string, unknown> = {}) => ({
  id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
  baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local', ...extra,
});

async function post(daemon: GraphDaemon, api: Session, path: string, body: unknown) {
  const response = await fetch(`${daemon.url}${path}`, { method: 'POST', headers: api.headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function waitFor<T>(check: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('a project added by a hot config save is immediately usable (UC-R01)', async () => {
  const { daemon, api, projectRoot } = await fixture('hotproject', { document: { projects: [] } });
  const before = await (await fetch(`${daemon.url}/api/settings`, { headers: api.headers })).json() as { projects: { id: string }[] };
  expect(before.projects).toHaveLength(0);
  const applied = await post(daemon, api, '/api/config', {
    expectedRevision: 0,
    document: { version: 1, projects: [{ id: 'new', root: projectRoot }] },
  });
  expect(applied.body).toMatchObject({ applied: true });
  const after = await (await fetch(`${daemon.url}/api/settings`, { headers: api.headers })).json() as { projects: { id: string }[] };
  expect(after.projects.map(project => project.id)).toEqual(['new']);
  // The Git preparation entry point accepts the project in the same PID.
  const prep = await daemon.server.runtime.projects.prepare({ projectId: 'new', requestId: 'prep-1', createBaseline: true });
  expect(prep.state).toBe('ready');
}, 30_000);

test('a rejected candidate never reaches disk and survives a restart (UC-R02)', async () => {
  const { daemon, api, configPath, stateDir, env, projectRoot, token } = await fixture('reject', {
    document: {
      models: { entries: [modelEntry('http://127.0.0.1:9', { credentialId: 'a' })] },
      credentials: { a: { secretRef: 'GRAPH_SHARED' }, b: { secretRef: 'GRAPH_SHARED' } },
      limits: { credentials: {}, sharedGroups: {} },
    },
  });
  // The shared key comes from the APP bridge, not from env: this is the path
  // where the previous save wrote the file before the live candidate failed.
  const bridge = (body: unknown) => fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': token, origin: daemon.url }, body: JSON.stringify(body),
  }).then(response => response.json() as Promise<Record<string, unknown>>);
  expect(await bridge({ ref: 'GRAPH_SHARED', value: 'shared-key' })).toMatchObject({ applied: true });
  const bytesBefore = await readFile(configPath, 'utf8');
  const applied = await post(daemon, api, '/api/config', {
    expectedRevision: 0,
    document: {
      version: 1,
      projects: [{ id: 'p', root: projectRoot }],
      models: { entries: [modelEntry('http://127.0.0.1:9', { credentialId: 'a' })] },
      credentials: { a: { secretRef: 'GRAPH_SHARED', sharedLimitGroupId: 'g1' }, b: { secretRef: 'GRAPH_SHARED', sharedLimitGroupId: 'g2' } },
      limits: { credentials: {}, sharedGroups: {} },
    },
  });
  // Whichever layer reports the field error, nothing reached disk.
  if (applied.status === 400) expect(applied.body).toMatchObject({ code: 'invalid_config', field: 'credentials.a.sharedLimitGroupId' });
  else expect(applied.body).toMatchObject({ applied: false });
  expect(JSON.stringify(applied.body)).toMatch(/sharedLimitGroupId/);
  expect(await readFile(configPath, 'utf8')).toBe(bytesBefore);
  const config = await (await fetch(`${daemon.url}/api/config`, { headers: api.headers })).json() as { revision: number };
  expect(config.revision).toBe(0);
  const startup = await (await fetch(`${daemon.url}/api/startup`, { headers: api.headers })).json() as { configured: boolean };
  expect(startup.configured).toBe(true);
  await daemon.close();
  // The file on disk is still the accepted one: a restart with the same key
  // view stays configured.
  const restarted = await startGraphDaemon({ configPath, stateDir, webDir: join(stateDir, '..', 'web'), port: 0, mode: 'execute', dynamic: true, env, log: () => undefined });
  cleanup.push(() => restarted.close());
  const token2 = (await readFile(join(stateDir, 'app-token'), 'utf8')).trim();
  const restartedSession = await session(restarted.url);
  expect(await fetch(`${restarted.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': token2, origin: restarted.url },
    body: JSON.stringify({ ref: 'GRAPH_SHARED', value: 'shared-key' }),
  }).then(response => response.json() as Promise<Record<string, unknown>>)).toMatchObject({ applied: true });
  const startup2 = await (await fetch(`${restarted.url}/api/startup`, { headers: restartedSession.headers })).json() as { configured: boolean };
  expect(startup2.configured).toBe(true);
}, 30_000);

test('revoking a key through the bridge disables the binding and survives restart (UC-R09)', async () => {
  const { daemon, api, configPath, stateDir, env, token } = await fixture('revoke', {
    document: { models: { entries: [modelEntry('http://127.0.0.1:9')] }, credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } } },
    env: { GRAPH_LOCAL_KEY: 'real-key' },
  });
  const before = await (await fetch(`${daemon.url}/api/startup`, { headers: api.headers })).json() as { configured: boolean; enabledModelCount: number };
  expect(before).toMatchObject({ configured: true, enabledModelCount: 1 });
  const bridge = (body: unknown) => fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': token, origin: daemon.url }, body: JSON.stringify(body),
  }).then(response => response.json() as Promise<Record<string, unknown>>);
  expect(await bridge({ ref: 'GRAPH_LOCAL_KEY', value: null })).toMatchObject({ applied: true });
  const after = await (await fetch(`${daemon.url}/api/startup`, { headers: api.headers })).json() as { configured: boolean; enabledModelCount: number };
  expect(after).toMatchObject({ configured: false, enabledModelCount: 0 });
  await daemon.close();
  // The APP relaunch re-injects the keychain value into env; the explicit
  // revocation must still win.
  const restarted = await startGraphDaemon({ configPath, stateDir, webDir: join(stateDir, '..', 'web'), port: 0, mode: 'execute', dynamic: true, env: { ...env, GRAPH_LOCAL_KEY: 'real-key' }, log: () => undefined });
  cleanup.push(() => restarted.close());
  const restartedSession = await session(restarted.url);
  const startup = await (await fetch(`${restarted.url}/api/startup`, { headers: restartedSession.headers })).json() as { configured: boolean };
  expect(startup.configured).toBe(false);
  const token2 = (await readFile(join(stateDir, 'app-token'), 'utf8')).trim();
  const restored = await fetch(`${restarted.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': token2, origin: restarted.url },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: 'new-key' }),
  }).then(response => response.json() as Promise<Record<string, unknown>>);
  expect(restored).toMatchObject({ applied: true });
  const live = await (await fetch(`${restarted.url}/api/startup`, { headers: restartedSession.headers })).json() as { configured: boolean };
  expect(live.configured).toBe(true);
}, 30_000);

test('a hot null default budget reaches new instances and never rewrites old ones (UC-R10)', async () => {
  const provider = await openaiServer([{ text: 'ok' }]);
  cleanup.push(() => provider.close());
  const { daemon, api, projectRoot } = await fixture('budget', {
    document: {
      models: { entries: [modelEntry(provider.model.baseUrl)] },
      credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
      limits: { credentials: {}, sharedGroups: {}, defaultBudgetTokens: 1000 },
    },
    env: { GRAPH_LOCAL_KEY: 'key' },
  });
  const document = (limits: Record<string, unknown>) => ({
    version: 1,
    projects: [{ id: 'p', root: projectRoot }],
    models: { entries: [modelEntry(provider.model.baseUrl)] },
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    limits: { credentials: {}, sharedGroups: {}, ...limits },
  });
  const first = await daemon.server.runtime.user.begin({ projectId: 'p', request: 'first', requestId: 'b1' });
  expect((await daemon.server.runtime.user.task(first.taskId).view()).nodes[0]).toMatchObject({ budget: 1000, unlimited: false });
  const unlimited = await post(daemon, api, '/api/config', { expectedRevision: 0, document: document({ defaultBudgetTokens: null }) });
  expect(unlimited.body).toMatchObject({ applied: true });
  const second = await daemon.server.runtime.user.begin({ projectId: 'p', request: 'second', requestId: 'b2' });
  expect((await daemon.server.runtime.user.task(second.taskId).view()).nodes[0]).toMatchObject({ budget: null, unlimited: true });
  // The old instance keeps its finite policy; a later finite change only
  // affects instances created after it.
  const finite = await post(daemon, api, '/api/config', { expectedRevision: 1, document: document({ defaultBudgetTokens: 500 }) });
  expect(finite.body).toMatchObject({ applied: true });
  const third = await daemon.server.runtime.user.begin({ projectId: 'p', request: 'third', requestId: 'b3' });
  expect((await daemon.server.runtime.user.task(third.taskId).view()).nodes[0]).toMatchObject({ budget: 500, unlimited: false });
  expect((await daemon.server.runtime.user.task(first.taskId).view()).nodes[0]).toMatchObject({ budget: 1000, unlimited: false });
}, 30_000);

test('the same upstream model id on two platforms becomes two connections (UC-R08)', () => {
  const first = buildTemplateConfigDocument({}, {
    providerId: 'platform-a', api: 'openai-completions', baseUrl: 'https://a.example/v1',
    credentialId: 'a', secretRef: 'A_KEY', models: [{ id: 'same-model', grade: 'high', contextWindow: 32_000, maxTokens: 256 }],
  });
  const both = buildTemplateConfigDocument(first, {
    providerId: 'platform-b', api: 'openai-completions', baseUrl: 'https://b.example/v1',
    credentialId: 'b', secretRef: 'B_KEY', models: [{ id: 'same-model', grade: 'high', contextWindow: 32_000, maxTokens: 256 }],
  });
  const entries = (both as { models: { entries: Record<string, unknown>[] } }).models.entries;
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ id: 'same-model', modelId: 'same-model', provider: 'platform-a', credentialId: 'a' });
  expect(entries[1]).toMatchObject({ id: 'same-model-platform-b', modelId: 'same-model', provider: 'platform-b', credentialId: 'b' });
  // Re-adding the first platform keeps its identity and does not duplicate.
  const again = buildTemplateConfigDocument(both, {
    providerId: 'platform-a', api: 'openai-completions', baseUrl: 'https://a.example/v1',
    credentialId: 'a', secretRef: 'A_KEY', models: [{ id: 'same-model', grade: 'high', contextWindow: 32_000, maxTokens: 256 }],
  });
  expect(((again as { models: { entries: unknown[] } }).models.entries)).toHaveLength(2);
});

test('each connection sends its own endpoint with the upstream model id (UC-R08)', async () => {
  const platformA = await openaiServer([{ text: 'from-a' }]);
  cleanup.push(() => platformA.close());
  const platformB = await openaiServer([{ text: 'from-b' }]);
  cleanup.push(() => platformB.close());
  const { daemon, api } = await fixture('wire', {
    document: {
      models: { entries: [
        modelEntry(platformB.model.baseUrl, { id: 'same-model-b', modelId: 'same-model', provider: 'platform-b', credentialId: 'b' }),
        modelEntry(platformA.model.baseUrl, { id: 'same-model-a', modelId: 'same-model', provider: 'platform-a', credentialId: 'a' }),
      ] },
      credentials: { a: { secretRef: 'A_KEY' }, b: { secretRef: 'B_KEY' } },
    },
    env: { A_KEY: 'key-a', B_KEY: 'key-b' },
  });
  const started = await daemon.server.runtime.user.begin({ projectId: 'p', request: 'wire', requestId: 'w1' });
  expect(started.taskId).toBeTruthy();
  await waitFor(() => (platformB.requests.length ? true : undefined));
  expect((platformB.requests[0] as { model?: string }).model).toBe('same-model');
  expect(platformA.requests).toHaveLength(0);
  expect(api.cookie).toBeTruthy();
}, 30_000);
