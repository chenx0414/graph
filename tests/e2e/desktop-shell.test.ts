import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { openaiServer } from '../fixtures/openai-server.ts';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { _electron } from 'playwright';
import { build } from 'vite';
import { vendorProxy } from '../helpers/vendor-proxy.ts';
import { ensureBackendBinary } from '../helpers/backend-binary.ts';

const electronExecutable: string = createRequire(import.meta.url)('electron');
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function shell(vendorOrigin?: string) {
  const tooling = join(process.cwd(), '.tooling');
  await mkdir(tooling, { recursive: true });
  const root = await mkdtemp(join(tooling, 'desktop-e2e-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const userData = join(root, 'user-data');
  await mkdir(source);
  await mkdir(join(root, '.graph'));
  for (const directory of ['src', 'presets', 'docs']) await cp(join(process.cwd(), directory), join(source, directory), { recursive: true });
  await cp(join(process.cwd(), 'package.json'), join(source, 'package.json'));
  await mkdir(join(source, 'dist'));
  await cp(ensureBackendBinary(), join(source, 'dist/graphd'));
  const proxy = vendorOrigin ? await vendorProxy(root, ['openrouter.ai'], vendorOrigin) : undefined;
  if (proxy) cleanup.push(() => proxy.close());

  await writeFile(join(root, '.graph/app-root'), `${source}\n`);
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: join(source, 'dist/web'), emptyOutDir: true } });
  const app = await _electron.launch({
    executablePath: electronExecutable,
    timeout: 15000,
    // Chromium's test keychain prevents an OS password dialog in an isolated
    // HOME. These cases cover windows/processes, not keychain encryption.
    args: ['--use-mock-keychain', join(process.cwd(), 'desktop/main.mjs')],
    env: { ...process.env, ...proxy?.env, HOME: root, GRAPH_APP_USER_DATA: userData, GRAPH_RSI_ROOT: join(root, 'stale'), GRAPH_APP_DEBUG: '1', GRAPH_APP_SMOKE: '', GRAPH_APP_BACKGROUND: process.env.GRAPH_E2E_VISIBLE_WINDOWS === '1' ? '' : '1', ELECTRON_RUN_AS_NODE: '' },
  });
  cleanup.push(() => app.close());
  let daemonLog = '';
  app.process().stdout?.on('data', (chunk: Buffer) => { daemonLog += chunk.toString(); });
  app.process().stderr?.on('data', (chunk: Buffer) => { daemonLog += chunk.toString(); });
  let page;
  try { page = await app.firstWindow({ timeout: 60000 }); }
  catch (error) {
    await writeFile('/tmp/graph-desktop-e2e-startup.log', `No window after launch\n${daemonLog}`);
    throw error;
  }
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => window.graph?.isDesktop === true);
  try {
    await expect.poll(() => readFile(join(userData, 'state/console.json'), 'utf8').then(() => true, () => false), { timeout: 10000 }).toBe(true);
  } catch (error) {
    await writeFile('/tmp/graph-desktop-e2e-startup.log', daemonLog);
    throw error;
  }
  const address = async () => JSON.parse(await readFile(join(userData, 'state/console.json'), 'utf8')) as { url: string; pid: number };
  return { root, source, userData, app, page, address };
}

test('the real desktop drawer reserves display space, restores content bounds and uses an overlay when constrained', async () => {
  const { app, page } = await shell();
  const display = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    const base = { x: area.x + area.width - 500, y: area.y + 20, width: 500, height: Math.min(600, area.height - 40) };
    window.setBounds(base, false);
    return { area, base };
  });
  const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
  await expect.poll(bounds).toEqual(display.base);
  expect(await page.evaluate(() => window.graph!.setDrawer!({ open: true, width: 440 }))).toEqual({ expanded: true });
  await expect.poll(bounds).toEqual({ ...display.base, x: display.area.x + display.area.width - 940, width: 940 });
  expect(await page.evaluate(() => window.graph!.setDrawer!({ open: false, width: 440 }))).toEqual({ expanded: false });
  await expect.poll(bounds).toEqual(display.base);
  const full = { ...display.base, x: display.area.x, width: display.area.width - 100 };
  await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]!.setBounds(value, false), full);
  await expect.poll(bounds).toEqual(full);
  expect(await page.evaluate(() => window.graph!.setDrawer!({ open: true, width: 440 }))).toEqual({ expanded: false });
  expect(await bounds()).toEqual(full);
  if (process.env.GRAPH_E2E_VISIBLE_WINDOWS !== '1') {
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocused()))).toBe(true);
    expect(await app.evaluate(({ app }) => app.dock?.isVisible() ?? false)).toBe(false);
    expect((await page.screenshot()).length).toBeGreaterThan(0);
  }
}, 90000);

test.skipIf(process.env.GRAPH_E2E_VISIBLE_WINDOWS !== '1')('a maximized native desktop uses a drawer overlay without changing its bounds', async () => {
  const { app, page } = await shell();
  const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())).toBe(true);
  const maximized = await bounds();
  expect(await page.evaluate(() => window.graph!.setDrawer!({ open: true, width: 440 }))).toEqual({ expanded: false });
  expect(await bounds()).toEqual(maximized);
}, 90000);

test('desktop relaunch stops only its owned daemon and the replacement survives the old stop deadline', async () => {
  const fixture = await shell();
  const config = JSON.parse(await readFile(join(fixture.userData, 'graph.config.json'), 'utf8'));
  expect(config).toEqual({ version: 1, projects: [] });
  const first = await fixture.address();
  expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const startup = await fixture.page.evaluate(async () => (await fetch('/api/startup')).json());
  expect(startup.source.root).toBe(fixture.source);
  // SIGSTOP makes this fixture-owned child unable to handle SIGTERM. The real
  // desktop must reach its force-kill path without affecting any other daemon.
  process.kill(first.pid, 'SIGSTOP');
  const restarted = await fixture.page.evaluate(() => window.graph!.relaunch());
  await expect.poll(async () => (await fixture.address()).pid).not.toBe(first.pid);
  const second = await fixture.address();
  expect(second.pid).not.toBe(first.pid);
  expect(restarted.url).toBe(second.url);
  expect(() => process.kill(first.pid, 0)).toThrow();
  await fixture.page.goto(restarted.url);
  await expect.poll(async () => (await fetch(`${second.url}/api/health`)).status).toBe(200);
  const normal = await fixture.page.evaluate(() => window.graph!.relaunch());
  await expect.poll(async () => (await fixture.address()).pid).not.toBe(second.pid);
  const third = await fixture.address();
  expect(third.pid).not.toBe(second.pid);
  expect(normal.url).toBe(third.url);
  expect(() => process.kill(second.pid, 0)).toThrow();
  // A real clock is essential here: fake timers cannot prove a replacement
  // process survives the abandoned stop timer in the desktop process.
  await new Promise(resolve => setTimeout(resolve, 6000));
  expect((await fetch(`${third.url}/api/health`)).status).toBe(200);
  expect(() => process.kill(third.pid, 0)).not.toThrow();
}, 90000);


test('OpenRouter browser authorization persists through the real desktop keychain, calls a model after restart and disconnects', async () => {
  const model = await openaiServer([{ text: 'Authorized model reply' }]);
  cleanup.push(() => model.close());
  const secret = 'synthetic-openrouter-oauth-key';
  let challenge = '';
  let exchanges = 0;
  let release: (() => void) | undefined;
  const received: string[] = [];
  const vendor = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (request.url === '/api/v1/auth/keys') {
      exchanges += 1;
      if (body.code !== 'approved' || body.code_challenge_method !== 'S256'
        || createHash('sha256').update(body.code_verifier).digest('base64url') !== challenge) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid PKCE proof' }));
        return;
      }
      await new Promise<void>(resolve => { release = resolve; });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ key: secret }));
      return;
    }
    received.push(request.headers.authorization ?? '');
    if (body.stream) {
      const upstream = await fetch(`${model.model.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: request.headers.authorization ?? '' }, body: JSON.stringify(body) });
      response.writeHead(upstream.status, { 'content-type': 'text/event-stream' });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.url?.endsWith('/models') ? { data: [{ id: 'openrouter/auto' }] } : { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }
  });
  await new Promise<void>(resolve => vendor.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { release?.(); vendor.closeAllConnections(); await new Promise<void>(resolve => vendor.close(() => resolve())); });
  const fixture = await shell(`http://127.0.0.1:${(vendor.address() as AddressInfo).port}`);
  const { page } = fixture;
  const first = await fixture.address();
  await page.goto(`${first.url}/#/setup`);
  await page.getByTestId('setup-provider-openrouter').click();
  await page.screenshot({ path: '/tmp/graph-magpie-providers-desktop.png', fullPage: true });
  expect((await fetch(`${first.url}/api/providers/login/missing`)).status).toBe(401);
  expect((await page.request.post(`${first.url}/api/providers/login`, { headers: { origin: 'https://outside.example' }, data: { providerId: 'openrouter', credentialRef: 'OPENROUTER_API_KEY' } })).status()).toBe(403);
  const status = page.getByTestId('provider-login-status');
  const start = async () => {
    await page.getByRole('button', { name: '授权登录 OpenRouter', exact: true }).click();
    const link = page.getByTestId('provider-login-open');
    await link.waitFor();
    const url = new URL((await link.getAttribute('href'))!);
    expect(url.origin).toBe('https://openrouter.ai');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    challenge = url.searchParams.get('code_challenge')!;
    return new URL(url.searchParams.get('callback_url')!);
  };
  const cancelled = await start();
  const duplicate = await page.request.post(`${first.url}/api/providers/login`, { headers: { origin: first.url }, data: { providerId: 'openrouter', credentialRef: 'OPENROUTER_API_KEY' } });
  expect(new URL((await duplicate.json()).url).searchParams.get('callback_url')).toBe(cancelled.href);
  await page.getByRole('button', { name: '取消登录', exact: true }).click();
  await expect.poll(() => status.innerText(), { timeout: 10000 }).toContain('已取消');
  await expect(fetch(`${cancelled}?code=approved`)).rejects.toThrow();
  expect(exchanges).toBe(0);
  const denied = await start();
  expect((await fetch(`${denied}?error=access_denied`)).status).toBe(400);
  await expect.poll(() => status.innerText(), { timeout: 10000 }).toContain('授权未完成');
  expect(exchanges).toBe(0);
  const callback = await start();
  const wrong = new URL('/oauth/callback/unrelated', callback);
  expect((await fetch(`${wrong}?code=approved`)).status).toBe(404);
  expect(exchanges).toBe(0);
  const completion = fetch(`${callback}?code=approved`);
  await expect.poll(() => exchanges).toBe(1);
  expect((await fetch(`${callback}?code=approved`)).status).toBe(409);
  release!();
  expect((await completion).status).toBe(200);
  await expect.poll(() => status.innerText(), { timeout: 20000 }).toContain('已授权并安全保存');
  const secretsPath = join(fixture.userData, 'secrets.json');
  expect(await readFile(secretsPath, 'utf8')).not.toContain(secret);
  await page.getByTestId('setup-save').click();
  await expect.poll(async () => JSON.parse(await readFile(join(fixture.userData, 'graph.config.json'), 'utf8')).credentials?.openrouter?.secretRef).toBe('OPENROUTER_API_KEY');
  const restarted = await page.evaluate(() => window.graph!.relaunch());
  await page.goto(`${restarted.url}/#/models`);
  // The restart deliberately reuses its port. Hash navigation alone does not
  // run GET / to replace the old daemon session cookie.
  await page.reload();
  await page.getByTestId('configured-provider-openrouter').waitFor();
  await expect.poll(() => page.getByTestId('configured-provider-openrouter').innerText()).toContain('凭据就绪');
  const tested = await page.request.post(`${restarted.url}/api/config/test`, { headers: { origin: restarted.url }, data: { modelId: 'openrouter/auto' } });
  expect(await tested.json()).toMatchObject({ ok: true });
  const created = await page.request.post(`${restarted.url}/api/conversations`, { headers: { origin: restarted.url }, data: { text: 'Check authorized model', model: 'openrouter/auto', requestId: 'oauth-model-call' } });
  const conversation = await created.json();
  expect(created.status()).toBe(200);
  await expect.poll(() => model.requests.length, { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await (await page.request.get(`${restarted.url}/api/tasks/${conversation.taskId}`)).json()).invocations.some((call: { usage?: { input: number } }) => (call.usage?.input ?? 0) > 0), { timeout: 20000 }).toBe(true);
  expect(received.length).toBeGreaterThan(0);
  expect(received.every(auth => auth === `Bearer ${secret}`)).toBe(true);
  const configView = await (await page.request.get(`${restarted.url}/api/config`)).json();
  expect(JSON.stringify(configView)).not.toContain(secret);
  expect(await readFile(join(fixture.userData, 'graph.config.json'), 'utf8')).not.toContain(secret);
  await page.getByTestId('configured-provider-edit-openrouter').click();
  await page.getByRole('button', { name: '断开此凭据', exact: true }).click();
  await expect.poll(() => page.getByTestId('configured-provider-openrouter').innerText()).toContain('凭据缺失');
  // Live revocation precedes keychain persistence. The desktop polls that queue
  // every 1.5s, so wait for its exact acknowledgement across a full poll cycle.
  await expect.poll(async () => (await (await page.request.get(`${restarted.url}/api/config`)).json()).pendingSecretRefs, { timeout: 20_000 }).toEqual([]);
  const again = await page.evaluate(() => window.graph!.relaunch());
  await page.goto(`${again.url}/#/models`);
  await page.reload();
  await expect.poll(() => page.getByTestId('configured-provider-openrouter').innerText()).toContain('凭据缺失');
  const before = received.length;
  const refused = await page.request.post(`${again.url}/api/config/test`, { headers: { origin: again.url }, data: { modelId: 'openrouter/auto' } });
  expect(await refused.json()).toMatchObject({ ok: false });
  expect(received).toHaveLength(before);
}, 120000);
