import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startGraphDaemon, type GraphDaemon } from '../../src/server/start.ts';
import { createModelScheduler } from '../../src/runtime/model-scheduler.ts';
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
  const root = await mkdtemp(join(tmpdir(), `graph-hot-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const web = join(root, 'web');
  await mkdir(web, { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><html><body><div id="root">Graph</div></body></html>');
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, revision: 0, projects: [{ id: 'p', root: projectRoot }], ...options.document }, null, 2));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir: web, port: 0, mode: 'execute', dynamic: true, env: options.env ?? {}, log: () => undefined });
  cleanup.push(() => daemon.close());
  return { root, projectRoot, configPath, daemon, projectId: 'p' };
}

function modelDocument(server: Awaited<ReturnType<typeof openaiServer>>, limits?: Record<string, number>) {
  return {
    version: 1,
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: server.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }],
    },
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    ...(limits ? { limits: { credentials: limits } } : {}),
  };
}

async function waitFor<T>(check: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('a clean app enables dispatch and keeps the same daemon, master instance and session', async () => {
  const provider = await openaiServer([{ text: '你好，我已准备就绪。' }, { text: '继续聊。' }]);
  cleanup.push(() => provider.close());
  const { daemon, projectId } = await fixture('enable', { document: {} });
  const api = await session(daemon.url);

  // First run: execute intent but nothing can be dispatched.
  const startup = await (await fetch(`${daemon.url}/api/startup`, { headers: api.headers })).json() as { configured: boolean; mode: string };
  expect(startup).toMatchObject({ configured: false, mode: 'execute' });

  const saved = await fetch(`${daemon.url}/api/config`, {
    method: 'POST', headers: api.headers,
    body: JSON.stringify({ expectedRevision: 0, document: modelDocument(provider, { local: 1 }) }),
  });
  const savedBody = await saved.json() as { applied: boolean; effectiveRevision: number; configured: boolean };
  expect(savedBody).toMatchObject({ applied: true, effectiveRevision: 1, configured: false });

  const created = await (await fetch(`${daemon.url}/api/conversations`, {
    method: 'POST', headers: api.headers,
    body: JSON.stringify({ text: '先聊聊目标。', requestId: 'conv-1' }),
  })).json() as { conversationId: string };
  expect(provider.authorizations).toHaveLength(0);

  // The key arrives through the token bridge; the same daemon activates it.
  const pushed = await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': daemon.appToken, origin: daemon.url },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: 'first-key' }),
  });
  expect(await pushed.json()).toMatchObject({ applied: true, configured: true });

  await waitFor(() => provider.authorizations.length >= 1 ? true : undefined);
  expect(provider.authorizations[0]).toContain('Bearer first-key');
  const view = await (await fetch(`${daemon.url}/api/conversations/${created.conversationId}`, { headers: api.headers })).json() as { anchorTaskId: string };
  const before = await (await fetch(`${daemon.url}/api/tasks/${view.anchorTaskId}`, { headers: api.headers })).json() as { nodes: { instanceId: string; status: string }[] };
  const instanceBefore = before.nodes[0]!.instanceId;

  // A key rotation applies to the next unsent call without a new instance.
  const rotated = await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': daemon.appToken, origin: daemon.url },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: 'second-key' }),
  });
  expect(await rotated.json()).toMatchObject({ applied: true });
  await (await fetch(`${daemon.url}/api/conversations/${created.conversationId}/messages`, {
    method: 'POST', headers: api.headers,
    body: JSON.stringify({ text: '继续，第二句。', requestId: 'conv-1-second' }),
  })).json();
  await waitFor(() => provider.authorizations.length >= 2 ? true : undefined);
  expect(provider.authorizations[1]).toContain('Bearer second-key');
  const after = await (await fetch(`${daemon.url}/api/tasks/${view.anchorTaskId}`, { headers: api.headers })).json() as { nodes: { instanceId: string }[] };
  expect(after.nodes[0]!.instanceId).toBe(instanceBefore);
  // The process never restarted: the same daemon object still serves the URL.
  expect(daemon.server.driving()).toBe(true);
}, 60_000);

test('a queued send re-queues under the rotated key while the in-flight call keeps the old one', async () => {
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
  const provider = await openaiServer([
    { text: 'first done', beforeReply: () => firstReleased },
    { text: 'second done' },
  ]);
  cleanup.push(() => provider.close());
  const { daemon } = await fixture('rotate', { document: modelDocument(provider, { local: 1 }) });
  const api = await session(daemon.url);
  await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': daemon.appToken, origin: daemon.url },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: 'key-one' }),
  });

  await fetch(`${daemon.url}/api/conversations`, {
    method: 'POST', headers: api.headers, body: JSON.stringify({ text: '第一个会话。', requestId: 'conv-a' }),
  });
  await waitFor(() => provider.authorizations.length >= 1 ? true : undefined);
  expect(provider.authorizations[0]).toContain('Bearer key-one');

  // The second conversation waits for the single credential slot.
  await fetch(`${daemon.url}/api/conversations`, {
    method: 'POST', headers: api.headers, body: JSON.stringify({ text: '第二个会话。', requestId: 'conv-b' }),
  });
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(provider.authorizations).toHaveLength(1);

  await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': daemon.appToken, origin: daemon.url },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: 'key-two' }),
  });
  releaseFirst();
  await waitFor(() => provider.authorizations.length >= 2 ? true : undefined);
  // The in-flight call kept key-one; the queued call re-resolved to key-two.
  expect(provider.authorizations[0]).toContain('Bearer key-one');
  expect(provider.authorizations[1]).toContain('Bearer key-two');
}, 60_000);

test('removing a key blocks new sends and reports it as unattached pending work', async () => {
  const provider = await openaiServer([{ text: 'hello' }]);
  cleanup.push(() => provider.close());
  const { daemon } = await fixture('disable', { document: modelDocument(provider) });
  const api = await session(daemon.url);
  await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': daemon.appToken, origin: daemon.url },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: 'live-key' }),
  });
  const created = await (await fetch(`${daemon.url}/api/conversations`, {
    method: 'POST', headers: api.headers, body: JSON.stringify({ text: '第一句。', requestId: 'conv-1' }),
  })).json() as { conversationId: string };
  await waitFor(() => provider.authorizations.length >= 1 ? true : undefined);

  const disabled = await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': daemon.appToken, origin: daemon.url },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: null }),
  });
  expect(await disabled.json()).toMatchObject({ applied: true, configured: false });
  const before = provider.authorizations.length;
  await fetch(`${daemon.url}/api/conversations/${created.conversationId}/messages`, {
    method: 'POST', headers: api.headers, body: JSON.stringify({ text: '禁用后不应发出。', requestId: 'conv-2' }),
  });
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(provider.authorizations).toHaveLength(before);
  const view = await (await fetch(`${daemon.url}/api/conversations/${created.conversationId}`, { headers: api.headers })).json() as { messages: { text: string; state: string }[] };
  expect(view.messages.some(message => message.text.includes('禁用后不应发出') && message.state === 'pending')).toBe(true);
  const startup = await (await fetch(`${daemon.url}/api/startup`, { headers: api.headers })).json() as { configured: boolean };
  expect(startup.configured).toBe(false);
}, 60_000);

test('the app bridge rejects requests without the per-process token', async () => {
  const provider = await openaiServer([]);
  cleanup.push(() => provider.close());
  const { daemon } = await fixture('token', { document: modelDocument(provider) });
  const api = await session(daemon.url);
  const noToken = await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: daemon.url },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: 'x' }),
  });
  expect(noToken.status).toBe(403);
  const wrongToken = await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': 'not-the-token', origin: daemon.url },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: 'x' }),
  });
  expect(wrongToken.status).toBe(403);
  // A valid browser session alone is not enough for the secret bridge.
  const sessionOnly = await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: api.headers, body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: 'x' }),
  });
  expect(sessionOnly.status).toBe(403);
}, 30_000);

test('a rejected candidate keeps the previous effective bindings', async () => {
  const provider = await openaiServer([{ text: 'ok' }]);
  cleanup.push(() => provider.close());
  const { daemon } = await fixture('conflict', { document: modelDocument(provider) });
  const api = await session(daemon.url);
  // Persist one valid revision first so the effective revision is 1.
  const initial = await fetch(`${daemon.url}/api/config`, {
    method: 'POST', headers: api.headers, body: JSON.stringify({ expectedRevision: 0, document: modelDocument(provider) }),
  });
  expect(initial.status).toBe(200);
  await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': daemon.appToken, origin: daemon.url },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: 'stable-key' }),
  });
  const conflictDocument = {
    version: 1,
    projects: [{ id: 'p', root: '/tmp' }],
    models: { entries: [
      { id: 'a', provider: 'pa', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'alias-a' },
      { id: 'b', provider: 'pb', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'alias-b' },
    ] },
    credentials: { 'alias-a': { secretRef: 'SAME_A', sharedLimitGroupId: 'g1' }, 'alias-b': { secretRef: 'SAME_B', sharedLimitGroupId: 'g2' } },
  };
  // Both refs resolve to the same pushed value under different groups.
  await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': daemon.appToken, origin: daemon.url },
    body: JSON.stringify({ ref: 'SAME_A', value: 'one-key' }),
  });
  await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': daemon.appToken, origin: daemon.url },
    body: JSON.stringify({ ref: 'SAME_B', value: 'one-key' }),
  });
  const rejected = await fetch(`${daemon.url}/api/config`, {
    method: 'POST', headers: api.headers, body: JSON.stringify({ expectedRevision: 1, document: conflictDocument }),
  });
  const rejectedBody = await rejected.json() as { applied: boolean; effectiveRevision: number; reason?: string };
  expect(rejectedBody.applied).toBe(false);
  expect(rejectedBody.reason).toContain('sharedLimitGroupId');
  expect(rejectedBody.effectiveRevision).toBe(1);

  // The previously effective local model still dispatches with the old key.
  await fetch(`${daemon.url}/api/conversations`, {
    method: 'POST', headers: api.headers, body: JSON.stringify({ text: '继续使用旧配置。', requestId: 'conv-old' }),
  });
  await waitFor(() => provider.authorizations.length >= 1 ? true : undefined);
  expect(provider.authorizations[0]).toContain('Bearer stable-key');
}, 60_000);

test('the scheduler applies a lowered limit to waiters and re-queues on key rotation', async () => {
  const scheduler = createModelScheduler();
  const release1 = await scheduler.acquire({ credentialId: 'local', apiKey: 'a', limit: 2 });
  const release2 = await scheduler.acquire({ credentialId: 'local', apiKey: 'a', limit: 2 });
  let granted = false;
  const waiting = scheduler.acquire({
    credentialId: 'local', apiKey: 'a', limit: 2,
    refresh: () => ({ credentialId: 'local', apiKey: 'a', limit: 1 }),
  }).then(release => { granted = true; return release; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(granted).toBe(false);
  release1();
  await new Promise(resolve => setTimeout(resolve, 20));
  // The lowered limit of 1 is already used by the second active call.
  expect(granted).toBe(false);
  release2();
  const release3 = await waiting;
  expect(granted).toBe(true);
  release3();

  // A queued request whose key rotates moves to the new scheduling identity.
  const hold = await scheduler.acquire({ credentialId: 'local', apiKey: 'old', limit: 1 });
  let rotated = false;
  const second = scheduler.acquire({
    credentialId: 'local', apiKey: 'old', limit: 1,
    refresh: () => ({ credentialId: 'local', apiKey: 'new', limit: 1 }),
  }).then(release => { rotated = true; return release; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(rotated).toBe(false);
  hold();
  const release4 = await second;
  expect(rotated).toBe(true);
  release4();
  expect(scheduler.queued()).toBe(0);
}, 30_000);

test('an endpoint change while a request waits never sends the new key to the old platform', async () => {
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
  const providerA = await openaiServer([{ text: 'first done', beforeReply: () => firstReleased }]);
  const providerB = await openaiServer([{ text: 'should not happen' }]);
  cleanup.push(() => providerA.close());
  cleanup.push(() => providerB.close());
  // Safety: release the delayed response before closes even if the test fails.
  cleanup.push(async () => { releaseFirst(); });
  const { daemon } = await fixture('endpoint', { document: modelDocument(providerA, { local: 1 }) });
  const api = await session(daemon.url);
  // Persist one valid revision so the endpoint change targets revision 1.
  const initial = await fetch(`${daemon.url}/api/config`, {
    method: 'POST', headers: api.headers, body: JSON.stringify({ expectedRevision: 0, document: modelDocument(providerA, { local: 1 }) }),
  });
  expect(initial.status).toBe(200);
  await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': daemon.appToken, origin: daemon.url },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: 'key-one' }),
  });
  const first = await (await fetch(`${daemon.url}/api/conversations`, {
    method: 'POST', headers: api.headers, body: JSON.stringify({ text: '第一个。', requestId: 'endpoint-a' }),
  })).json() as { conversationId: string };
  await waitFor(() => providerA.authorizations.length >= 1 ? true : undefined);
  const second = await (await fetch(`${daemon.url}/api/conversations`, {
    method: 'POST', headers: api.headers, body: JSON.stringify({ text: '第二个。', requestId: 'endpoint-b' }),
  })).json() as { conversationId: string };
  await new Promise(resolve => setTimeout(resolve, 150));

  // Same provider label, different endpoint; rotate the key at the same time.
  await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': daemon.appToken, origin: daemon.url },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: 'key-two' }),
  });
  const changed = await fetch(`${daemon.url}/api/config`, {
    method: 'POST', headers: api.headers,
    body: JSON.stringify({
      expectedRevision: 1,
      document: {
        version: 1,
        projects: [{ id: 'p', root: '/tmp' }],
        models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: providerB.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] },
        credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
        limits: { credentials: { local: 1 } },
      },
    }),
  });
  expect(await changed.json()).toMatchObject({ applied: true });
  releaseFirst();
  await new Promise(resolve => setTimeout(resolve, 500));
  // The new key never goes to the old endpoint: provider A saw exactly the
  // in-flight call with the old key. A re-prepared request may hit provider B,
  // but only with the key that the same config snapshot binds to it.
  expect(providerA.authorizations).toEqual(['Bearer key-one']);
  expect(providerB.authorizations.every(value => value.includes('Bearer key-two'))).toBe(true);
  expect(providerB.authorizations.some(value => value.includes('Bearer key-one'))).toBe(false);
  const firstView = await (await fetch(`${daemon.url}/api/conversations/${first.conversationId}`, { headers: api.headers })).json() as { messages: { text: string; state: string }[] };
  expect(firstView.messages.some(message => message.text.includes('第一个') && message.state === 'delivered')).toBe(true);
}, 60_000);
