import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * Which key a request carries.
 *
 * A credential belongs to the model that names it. Two models may point at
 * two endpoints, and each endpoint has to see its own key and never the other
 * one - a model that is switched must not carry the previous model's secret
 * to the next provider. A model whose credential cannot be resolved is
 * refused before anything leaves the process: a request that goes out without
 * a key, or with somebody else's key, is worse than no request at all.
 *
 * The proof is the real daemon and the two real endpoints: what they receive
 * is read off the wire.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface Endpoint {
  baseUrl: string;
  authorizations: string[];
  requests: number;
  close: () => Promise<void>;
}

async function endpoint(text: string): Promise<Endpoint> {
  const authorizations: string[] = [];
  let requests = 0;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests++;
    authorizations.push(request.headers.authorization ?? '');
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    authorizations,
    get requests() { return requests; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function fixture(models: unknown[], credentials: unknown, env: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-credentials-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Credentials project\n');
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials,
    models: { entries: models },
  }));
  const daemon = await launchCli(root, { configPath, env, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  return { root, daemon, request };
}

function model(id: string, provider: string, baseUrl: string, credentialId: string) {
  return {
    id, provider, grade: 'high', api: 'openai-completions', baseUrl,
    contextWindow: 32000, maxTokens: 256, credentialId,
  };
}

test('two endpoints receive their own credentials and a model switch cannot cross keys', async () => {
  const alpha = await endpoint('Alpha result');
  cleanup.push(() => alpha.close());
  const beta = await endpoint('Beta result');
  cleanup.push(() => beta.close());
  const f = await fixture(
    [model('alpha', 'graph-alpha', alpha.baseUrl, 'alpha'), model('beta', 'graph-beta', beta.baseUrl, 'beta')],
    { alpha: { secretRef: 'GRAPH_ALPHA_KEY' }, beta: { secretRef: 'GRAPH_BETA_KEY' } },
    { GRAPH_ALPHA_KEY: 'key-alpha', GRAPH_BETA_KEY: 'key-beta' },
  );

  for (const [modelId, text] of [['alpha', 'Alpha task'], ['beta', 'Beta task']] as const) {
    const created = await f.request('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p', model: modelId, text, requestId: `cred-${modelId}` }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;
    await expect.poll(async () => {
      const view = await f.request(`/api/conversations/${conversationId}`);
      return (view.body as { master?: { status?: string } }).master?.status;
    }, { timeout: 30_000, interval: 250 }).toBe('succeeded');
  }

  // Each endpoint saw its own key, and never the other one.
  expect(alpha.authorizations.length).toBeGreaterThan(0);
  expect(new Set(alpha.authorizations)).toEqual(new Set(['Bearer key-alpha']));
  expect(beta.authorizations.length).toBeGreaterThan(0);
  expect(new Set(beta.authorizations)).toEqual(new Set(['Bearer key-beta']));
}, 120_000);

test('a model whose credential was taken out of service never reaches the provider', async () => {
  const provider = await endpoint('never sent');
  cleanup.push(() => provider.close());
  const f = await fixture(
    [model('local', 'graph-alpha', provider.baseUrl, 'local')],
    { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    { GRAPH_LOCAL_KEY: 'key-local' },
  );

  // The key of the model is taken out of service: the credential is revoked,
  // so the model has no key to call it with any more.
  const token = (await readFile(join(f.root, 'state', 'app-token'), 'utf8')).trim();
  const revoked = await f.request('/api/app/secret', {
    method: 'POST',
    headers: { 'x-graph-app-token': token },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: null }),
  });
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

  const created = await f.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'No key', requestId: 'cred-missing' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;

  // Nothing is sent to the provider: the call is refused before the request,
  // not after it.
  await new Promise(resolve => setTimeout(resolve, 5_000));
  expect(provider.requests).toBe(0);

  // And the conversation does not pretend that anything was answered.
  const view = await f.request(`/api/conversations/${conversationId}`);
  const messages = (view.body as { messages?: { role: string; state: string; text: string }[] }).messages ?? [];
  expect(messages.filter(message => message.role === 'assistant')).toHaveLength(0);
  expect(messages.every(message => message.state !== 'delivered')).toBe(true);
}, 120_000);

test('a new task records the configuration revision that was in effect', async () => {
  const provider = await endpoint('Answered.');
  cleanup.push(() => provider.close());
  const f = await fixture(
    [model('local', 'graph-local', provider.baseUrl, 'local')],
    { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    { GRAPH_LOCAL_KEY: 'key-local' },
  );

  const config = await f.request('/api/config');
  expect(config.status).toBe(200);
  const revision = (config.body as { revision?: number }).revision;

  const begun = await f.request('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', request: 'Record revision', requestId: 'cred-revision' }),
  });
  expect(begun.status, JSON.stringify(begun.body)).toBe(200);
  const taskId = (begun.body as { taskId: string }).taskId;

  const events = await f.request(`/api/tasks/${taskId}/events?after=0&limit=50`);
  const created = (Array.isArray(events.body) ? events.body : [])
    .find((event: { type?: string }) => event.type === 'task.created');
  expect(created, JSON.stringify(events.body)).toBeTruthy();
  expect((created.data as { configRevision?: number }).configRevision).toBe(revision);
}, 120_000);
