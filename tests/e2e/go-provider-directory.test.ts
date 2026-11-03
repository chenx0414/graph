import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The provider directory and the probe that talks to a vendor.
 *
 * Before a model can be configured, a person needs to know which providers
 * exist, which credential each one wants, and whether that credential is
 * actually there. The directory answers that without ever handing a secret to
 * the browser, and it is closed to anyone who does not hold the session.
 *
 * A probe is a question to a vendor that was never saved: does it list its
 * models, does a credential work, and does the vendor answer in the protocol
 * it speaks? The probe speaks that protocol - the OpenAI-compatible one and
 * the Anthropic one - and a vendor that refuses keeps its own wording. A
 * malformed draft is refused by field, before anything is sent.
 *
 * The proof is a real daemon and a real vendor endpoint that records every
 * request it was sent.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

const SECRET = 'synth-provider-e2e-secret';

interface VendorRequest {
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/** The vendor. It records what it was sent and answers whatever the test says. */
async function vendor() {
  const requests: VendorRequest[] = [];
  let status = 200;
  let list: unknown = { data: [{ id: 'first', name: 'First' }] };
  let raw: string | undefined;
  let refusal: unknown;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headers[name] = Array.isArray(value) ? value.join(', ') : value ?? '';
    }
    requests.push({ path: request.url ?? '', headers, body: text ? JSON.parse(text) : {} });
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(raw ?? JSON.stringify(
      status !== 200 ? refusal ?? { error: { message: 'subscription does not allow listing' } }
        : request.url?.endsWith('/models') ? list : { choices: [] },
    ));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    answerWith: (nextStatus: number, next: { list?: unknown; raw?: string; refusal?: unknown } = {}) => {
      status = nextStatus;
      if (next.list !== undefined) list = next.list;
      raw = next.raw;
      refusal = next.refusal;
    },    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** A daemon with a configuration, a project and a vendor endpoint to talk to. */
async function daemonWith(document: (project: string, baseUrl: string) => Record<string, unknown>, env: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-provider-directory-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify(document(project, 'http://127.0.0.1:1/v1'), null, 2));
  const daemon = await launchCli(root, { configPath, env, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  return { root, project, configPath, daemon, request };
}

interface PlatformView {
  id: string;
  api: string;
  baseUrl: string;
  credentialRef: string;
  credentialConfigured: boolean;
  modelsListSupported: boolean;
}

interface DirectoryView {
  platforms: PlatformView[];
  credentials: Record<string, { secretRef: string; resolved: boolean; displayName?: string; sharedLimitGroupId?: string }>;
}

test('the provider directory shows what may be configured, and shows no secret', async () => {
  const api = await daemonWith(project => ({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: {
      local: { secretRef: 'GRAPH_LOCAL_KEY', displayName: 'Local', sharedLimitGroupId: 'team' },
      idle: { secretRef: 'GRAPH_MISSING_KEY' },
    },
    limits: { credentials: { local: 2 }, sharedGroups: { team: 4 } },
    models: { entries: [{
      id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000, maxTokens: 256, credentialId: 'local',
    }] },
    // The host may have a real Grok or OpenCode Go login in its environment;
    // this case asserts what an unconfigured platform looks like, so the
    // ambient keys are cleared instead of trusted.
  }), { GRAPH_LOCAL_KEY: SECRET, GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY: SECRET, GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN: '', GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY: '' });

  const directory = await api.request('/api/providers');
  expect(directory.status, JSON.stringify(directory.body)).toBe(200);
  const view = directory.body as DirectoryView;

  // The directory names every built-in platform, and each one says whether it
  // can list models and which credential it wants.
  expect(view.platforms.map(platform => platform.id)).toEqual(
    expect.arrayContaining(['opencode-go', 'command-goat', 'grok', 'chatgpt', 'deepseek', 'custom']),
  );
  for (const platform of view.platforms) expect(typeof platform.modelsListSupported).toBe('boolean');
  expect(view.platforms.find(platform => platform.id === 'opencode-go')).toMatchObject({
    api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1',
    credentialRef: 'GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY', modelsListSupported: true,
  });
  // A credential that is in the environment is configured; one that is not is not.
  expect(view.platforms.find(platform => platform.id === 'deepseek')).toMatchObject({
    credentialConfigured: true, credentialRef: 'GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY',
  });
  expect(view.platforms.find(platform => platform.id === 'grok')).toMatchObject({
    credentialConfigured: false, credentialRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN',
  });

  // The credentials the configuration declares are shown by name, with the
  // limits that belong to them.
  expect(view.credentials.local).toMatchObject({ resolved: true, displayName: 'Local', sharedLimitGroupId: 'team' });
  expect(view.credentials.idle).toMatchObject({ resolved: false });
  expect(JSON.stringify(view)).not.toContain(SECRET);

  const limits = await api.request('/api/config');
  expect(limits.status).toBe(200);
  expect((limits.body as { config: { limits: unknown } }).config.limits).toMatchObject({
    credentials: { local: 2 }, sharedGroups: { team: 4 },
  });

  // The directory is for the session, not for anyone on the network.
  const anonymous = await fetch(`${api.daemon.url}/api/providers`);
  expect(anonymous.status).toBe(401);
  const appBridge = await fetch(`${api.daemon.url}/api/app/providers`);
  expect(appBridge.status).toBe(403);
}, 120_000);

test('a probe speaks the vendor protocol and answers with the vendor models', async () => {
  const upstream = await vendor();
  cleanup.push(() => upstream.close());
  const api = await daemonWith((project, baseUrl) => ({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{
      id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local',
    }] },
  }), { GRAPH_LOCAL_KEY: SECRET });

  const provider = { id: 'custom', label: 'Gateway', baseUrl: upstream.baseUrl, api: 'openai-completions', credentialRef: 'GRAPH_LOCAL_KEY' };
  let serial = 0;
  const probe = async (overrides: Record<string, unknown> = {}) => {
    const response = await api.request('/api/providers/probe', {
      method: 'POST', body: JSON.stringify({ requestId: `probe-${serial++}`, provider, ...overrides }),
    });
    return { status: response.status, body: response.body as {
      provider: { label: string; credentialRef: string };
      credentialConfigured: boolean;
      models: { id: string; name?: string }[];
      verification: { ok: boolean; status?: number; error?: string };
    } };
  };

  // The list comes first, then one minimal chat request that proves the
  // credential works - and both carry the credential, never in the reply.
  const first = await probe();
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.models).toEqual([{ id: 'first', name: 'First' }]);
  expect(first.body.verification).toMatchObject({ ok: true, status: 200 });
  expect(first.body.credentialConfigured).toBe(true);
  expect(upstream.requests[0]).toMatchObject({
    path: '/v1/models', headers: { authorization: `Bearer ${SECRET}`, accept: 'application/json' },
  });
  expect(upstream.requests[1]).toMatchObject({
    path: '/v1/chat/completions', headers: { authorization: `Bearer ${SECRET}` },
    body: { model: 'first', max_tokens: 1, stream: false },
  });
  expect(JSON.stringify(first.body)).not.toContain(SECRET);

  // A vendor that lists its models in another shape still gets read.
  for (const [payload, expected] of [
    [{ models: ['a', { model: 'b', display_name: 'Bee' }] }, [{ id: 'a' }, { id: 'b', name: 'Bee' }]],
    [[{ slug: 'c' }], [{ id: 'c' }]],
    [{}, []],
  ] as const) {
    upstream.answerWith(200, { list: payload });
    const listed = await probe();
    expect(listed.body.models).toEqual(expected);
  }

  // The Anthropic protocol is a different protocol: its own header, its own
  // path, its own body - and no bearer token at all.
  upstream.answerWith(200, { list: { data: [{ id: 'anthropic-model' }] } });
  upstream.requests.length = 0;
  const anthropic = await probe({ provider: { ...provider, api: 'anthropic-messages' } });
  expect(anthropic.body.verification.ok).toBe(true);
  expect(upstream.requests[0]).toMatchObject({
    path: '/v1/models', headers: { 'x-api-key': SECRET, 'anthropic-version': '2023-06-01' },
  });
  expect(upstream.requests[0]!.headers.authorization).toBeUndefined();
  expect(upstream.requests[1]).toMatchObject({
    path: '/v1/messages', headers: { 'x-api-key': SECRET, 'anthropic-version': '2023-06-01' },
    body: { model: 'anthropic-model', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
  });
  expect(upstream.requests[1]!.headers.authorization).toBeUndefined();

  // A platform that cannot list models still gets asked - the flag in the
  // directory is advice, not a gate.
  upstream.answerWith(200, { list: { data: [{ id: 'first' }] } });
  upstream.requests.length = 0;
  const preset = await probe({ provider: { id: 'opencode-go', baseUrl: upstream.baseUrl, credentialRef: 'GRAPH_LOCAL_KEY', modelsListSupported: false } });
  expect(preset.body.verification.ok).toBe(true);
  expect(upstream.requests.map(request => request.path)).toEqual(['/v1/models', '/v1/chat/completions']);
  expect(upstream.requests.every(request => request.headers['x-opencode-session'] === 'graph-console')).toBe(true);

  // A manual model id needs no list.
  upstream.requests.length = 0;
  const manual = await probe({ probeModels: false, modelId: 'manual' });
  expect(manual.body.verification.ok).toBe(true);
  expect(upstream.requests).toHaveLength(1);
  expect(upstream.requests[0]).toMatchObject({ path: '/v1/chat/completions', body: { model: 'manual' } });
}, 120_000);

test('a vendor that refuses keeps its own wording, and a missing credential never reaches it', async () => {
  const upstream = await vendor();
  cleanup.push(() => upstream.close());
  const api = await daemonWith((project, baseUrl) => ({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{
      id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local',
    }] },
  }), { GRAPH_LOCAL_KEY: SECRET });

  const provider = { id: 'custom', label: 'Gateway', baseUrl: upstream.baseUrl, api: 'openai-completions', credentialRef: 'GRAPH_LOCAL_KEY' };
  let serial = 0;
  const probe = async (overrides: Record<string, unknown> = {}) => {
    const response = await api.request('/api/providers/probe', {
      method: 'POST', body: JSON.stringify({ requestId: `probe-${serial++}`, provider, ...overrides }),
    });
    return { status: response.status, body: response.body as {
      credentialConfigured: boolean;
      modelsError?: string;
      verification: { ok: boolean; status?: number; error?: string };
    } };
  };

  // A refusal keeps the vendor's own words.
  for (const [code, payload, message] of [
    [403, { error: { message: 'subscription does not allow listing' } }, 'subscription does not allow listing'],
    [429, { error: { message: 'Rate limit reached' } }, 'Rate limit reached'],
    [503, {}, 'HTTP 503'],
  ] as const) {
    upstream.answerWith(code, { refusal: payload });
    const refused = await probe({ modelId: 'manual' });
    expect(refused.body.modelsError).toBe(message);
    expect(refused.body.verification).toMatchObject({ ok: false, status: code, error: message });
  }

  // A body that is not the vendor's JSON keeps its own text too.
  for (const [code, wire, message] of [
    [500, 'upstream unavailable', 'upstream unavailable'],
    [429, JSON.stringify('quota exceeded'), 'quota exceeded'],
    [400, JSON.stringify({ message: 'invalid model' }), 'invalid model'],
  ] as const) {
    upstream.answerWith(code, { raw: wire });
    const raw = await probe({ modelId: 'manual' });
    expect(raw.body.modelsError).toBe(message);
    expect(raw.body.verification).toMatchObject({ ok: false, status: code, error: message });
  }

  // A credential that cannot be resolved is named, and nothing is sent.
  upstream.answerWith(200, { list: { data: [{ id: 'first' }] } });
  upstream.requests.length = 0;
  const missing = await probe({ provider: { ...provider, credentialRef: 'GRAPH_MISSING_KEY' }, modelId: 'manual' });
  expect(missing.body.credentialConfigured).toBe(false);
  expect(missing.body.verification.ok).toBe(false);
  expect(missing.body.verification.error).toContain('GRAPH_MISSING_KEY');
  expect(upstream.requests).toHaveLength(1);
  expect(upstream.requests[0]!.headers.authorization).toBeUndefined();

  // An endpoint that is not there is a failed verification, not a crash.
  const closed = createServer();
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', () => resolve()));
  const deadPort = (closed.address() as AddressInfo).port;
  await new Promise<void>(resolve => closed.close(() => resolve()));
  const unreachable = await probe({
    provider: { ...provider, baseUrl: `http://127.0.0.1:${deadPort}/v1` }, probeModels: false, modelId: 'manual',
  });
  expect(unreachable.body.verification).toMatchObject({ ok: false, status: 0 });
  expect(unreachable.body.verification.error).toMatch(/connect|refused|transport|dial/i);
}, 120_000);

test('a malformed provider draft is refused by field, and nothing is sent', async () => {
  const upstream = await vendor();
  cleanup.push(() => upstream.close());
  const api = await daemonWith((project, baseUrl) => ({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{
      id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local',
    }] },
  }), { GRAPH_LOCAL_KEY: SECRET });

  const provider = { id: 'custom', label: 'Gateway', baseUrl: upstream.baseUrl, api: 'openai-completions', credentialRef: 'GRAPH_LOCAL_KEY' };
  let serial = 0;
  const probe = async (overrides: Record<string, unknown> = {}) => {
    const response = await api.request('/api/providers/probe', {
      method: 'POST', body: JSON.stringify({ requestId: `probe-${serial++}`, provider, ...overrides }),
    });
    return { status: response.status, body: response.body as { code?: string; message?: string } };
  };

  for (const [invalid, fields] of [
    [{ requestId: undefined }, ['requestId']],
    [{ requestId: '   ' }, ['requestId']],
    [{ provider: { id: 'custom' } }, ['baseUrl', 'api', 'label']],
    [{ provider: { ...provider, baseUrl: 'ftp://invalid' } }, ['baseUrl']],
    [{ provider: { ...provider, api: 'responses' } }, ['api']],
    [{ provider: { ...provider, label: undefined, name: 'wrong-field' } }, ['label']],
    [{ provider: { ...provider, credentialRef: 'not a ref' } }, ['credentialRef']],
    [{ provider: { ...provider, id: 'not-a-platform' } }, ['id']],
  ] as const) {
    const rejected = await probe(invalid as Record<string, unknown>);
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(400);
    expect(rejected.body.code).toBe('invalid_input');
    for (const field of fields) expect(rejected.body.message).toContain(`${field}:`);
  }
  // Not one of those refusals reached the vendor.
  expect(upstream.requests).toHaveLength(0);

  // A flat body is the same draft without the wrapper.
  const flat = await api.request('/api/providers/probe', {
    method: 'POST', body: JSON.stringify({ ...provider, requestId: 'flat', modelId: 'manual', probeModels: false }),
  });
  expect(flat.status).toBe(200);
  expect((flat.body as { provider: { label: string; credentialRef: string } }).provider).toMatchObject({
    label: 'Gateway', credentialRef: 'GRAPH_LOCAL_KEY',
  });

  // A draft that names no credential gets the default one, and it is not there.
  const defaulted = await probe({ provider: { ...provider, credentialRef: undefined } });
  expect(defaulted.status).toBe(200);
  expect((defaulted.body as { provider: { credentialRef: string }; credentialConfigured: boolean }).provider.credentialRef).toBe('GRAPH_PROVIDER_API_KEY');
  expect((defaulted.body as { credentialConfigured: boolean }).credentialConfigured).toBe(false);
}, 120_000);
