import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { vendorProxy } from '../helpers/vendor-proxy.ts';

// A subscription credential that the vendor rejects used to stay rejected: the only
// refresh was a timer, so a token revoked before its hour was up left every review
// answering 401 until a person logged in again. This keeper drives the two real paths
// through a controlled x.ai: a probe that is rejected and renewed behind one request,
// and a refresh the vendor refuses, which has to be loud (the credential is named as
// needing a login and the person is asked once) instead of a silent 401.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

interface VendorLog {
  refreshes: { refreshToken: string | null }[];
  bearers: { path: string; authorization: string }[];
}

/** A controlled x.ai: one working refresh token, one that the vendor has revoked. */
async function xaiVendor(options: { acceptRefresh: string | null; issueAccess: string; rotateTo?: string }) {
  const log: VendorLog = { refreshes: [], bearers: [] };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if ((request.url ?? '').startsWith('/oauth2/token')) {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') !== 'refresh_token') return reply(400, { error: 'unsupported_grant_type' });
      const presented = form.get('refresh_token');
      log.refreshes.push({ refreshToken: presented });
      if (!options.acceptRefresh || presented !== options.acceptRefresh) {
        // The wording a revoked refresh token really comes back with.
        return reply(400, { error: 'invalid_grant', error_description: 'Refresh token has been revoked' });
      }
      return reply(200, {
        access_token: options.issueAccess, refresh_token: options.rotateTo ?? presented, expires_in: 3600,
      });
    }
    if ((request.url ?? '').startsWith('/v1/chat/completions')) {
      const authorization = request.headers.authorization ?? '';
      log.bearers.push({ path: request.url ?? '', authorization });
      if (authorization !== `Bearer ${options.issueAccess}`) {
        return reply(401, { error: { message: 'The OAuth2 access token could not be validated.', type: 'invalid_request_error' } });
      }
      // A turn streams, the probe's verification does not: one stub answers both.
      if (body.includes('"stream":true') || body.includes('"stream": true')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ id: 'turn', object: 'chat.completion.chunk', created: 1, model: 'grok',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Recovered answer.' }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: 'turn', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 20 } } })}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }
      return reply(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    }
    if ((request.url ?? '').startsWith('/v1/models')) {
      const authorization = request.headers.authorization ?? '';
      log.bearers.push({ path: request.url ?? '', authorization });
      if (authorization !== `Bearer ${options.issueAccess}`) {
        // The exact answer xAI gives for an access token it no longer accepts.
        return reply(401, { error: { message: 'The OAuth2 access token could not be validated.', type: 'invalid_request_error' } });
      }
      return reply(200, { data: [{ id: 'grok-4.5' }] });
    }
    return reply(404, { error: 'not found' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, log, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function launchGraph(vendor: { origin: string }, refreshBundle: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'graph-credential-refresh-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const proxy = await vendorProxy(root, ['auth.x.ai', 'api.x.ai'], vendor.origin);
  cleanup.push(() => proxy.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { grokLocal: { secretRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN' } },
    models: { entries: [{ id: 'grok', provider: 'grok', grade: 'high', api: 'openai-completions',
      baseUrl: 'https://api.x.ai/v1', contextWindow: 32_000, maxTokens: 256, credentialId: 'grokLocal' }] },
  }));
  const daemon = await launchCli(root, {
    configPath, extraArgs: ['--execute'],
    env: {
      ...proxy.env,
      GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN: 'access-stale',
      GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN_REFRESH: JSON.stringify(refreshBundle),
    },
  });
  cleanup.push(() => daemon.close());
  return { root, daemon };
}

async function probe(daemon: { request: (path: string, init?: RequestInit) => Promise<Response> }, requestId: string) {
  return await (await daemon.request('/api/providers/probe', {
    method: 'POST', body: JSON.stringify({ requestId, id: 'grok' }),
  })).json() as {
    credentialConfigured: boolean;
    models: { id: string }[];
    modelsError?: string;
    verification: { ok: boolean; error?: string };
  };
}

test('a rejected access token is renewed once and the same probe is answered', async () => {
  const vendor = await xaiVendor({ acceptRefresh: 'refresh-old', issueAccess: 'access-new', rotateTo: 'refresh-rotated' });
  cleanup.push(() => vendor.close());
  const { daemon } = await launchGraph(vendor, {
    refreshToken: 'refresh-old', tokenEndpoint: 'https://auth.x.ai/oauth2/token', accessExpiresAt: '2026-01-01T00:00:00Z',
  });

  const first = await probe(daemon, 'refresh-once');
  expect(first.credentialConfigured).toBe(true);
  expect(first.models.map(model => model.id)).toContain('grok-4.5');
  expect(first.verification.ok).toBe(true);
  // The first attempt really was rejected with the stale token, and the second one
  // carried the renewed one: the retry is part of the answer, not a second request.
  expect(vendor.log.bearers.length).toBeGreaterThanOrEqual(2);
  expect(vendor.log.bearers[0]!.authorization).toBe('Bearer access-stale');
  expect(vendor.log.bearers.at(-1)!.authorization).toBe('Bearer access-new');
  expect(vendor.log.refreshes).toEqual([{ refreshToken: 'refresh-old' }]);

  // The renewed token was stored, not only used once: a second probe refreshes
  // nothing and still works.
  const second = await probe(daemon, 'refresh-once-again');
  expect(second.verification.ok).toBe(true);
  expect(vendor.log.refreshes).toHaveLength(1);
});

test('a refresh the vendor refuses is loud: the credential needs a login and the person is asked once', async () => {
  const vendor = await xaiVendor({ acceptRefresh: null, issueAccess: 'access-new' });
  cleanup.push(() => vendor.close());
  const { daemon } = await launchGraph(vendor, {
    refreshToken: 'refresh-revoked', tokenEndpoint: 'https://auth.x.ai/oauth2/token', accessExpiresAt: '2026-01-01T00:00:00Z',
  });
  // The person's own thread is the global supervisor: a credential problem is filed
  // there, because that is the one conversation they always have.
  const global = await daemon.request('/api/orchestration/global', {
    method: 'POST', body: JSON.stringify({ requestId: 'credential-thread' }),
  });
  const globalText = await global.text();
  expect(global.status, globalText).toBe(200);
  const conversationId = (JSON.parse(globalText) as { conversationId: string; id?: string }).conversationId
    ?? (JSON.parse(globalText) as { id: string }).id;

  const first = await probe(daemon, 'refresh-refused');
  expect(first.verification.ok).toBe(false);
  expect(vendor.log.refreshes).toHaveLength(1);

  // The credential is named as needing a login, with the vendor's reason.
  const credentials = (await (await daemon.request('/api/providers')).json()) as
    { credentials: Record<string, { secretRef: string; needsRelogin?: boolean; credentialNote?: string }> };
  const grok = Object.values(credentials.credentials).find(credential => credential.secretRef === 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN');
  expect(grok?.needsRelogin).toBe(true);
  expect(grok?.credentialNote ?? '').toContain('重新登录');

  // And the person is asked once, in their own conversation, not on every request.
  const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as
    { questions: { kind: string; owner: string; status: string; data?: { ask?: string } }[] };
  const asked = view.questions.filter(question => question.kind === 'credential');
  expect(asked).toHaveLength(1);
  expect(asked[0]!.owner).toBe('user');
  expect(asked[0]!.data?.ask ?? '').toContain('重新登录');

  await probe(daemon, 'refresh-refused-again');
  const after = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as
    { questions: { kind: string }[] };
  expect(after.questions.filter(question => question.kind === 'credential')).toHaveLength(1);
});
