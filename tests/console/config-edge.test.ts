import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startGraphDaemon, type GraphDaemon } from '../../src/server/start.ts';
import { TaskStore } from '../../src/core/store.ts';
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

test('a root move for a project with active tasks is rejected before any write (UC-R02-R1)', async () => {
  const { daemon, api, configPath, stateDir, projectRoot } = await fixture('project-candidate', {
    document: {
      models: { entries: [modelEntry('http://127.0.0.1:9')] },
      credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    },
    env: { GRAPH_LOCAL_KEY: 'key' },
  });
  await daemon.server.runtime.user.begin({ projectId: 'p', request: 'active work', requestId: 'active-1' });
  const moved = join(projectRoot, '..', 'moved-root');
  await mkdir(moved, { recursive: true });
  const bytesBefore = await readFile(configPath, 'utf8');
  const applied = await post(daemon, api, '/api/config', {
    expectedRevision: 0,
    document: {
      version: 1,
      projects: [{ id: 'p', root: moved }],
      models: { entries: [modelEntry('http://127.0.0.1:9')] },
      credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    },
  });
  const body = applied.body as { applied?: boolean; reason?: string; code?: string };
  expect(applied.status === 400 || body.applied === false).toBe(true);
  expect(JSON.stringify(body)).toMatch(/tasks in flight/);
  expect(await readFile(configPath, 'utf8')).toBe(bytesBefore);
  const settings = await (await fetch(`${daemon.url}/api/settings`, { headers: api.headers })).json() as { projects: { id: string; root: string }[] };
  expect(settings.projects[0]!.root).toBe(projectRoot);
  const db = new TaskStore(join(stateDir, 'tasks.sqlite'));
  const row = db.db.prepare("SELECT root FROM projects WHERE id='p'").get() as { root: string };
  expect(row.root).toBe(projectRoot);
  db.close();
}, 30_000);

test('revocation persistence failure is reported and never silently re-enables a key (UC-R09-R1)', async () => {
  const { daemon, api, stateDir, token, configPath, env } = await fixture('revoke-persist', {
    document: { models: { entries: [modelEntry('http://127.0.0.1:9')] }, credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } } },
    env: { GRAPH_LOCAL_KEY: 'real-key' },
  });
  // A directory at the revocation path makes the atomic write fail.
  await mkdir(join(stateDir, 'revoked-secrets.json'), { recursive: true });
  const bridge = (body: unknown) => fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': token, origin: daemon.url }, body: JSON.stringify(body),
  }).then(response => response.json() as Promise<Record<string, unknown>>);
  const failed = await bridge({ ref: 'GRAPH_LOCAL_KEY', value: null });
  expect(failed).toMatchObject({ applied: false });
  expect(String(failed.reason)).toMatch(/持久化/);
  const startup = await (await fetch(`${daemon.url}/api/startup`, { headers: api.headers })).json() as { configured: boolean };
  expect(startup.configured).toBe(true);
  await daemon.close();
  // With the obstruction removed, revocation reports success and survives restart.
  await rm(join(stateDir, 'revoked-secrets.json'), { recursive: true, force: true });
  const restarted = await startGraphDaemon({ configPath, stateDir, webDir: join(stateDir, '..', 'web'), port: 0, mode: 'execute', dynamic: true, env, log: () => undefined });
  cleanup.push(() => restarted.close());
  const token2 = (await readFile(join(stateDir, 'app-token'), 'utf8')).trim();
  const ok = await fetch(`${restarted.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': token2, origin: restarted.url },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: null }),
  }).then(response => response.json() as Promise<Record<string, unknown>>);
  expect(ok).toMatchObject({ applied: true });
  await restarted.close();
  const again = await startGraphDaemon({ configPath, stateDir, webDir: join(stateDir, '..', 'web'), port: 0, mode: 'execute', dynamic: true, env: { ...env, GRAPH_LOCAL_KEY: 'real-key' }, log: () => undefined });
  cleanup.push(() => again.close());
  const session2 = await session(again.url);
  const startup2 = await (await fetch(`${again.url}/api/startup`, { headers: session2.headers })).json() as { configured: boolean };
  expect(startup2.configured).toBe(false);
}, 30_000);

test('a corrupt revocation file starts fail-closed instead of re-enabling keys (UC-R09-R1)', async () => {
  const { daemon, configPath, stateDir, env } = await fixture('revoke-corrupt', {
    document: { models: { entries: [modelEntry('http://127.0.0.1:9')] }, credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } } },
    env: { GRAPH_LOCAL_KEY: 'real-key' },
  });
  await daemon.close();
  await writeFile(join(stateDir, 'revoked-secrets.json'), '{"not":"an array"}\n');
  const logs: string[] = [];
  const restarted = await startGraphDaemon({ configPath, stateDir, webDir: join(stateDir, '..', 'web'), port: 0, mode: 'execute', dynamic: true, env, log: line => logs.push(line) });
  cleanup.push(() => restarted.close());
  const api = await session(restarted.url);
  const startup = await (await fetch(`${restarted.url}/api/startup`, { headers: api.headers })).json() as { configured: boolean };
  // Fail-closed: the unusable file does not silently re-enable the key.
  expect(startup.configured).toBe(false);
  expect(logs.some(line => line.includes('Revocation file unusable'))).toBe(true);
}, 30_000);

test('aliases sharing one upstream model cannot act as an independent reviewer (UC-R08-R1)', async () => {
  const { modelIdentity, selectModel } = await import('../../src/catalog/models.ts');
  const base = { provider: 'p', grade: 'high' as const, api: 'openai-completions' as const, contextWindow: 32_000, maxTokens: 256 };
  const writer = { ...base, id: 'writer', modelId: 'same-upstream', baseUrl: 'https://a.example/v1' };
  const alias = { ...base, id: 'writer-alias', modelId: 'same-upstream', baseUrl: 'https://b.example/v1' };
  const reviewer = { ...base, id: 'reviewer', modelId: 'other-upstream', baseUrl: 'https://c.example/v1' };
  expect(modelIdentity(writer)).toBe('same-upstream');
  expect(modelIdentity({ id: 'legacy' })).toBe('legacy');
  expect(selectModel({ grade: 'high', directory: [writer, alias, reviewer], exclude: ['same-upstream'] })?.id).toBe('reviewer');
  // Only aliases of the implementer model: no independent reviewer exists.
  expect(selectModel({ grade: 'high', directory: [writer, alias], exclude: ['same-upstream'] })).toBeUndefined();
}, 30_000);

test('concurrent revocations of two connections persist both refs (UC-R09-R2)', async () => {
  const { daemon, api, stateDir, configPath, env, token } = await fixture('revoke-concurrent', {
    document: {
      models: { entries: [modelEntry('http://127.0.0.1:9', { id: 'm1', provider: 'graph-openai-a', credentialId: 'c1' }), modelEntry('http://127.0.0.1:9', { id: 'm2', provider: 'graph-openai-b', credentialId: 'c2' })] },
      credentials: { c1: { secretRef: 'KEY_A' }, c2: { secretRef: 'KEY_B' } },
    },
    env: { KEY_A: 'key-a', KEY_B: 'key-b' },
  });
  const bridge = (ref: string) => fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': token, origin: daemon.url },
    body: JSON.stringify({ ref, value: null }),
  }).then(response => response.json() as Promise<Record<string, unknown>>);
  const results = await Promise.all([bridge('KEY_A'), bridge('KEY_B')]);
  expect(results.every(result => result.applied === true)).toBe(true);
  expect(JSON.parse(await readFile(join(stateDir, 'revoked-secrets.json'), 'utf8'))).toEqual(['KEY_A', 'KEY_B']);
  await daemon.close();
  const restarted = await startGraphDaemon({ configPath, stateDir, webDir: join(stateDir, '..', 'web'), port: 0, mode: 'execute', dynamic: true, env, log: () => undefined });
  cleanup.push(() => restarted.close());
  const restartedSession = await session(restarted.url);
  const startup = await (await fetch(`${restarted.url}/api/startup`, { headers: restartedSession.headers })).json() as { enabledModelCount: number };
  expect(startup.enabledModelCount).toBe(0);
}, 30_000);
