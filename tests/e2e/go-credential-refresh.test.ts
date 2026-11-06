import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterEach, expect, test } from 'vitest';
import { launchBrowser } from '../helpers/host-browser.ts';
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
async function xaiVendor(options: { acceptRefresh: string | string[] | null; issueAccess: string; rotateTo?: string }) {
  const accepted = options.acceptRefresh === null ? [] : Array.isArray(options.acceptRefresh) ? options.acceptRefresh : [options.acceptRefresh];
  const log: VendorLog = { refreshes: [], bearers: [] };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if ((request.url ?? '').startsWith('/.well-known/openid-configuration')) {
      return reply(200, {
        issuer: 'https://auth.x.ai',
        device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
        token_endpoint: 'https://auth.x.ai/oauth2/token',
      });
    }
    if ((request.url ?? '').startsWith('/oauth2/device/code')) {
      return reply(200, {
        device_code: 'device-1', user_code: 'TEST-CODE',
        verification_uri: 'https://auth.x.ai/oauth2/device',
        verification_uri_complete: 'https://auth.x.ai/oauth2/device?user_code=TEST-CODE',
        expires_in: 600, interval: 2,
      });
    }
    if ((request.url ?? '').startsWith('/oauth2/token')) {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        // A device-code login this stub approves at once: the desktop keeper is the
        // one that drives the whole flow, this stub only has to answer it.
        return reply(200, { access_token: options.issueAccess, refresh_token: 'login-refresh', expires_in: 3600 });
      }
      if (form.get('grant_type') !== 'refresh_token') return reply(400, { error: 'unsupported_grant_type' });
      const presented = form.get('refresh_token');
      log.refreshes.push({ refreshToken: presented });
      if (!presented || !accepted.includes(presented)) {
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

async function launchGraph(vendor: { origin: string }, refreshBundle: unknown, options: { web?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-credential-refresh-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  if (options.web) {
    await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: join(root, 'web'), emptyOutDir: true } });
  } else {
    await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  }
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
  return { root, daemon, proxyEnv: proxy.env };
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

test('a turn whose credential was rejected is renewed and answers on the retry', async () => {
  const vendor = await xaiVendor({ acceptRefresh: 'refresh-old', issueAccess: 'access-new', rotateTo: 'refresh-rotated' });
  cleanup.push(() => vendor.close());
  const { daemon } = await launchGraph(vendor, {
    refreshToken: 'refresh-old', tokenEndpoint: 'https://auth.x.ai/oauth2/token', accessExpiresAt: '2026-01-01T00:00:00Z',
  });

  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'grok', title: 'Credential turn', text: 'Do the work.', requestId: 'credential-turn' }),
  });
  const createdText = await created.text();
  expect(created.status, createdText).toBe(200);
  const { conversationId, taskId } = JSON.parse(createdText) as { conversationId: string; taskId: string };

  // The turn really was refused with the stale token, then answered with the renewed
  // one: the person gets an answer instead of a 401.
  let seen = '';
  try {
    await expect.poll(async () => {
      seen = await (await daemon.request(`/api/conversations/${conversationId}`)).text();
      return seen.includes('Recovered answer.');
    }, { timeout: 60_000, interval: 250 }).toBe(true);
  } catch (error) {
    throw new Error(`${(error as Error).message}\nbearers: ${JSON.stringify(vendor.log.bearers)}\nrefreshes: ${JSON.stringify(vendor.log.refreshes)}\ndaemon: ${daemon.stderr.slice(-2500)}`);
  }
  expect(vendor.log.bearers[0]!.authorization).toBe('Bearer access-stale');
  expect(vendor.log.bearers.at(-1)!.authorization).toBe('Bearer access-new');
  const events = await (await daemon.request(`/api/tasks/${taskId}/events?after=0&limit=500`)).text();
  expect(events).toContain('node.credential_refreshed');
  // One renewal, not one per attempt: the rotated token is what the next request used.
  expect(vendor.log.refreshes.length).toBe(1);
}, 120_000);

test('the rotated refresh token is on disk before it is used, and survives a daemon restart', async () => {
  const vendor = await xaiVendor({ acceptRefresh: ['refresh-old', 'refresh-rotated'], issueAccess: 'access-new', rotateTo: 'refresh-rotated' });
  cleanup.push(() => vendor.close());
  const first = await launchGraph(vendor, {
    refreshToken: 'refresh-old', tokenEndpoint: 'https://auth.x.ai/oauth2/token', accessExpiresAt: '2026-01-01T00:00:00Z',
  });
  // One rejected request rotates the token, and the daemon writes its own copy first.
  // The vendor here refuses everything but the rotated value, so the file is the only
  // place that token can come from.
  const rotatedProbe = await probe(first.daemon, 'write-ahead-first');
  expect(rotatedProbe.verification.ok).toBe(true);
  expect(vendor.log.refreshes.map(entry => entry.refreshToken)).toEqual(['refresh-old']);
  const bundlePath = join(first.root, 'state', 'xai-refresh-GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN_REFRESH.json');
  await expect.poll(async () => (await readFile(bundlePath, 'utf8').catch(() => '')).length, { timeout: 10_000 }).toBeGreaterThan(0);
  const written = JSON.parse(await readFile(bundlePath, 'utf8')) as { refreshToken: string };
  expect(written.refreshToken).toBe('refresh-rotated');
  await first.daemon.close();

  // The app store still holds the old token and the daemon is restarted. Its startup
  // refresh must present the rotated one, which only its own copy knows.
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as { accessExpiresAt: string };
  await writeFile(bundlePath, JSON.stringify({ ...bundle, accessExpiresAt: '2026-01-01T00:00:00Z' }));
  const before = vendor.log.refreshes.length;
  const again = await launchCli(first.root, {
    configPath: join(first.root, 'graph.config.json'), extraArgs: ['--execute'],
    // The app store has lost the bundle entirely: only the daemon's own copy holds
    // the rotated token, which is exactly the state a crash between the two writes
    // leaves behind.
    env: { ...first.proxyEnv, GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN: 'access-stale' },
  });
  cleanup.push(() => again.close());
  // The restarted daemon is asked to use the credential; the token it presents comes
  // from its own copy, not from the app store that still holds the old one.
  await probe(again, 'write-ahead-restart');
  await expect.poll(() => vendor.log.refreshes.length, { timeout: 20_000 }).toBeGreaterThan(before);
  const presented = vendor.log.refreshes.slice(before).map(entry => entry.refreshToken);
  expect(presented).toContain('refresh-rotated');
  expect(presented).not.toContain('refresh-old');
}, 120_000);

test('a dead credential reaches the person: the settings card says so and the question asks', async () => {
  const vendor = await xaiVendor({ acceptRefresh: null, issueAccess: 'access-new' });
  cleanup.push(() => vendor.close());
  const { root, daemon } = await launchGraph(vendor, {
    refreshToken: 'refresh-revoked', tokenEndpoint: 'https://auth.x.ai/oauth2/token', accessExpiresAt: '2026-01-01T00:00:00Z',
  }, { web: true });
  const global = await daemon.request('/api/orchestration/global', {
    method: 'POST', body: JSON.stringify({ requestId: 'credential-thread-ui' }),
  });
  const globalText = await global.text();
  expect(global.status, globalText).toBe(200);
  const conversationId = (JSON.parse(globalText) as { conversationId: string; id?: string }).conversationId
    ?? (JSON.parse(globalText) as { id: string }).id;
  expect((await probe(daemon, 'credential-ui')).verification.ok).toBe(false);
  expect(root.length).toBeGreaterThan(0);

  const { browser } = await launchBrowser();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await page.goto(daemon.url);
  // The models page is reached the way a person reaches it.
  await page.getByRole('link', { name: '模型', exact: true }).click();
  const relogin = page.getByTestId('credential-relogin-grok');
  try {
    await relogin.waitFor({ timeout: 20_000 });
  } catch (error) {
    const text = await page.locator('body').innerText().catch(() => '<none>');
    const providers = await (await daemon.request('/api/providers')).text();
    throw new Error(`${(error as Error).message}\nurl=${page.url()}\nbody=${text.slice(0, 400)}\nerrors=${errors.slice(0, 6).join(' | ')}\nproviders=${providers.slice(0, 300)}`);
  }
  expect(await relogin.innerText()).toContain('需要重新登录');
  expect(await page.getByTestId('credential-note-grok').innerText()).toContain('重新登录');
  await page.screenshot({ path: join(root, 'test-evidence/credential-relogin.png') });

  // And the question itself is readable: it says what to do, not just that something failed.
  await page.goto(`${daemon.url}/#/conversations/${conversationId}`);
  await page.getByTestId('conversation').waitFor();
  // The card is the question the daemon filed: it says what to do, not just that
  // something failed.
  const card = page.locator('.question-reply').first();
  await card.waitFor();
  await expect.poll(async () => await card.innerText(), { timeout: 15_000 }).toContain('重新登录');
  await page.screenshot({ path: join(root, 'test-evidence/credential-question.png') });
}, 120_000);
