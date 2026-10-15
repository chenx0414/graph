import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const SECRET = 'synth-provider-e2e-secret';
async function daemon(document: Record<string, unknown> = {}, mode: 'view' | 'execute' = 'view') {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-provider-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }], ...document }));
  const host = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir, port: 0, mode, dynamic: true, env: { HOME: root, GRAPH_LOCAL_KEY: SECRET, GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY: SECRET }, log: () => undefined });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await host.close(); } };
  cleanup.push(close);
  const home = await fetch(host.url, { headers: { origin: host.url } });
  const headers = { origin: host.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  return { host, close, root, webDir, configPath, get: (path: string) => fetch(`${host.url}${path}`, { headers }), post: (path: string, body: unknown) => fetch(`${host.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }) };
}

test('provider directory and probes enforce the browser boundary and actual vendor protocols', async () => {
  const requests: { path: string; headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  let list: unknown = { data: [{ id: 'first', name: 'First' }, { id: 'first' }] };
  let status = 200;
  let error: unknown = { error: { message: 'subscription does not allow listing' } };
  let rawResponse: string | undefined;
  const vendor = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url ?? '', headers: request.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} });
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(rawResponse ?? JSON.stringify(status !== 200 ? error : request.url?.endsWith('/models') ? list : { choices: [] }));
  });
  await new Promise<void>(resolve => vendor.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { vendor.closeAllConnections(); await new Promise<void>(resolve => vendor.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}/v1`;
  const api = await daemon({ credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY', displayName: 'Local', sharedLimitGroupId: 'team' }, idle: { secretRef: 'GRAPH_MISSING_KEY' } }, limits: { credentials: { local: 2 }, sharedGroups: { team: 4 } } });
  const directoryResponse = await api.get('/api/providers');
  expect(directoryResponse.status).toBe(200);
  const directory = await directoryResponse.json();
  expect(directory.platforms.map((entry: { id: string }) => entry.id)).toEqual(expect.arrayContaining(['opencode-go', 'command-goat', 'grok', 'chatgpt', 'deepseek', 'custom']));
  expect(directory.platforms.find((entry: { id: string }) => entry.id === 'deepseek')).toMatchObject({ credentialConfigured: true, credentialRef: 'GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY' });
  expect(directory.platforms.find((entry: { id: string }) => entry.id === 'grok')).toMatchObject({ credentialConfigured: false, credentialRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN' });
  expect(directory.credentials).toMatchObject({ local: { resolved: true, displayName: 'Local', sharedLimitGroupId: 'team' }, idle: { resolved: false } });
  expect(directory.platforms.find((entry: { id: string }) => entry.id === 'opencode-go')).toMatchObject({ api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1', credentialRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY', modelsListSupported: true });
  for (const platform of directory.platforms) expect(typeof platform.modelsListSupported).toBe('boolean');
  expect((await (await api.get('/api/config')).json()).config.limits).toMatchObject({ credentials: { local: 2 }, sharedGroups: { team: 4 } });
  expect(JSON.stringify(directory)).not.toContain(SECRET);
  expect((await fetch(`${api.host.url}/api/providers`)).status).toBe(401);
  expect((await api.get('/api/app/providers')).status).toBe(403);
  const provider = { id: 'custom', label: 'Gateway', baseUrl, api: 'openai-completions', credentialRef: 'GRAPH_LOCAL_KEY' };
  let serial = 0;
  const probe = (overrides: Record<string, unknown> = {}) => api.post('/api/providers/probe', { requestId: `probe-${serial++}`, provider, ...overrides });
  let body = await (await probe()).json();
  expect(body.models).toEqual([{ id: 'first', name: 'First' }]);
  expect(body.verification).toEqual({ ok: true, status: 200 });
  expect(requests[0]).toMatchObject({ path: '/v1/models', headers: { authorization: `Bearer ${SECRET}`, accept: 'application/json' } });
  expect(requests[1]).toMatchObject({ path: '/v1/chat/completions', headers: { authorization: `Bearer ${SECRET}` }, body: { model: 'first', max_tokens: 1, stream: false } });
  expect(JSON.stringify(body)).not.toContain(SECRET);
  for (const [payload, expected] of [
    [{ models: ['a', { model: 'b', display_name: 'Bee' }] }, [{ id: 'a' }, { id: 'b', name: 'Bee' }]],
    [[{ slug: 'c' }], [{ id: 'c' }]],
    [{}, []],
  ] as const) {
    list = payload;
    body = await (await probe()).json();
    expect(body.models).toEqual(expected);
  }
  list = { data: [{ id: 'anthropic-model' }] };
  requests.length = 0;
  body = await (await probe({ provider: { ...provider, api: 'anthropic-messages' } })).json();
  expect(body.verification.ok).toBe(true);
  expect(requests[0]).toMatchObject({ path: '/v1/models', headers: { 'x-api-key': SECRET, 'anthropic-version': '2023-06-01' } });
  expect(requests[0]!.headers.authorization).toBeUndefined();
  expect(requests[1]).toMatchObject({ path: '/v1/messages', headers: { 'x-api-key': SECRET, 'anthropic-version': '2023-06-01' }, body: { model: 'anthropic-model', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] } });
  expect(requests[1]!.headers.authorization).toBeUndefined();
  requests.length = 0;
  body = await (await probe({ provider: { id: 'opencode-go', baseUrl, credentialRef: 'GRAPH_LOCAL_KEY', modelsListSupported: false } })).json();
  expect(body.verification.ok).toBe(true);
  expect(requests.map(request => request.path)).toEqual(['/v1/models', '/v1/chat/completions']);
  expect(requests.every(request => request.headers['x-opencode-session'] === 'graph-console')).toBe(true);
  requests.length = 0;
  body = await (await probe({ probeModels: false, modelId: 'manual' })).json();
  expect(body.verification.ok).toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ path: '/v1/chat/completions', body: { model: 'manual' } });
  for (const [code, payload, message] of [[403, error, 'subscription does not allow listing'], [429, { error: { message: 'Rate limit reached' } }, 'Rate limit reached'], [503, {}, 'HTTP 503']] as const) {
    status = code; error = payload;
    body = await (await probe({ modelId: 'manual' })).json();
    expect(body.modelsError).toBe(message);
    expect(body.verification).toEqual({ ok: false, status: code, error: message });
  }
  status = 200;
  rawResponse = '';
  body = await (await probe({ modelId: 'manual' })).json();
  expect(body.models).toEqual([]);
  expect(body.verification).toEqual({ ok: true, status: 200 });
  for (const [code, wire, message] of [
    [500, 'upstream unavailable', 'upstream unavailable'],
    [429, JSON.stringify('quota exceeded'), 'quota exceeded'],
    [400, JSON.stringify({ message: 'invalid model' }), 'invalid model'],
  ] as const) {
    status = code; rawResponse = wire;
    body = await (await probe({ modelId: 'manual' })).json();
    expect(body.modelsError).toBe(message);
    expect(body.verification).toEqual({ ok: false, status: code, error: message });
  }
  rawResponse = undefined;
  status = 200;
  requests.length = 0;
  body = await (await probe({ provider: { ...provider, credentialRef: 'GRAPH_MISSING_KEY' } })).json();
  expect(body.credentialConfigured).toBe(false);
  expect(body.verification.error).toContain('GRAPH_MISSING_KEY');
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers.authorization).toBeUndefined();
  requests.length = 0;
  for (const [invalid, fields] of [
    [{ requestId: undefined }, ['requestId']], [{ requestId: '   ' }, ['requestId']],
    [{ provider: { id: 'custom' } }, ['baseUrl', 'api', 'label']],
    [{ provider: { ...provider, baseUrl: 'ftp://invalid' } }, ['baseUrl']],
    [{ provider: { ...provider, api: 'responses' } }, ['api']],
    [{ provider: { ...provider, label: undefined, name: 'wrong-field' } }, ['label']],
    [{ provider: { ...provider, credentialRef: 'not a ref' } }, ['credentialRef']],
    [{ provider: { ...provider, id: 'not-a-platform' } }, ['id']],
  ] as const) {
    const rejected = await probe(invalid);
    expect(rejected.status).toBe(400);
    const failure = await rejected.json();
    expect(failure).toMatchObject({ code: 'invalid_input' });
    for (const field of fields) expect(failure.message).toContain(`${field}:`);
  }
  expect(requests).toHaveLength(0);
  const flat = await api.post('/api/providers/probe', { ...provider, requestId: 'flat', modelId: 'manual', probeModels: false });
  expect(await flat.json()).toMatchObject({ provider: { label: 'Gateway', credentialRef: 'GRAPH_LOCAL_KEY' }, verification: { ok: true } });
  const defaultRef = await probe({ provider: { ...provider, credentialRef: undefined } });
  expect(await defaultRef.json()).toMatchObject({ provider: { credentialRef: 'GRAPH_PROVIDER_API_KEY' }, credentialConfigured: false });
  const unavailable = createServer();
  await new Promise<void>(resolve => unavailable.listen(0, '127.0.0.1', resolve));
  const unavailablePort = (unavailable.address() as AddressInfo).port;
  await new Promise<void>(resolve => unavailable.close(() => resolve()));
  const failedTransport = await probe({ provider: { ...provider, baseUrl: `http://127.0.0.1:${unavailablePort}/v1` }, probeModels: false, modelId: 'manual' });
  const failedBody = await failedTransport.json();
  expect(failedBody.verification).toMatchObject({ ok: false, status: 0 });
  expect(failedBody.verification.error).toMatch(/fetch|connect/i);
}, 90_000);

test('saved request headers and credential availability reach real model conversations', async () => {
  const vendor = await openaiServer([{ text: 'first' }, { text: 'second' }, { text: 'third' }]);
  cleanup.push(() => vendor.close());
  const model = { id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: vendor.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local', headers: { 'x-opencode-session': 'graph-header-test' } };
  const document = { credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' }, missing: { secretRef: 'GRAPH_MISSING_KEY' } }, models: { entries: [model, { ...model, id: 'missing', provider: 'graph-openai-missing', credentialId: 'missing' }] } };
  const api = await daemon(document, 'execute');
  const created = await (await api.post('/api/conversations', { text: 'header check', model: 'local', requestId: 'headers' })).json();
  await expect.poll(() => vendor.requests.length, { timeout: 20_000 }).toBe(1);
  expect(vendor.authorizations[0]).toBe(`Bearer ${SECRET}`);
  expect(vendor.headerList[0]?.['x-opencode-session']).toBe('graph-header-test');
  await expect.poll(async () => (await (await api.get(`/api/tasks/${created.taskId}`)).json()).invocations[0]?.cost, { timeout: 20_000 }).toEqual({ unknown: true });
  const original = await readFile(api.configPath, 'utf8');
  for (const headers of [{ 'bad header': 'x' }, { 'x-test': '' }, { 'x-test': 42 }]) {
    const rejected = await api.post('/api/config', { expectedRevision: 0, document: { ...document, models: { entries: [{ ...model, headers }] } } });
    expect(rejected.status).toBe(400);
    expect(await readFile(api.configPath, 'utf8')).toBe(original);
  }
  const saved = await api.post('/api/config', { expectedRevision: 0, document: { ...document, models: { entries: [model, { ...model, id: 'go', provider: 'opencode-go', headers: undefined }] } } });
  expect(await saved.json()).toMatchObject({ applied: true, effectiveRevision: 1 });
  expect(await (await api.post('/api/config/test', { modelId: 'go' })).json()).toMatchObject({ ok: true });
  const next = await (await api.post('/api/conversations', { text: 'go header', model: 'go', requestId: 'go-header' })).json();
  const mainIndex = () => vendor.requests.findIndex(request => {
    const body = request as { tools?: unknown[]; messages?: { role: string; content: unknown }[] };
    return Boolean(body.tools?.length) && body.messages?.some(message => message.role === 'user' && JSON.stringify(message.content).includes('go header'));
  });
  await expect.poll(mainIndex, { timeout: 20_000 }).toBeGreaterThanOrEqual(0);
  const probeIndex = vendor.requests.findIndex(request => (request as { stream?: boolean }).stream === false);
  expect(probeIndex).toBeGreaterThanOrEqual(0);
  expect(vendor.headerList[probeIndex]?.['x-opencode-session']).toBe('graph-console');
  expect(vendor.headerList[mainIndex()]?.['x-opencode-session']).toEqual(expect.any(String));
  expect(vendor.headerList[mainIndex()]?.['x-opencode-session']?.length).toBeGreaterThan(0);
  await expect.poll(async () => (await (await api.get(`/api/tasks/${next.taskId}`)).json()).invocations[0]?.cost, { timeout: 20_000 }).toEqual({ unknown: true });
}, 90_000);

test('view-mode tasks recover through execute startup without dispatching removed projects', async () => {
  const vendor = await openaiServer([{ text: 'recovered master' }]);
  cleanup.push(() => vendor.close());
  const models = { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: vendor.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] };
  const api = await daemon({ models, credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } } });
  const before = JSON.parse(await readFile(api.configPath, 'utf8'));
  const document = { ...before, projects: [...before.projects, { id: 'gone', root: api.root }] };
  expect(await (await api.post('/api/config', { expectedRevision: 0, document })).json()).toMatchObject({ applied: true });
  const created = await (await api.post('/api/tasks', { projectId: 'p', request: 'queued in view mode', requestId: 'recover' })).json();
  const removed = await (await api.post('/api/tasks', { projectId: 'gone', request: 'removed project', requestId: 'removed' })).json();
  expect((await (await api.get(`/api/tasks/${created.taskId}`)).json()).nodes).toEqual([expect.objectContaining({ id: 'master', status: 'pending' })]);
  expect(vendor.requests).toHaveLength(0);
  await api.close();
  await writeFile(api.configPath, JSON.stringify({ ...document, revision: 2, projects: before.projects }));
  const execute = await startGraphDaemon({ configPath: api.configPath, stateDir: join(api.root, 'state'), graphHome: join(api.root, 'graph'), webDir: api.webDir, port: 0, mode: 'execute', env: { HOME: api.root, GRAPH_LOCAL_KEY: SECRET }, log: () => undefined });
  cleanup.push(() => execute.close());
  const home = await fetch(execute.url, { headers: { origin: execute.url } });
  const headers = { origin: execute.url, cookie: home.headers.get('set-cookie') ?? '' };
  const view = async (taskId: string) => (await fetch(`${execute.url}/api/tasks/${taskId}`, { headers })).json();
  await expect.poll(() => vendor.requests.length, { timeout: 20_000 }).toBe(1);
  expect(vendor.authorizations[0]).toBe(`Bearer ${SECRET}`);
  await expect.poll(async () => (await view(created.taskId)).nodes.find((node: { id: string }) => node.id === 'master')?.status, { timeout: 20_000 }).toBe('succeeded');
  expect((await view(removed.taskId)).nodes).toEqual([expect.objectContaining({ id: 'master', status: 'pending' })]);
  expect(vendor.requests).toHaveLength(1);
}, 90_000);
