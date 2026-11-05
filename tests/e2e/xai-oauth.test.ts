import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchShell } from '../helpers/desktop-shell.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

/**
 * The xAI login is the device-code flow: the host asks x.ai for a one-time code,
 * the user approves it in a browser, and the host polls the token endpoint. The
 * vendor here is a controlled x.ai (discovery, device, token and API) reached
 * through the daemon's real HTTPS proxy and CA settings, so the test proves the
 * whole console path without borrowing an account. `expires_in: 2` forces the
 * refresh leg to run immediately after login.
 */
test('xAI device-code login shows the real code, stores the token, refreshes it before expiry and disconnects', async () => {
  let pending = 2;
  const grants: string[] = [];
  const authorizations: string[] = [];
  // The vendor's answer is data, asserted in the test body where it can be
  // awaited. An assertion inside this handler runs detached from the test: it
  // reaches vitest as an unhandled rejection after the case already passed, and a
  // straggling refresh from a closing app then fails the whole gate. Measured
  // 2026-11-05: 'expected b5CHE7VK-… to be refresh-1' arrived this way.
  const refreshes: { clientId: string | null; refreshToken: string | null }[] = [];
  const vendor = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const reply = (value: unknown) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.url === '/.well-known/openid-configuration') return reply({
      issuer: 'https://auth.x.ai',
      device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
      token_endpoint: 'https://auth.x.ai/oauth2/token',
    });
    if (request.url === '/oauth2/device/code') return reply({
      device_code: 'device-1', user_code: 'TEST-CODE',
      verification_uri: 'https://auth.x.ai/oauth2/device',
      verification_uri_complete: 'https://auth.x.ai/oauth2/device?user_code=TEST-CODE',
      expires_in: 600, interval: 2,
    });
    if (request.url === '/oauth2/token') {
      const form = new URLSearchParams(body);
      const grant = form.get('grant_type') ?? '';
      grants.push(grant);
      if (grant === 'refresh_token') {
        refreshes.push({ clientId: form.get('client_id'), refreshToken: form.get('refresh_token') });
        return reply({ access_token: 'access-refreshed', refresh_token: 'refresh-2', expires_in: 3600 });
      }
      if (pending > 0) {
        pending -= 1;
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'authorization_pending', error_description: 'User has not yet authorized' }));
        return;
      }
      expect(form.get('device_code')).toBe('device-1');
      return reply({ access_token: 'access-initial', refresh_token: 'refresh-1', expires_in: 2 });
    }
    if (request.url === '/v1/models') {
      authorizations.push(request.headers.authorization ?? '');
      return reply({ data: [{ id: 'grok-4.5' }] });
    }
    if (request.url === '/v1/chat/completions') {
      authorizations.push(request.headers.authorization ?? '');
      return reply({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>(resolve => vendor.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { vendor.closeAllConnections(); await new Promise<void>(resolve => vendor.close(() => resolve())); });
  const fixture = await launchShell(cleanup, `http://127.0.0.1:${(vendor.address() as AddressInfo).port}`, ['auth.x.ai', 'api.x.ai']);
  const { page } = fixture;
  const first = await fixture.address();
  const probe = async () => (await page.request.post(`${first.url}/api/providers/probe`, {
    headers: { origin: first.url }, data: { requestId: 'xai-probe', id: 'grok' },
  })).json();

  // Start from a clean slate: this case is about the login it performs itself, so
  // whatever credential the app was already holding is disconnected first. Without
  // this the first refresh the vendor sees can belong to somebody else's account -
  // measured 2026-11-05, a real Grok CLI token reached this stub and the case died
  // with 'expected b5CHE7VK-... to be refresh-1'.
  const providers = await (await page.request.get(`${first.url}/api/providers`)).json();
  const grok = providers.platforms.find((platform: { id: string; credentialConfigured?: boolean; credentialRef?: string }) => platform.id === 'grok');
  if (grok?.credentialConfigured) {
    await page.request.post(`${first.url}/api/providers/disconnect`, {
      headers: { origin: first.url }, data: { credentialRef: grok.credentialRef ?? 'grok' },
    });
    await expect.poll(async () => (await (await page.request.get(`${first.url}/api/providers`)).json())
      .platforms.find((platform: { id: string }) => platform.id === 'grok')?.credentialConfigured, { timeout: 20000 }).toBe(false);
  }
  await page.goto(`${first.url}/#/setup`);
  await page.getByTestId('setup-provider-grok').click();
  const panel = page.getByTestId('provider-login');
  expect(await panel.getAttribute('data-provider')).toBe('xai');
  await page.getByTestId('provider-login-start').click();
  const status = page.getByTestId('provider-login-status');
  await expect.poll(() => status.innerText(), { timeout: 20000 }).toContain('在打开的 xAI 页面确认授权');
  expect(await page.getByTestId('provider-login-code').innerText()).toContain('TEST-CODE');
  expect(await page.getByTestId('provider-login-open').getAttribute('href')).toBe('https://auth.x.ai/oauth2/device?user_code=TEST-CODE');
  await page.screenshot({ path: '/tmp/graph-xai-login-code.png', fullPage: true });
  await expect.poll(() => status.innerText(), { timeout: 40000 }).toContain('已登录 xAI 账号');
  expect(grants.filter(grant => grant === 'urn:ietf:params:oauth:grant-type:device_code')).toHaveLength(3);
  const secretsPath = join(fixture.userData, 'secrets.json');
  const stored = await readFile(secretsPath, 'utf8');
  expect(stored).not.toContain('access-initial');
  expect(stored).not.toContain('refresh-1');
  await expect.poll(async () => (await (await page.request.get(`${first.url}/api/providers`)).json())
    .platforms.find((platform: { id: string }) => platform.id === 'grok')?.credentialConfigured, { timeout: 20000 }).toBe(true);
  // The two-second access token is already inside the refresh window, so the
  // daemon has to refresh it and hand the probe the new bearer token.
  await expect.poll(() => grants.filter(grant => grant === 'refresh_token').length, { timeout: 20000 }).toBeGreaterThan(0);
  // The first refresh is this login's own: the client it was authorised for and
  // the token the vendor handed out a moment ago - never somebody else's account.
  expect(refreshes[0]?.clientId).toBe('b1a00492-073a-47ea-816f-4c329264a828');
  expect(refreshes[0]?.refreshToken).toBe('refresh-1');
  await expect.poll(async () => { await probe(); return authorizations.at(-1) ?? ''; }, { timeout: 20000 }).toBe('Bearer access-refreshed');
  const probed = await probe();
  expect(probed.credentialConfigured).toBe(true);
  expect(probed.models.map((model: { id: string }) => model.id)).toContain('grok-4.5');
  await page.getByRole('button', { name: '断开此凭据', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`${first.url}/api/providers`)).json())
    .platforms.find((platform: { id: string }) => platform.id === 'grok')?.credentialConfigured, { timeout: 20000 }).toBe(false);
  // Live revocation precedes keychain persistence; wait for the desktop's ack
  // so the companion refresh entry is gone from the saved store too.
  await expect.poll(async () => (await (await page.request.get(`${first.url}/api/config`)).json()).pendingSecretRefs, { timeout: 20000 }).toEqual([]);
}, 150000);
