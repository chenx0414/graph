import { createServer } from 'node:http';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';

import { build } from 'vite';

import { chromium, type Page } from 'playwright';

import { launchCli } from '../helpers/cli-daemon.ts';
export const cleanup: (() => Promise<void> | void)[] = [];

export let webDir: string;


beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-m8-settings-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);


afterAll(() => rm(webDir, { recursive: true, force: true }));


afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([
      Promise.resolve(action()).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 5_000)),
    ]);
  }
  cleanup.length = 0;
});

export const SECRET = 'synth-settings-secret';

export async function openModelEditor(page: Page) {
  const toggle = page.getByTestId('model-editor-toggle');
  await toggle.waitFor();
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.getByTestId('provider-setup').waitFor();
}

export async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-settings-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function stubProvider() {
  const requests: { model?: string; authorization?: string; path?: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { model?: string } : {};
    requests.push({ ...(body.model ? { model: body.model } : {}), ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), ...(request.url ? { path: request.url } : {}) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'stub', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { requests, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

export async function modelListStubProvider(ids: string[]) {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    if ((request.url ?? '').includes('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: ids.map(id => ({ id, name: id.toUpperCase() })) }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'stub', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

export async function configFile(dir: string, baseUrl: string, extra: Record<string, unknown> = {}) {
  const path = join(dir, 'graph.config.json');
  await writeFile(path, JSON.stringify({
    version: 1,
    projects: [{ id: 'sample', root: dir }],
    models: { entries: [{ id: 'local', provider: 'stub', grade: 'medium', api: 'openai-completions', baseUrl, contextWindow: 2048, maxTokens: 128, credentialId: 'local' }] },
    credentials: { local: { secretRef: 'GRAPH_SYNTH_KEY' }, ...(extra.credentials ?? {}) },
    limits: { credentials: { local: 1 } },
  }, null, 2));
  return path;
}

export async function start(dir: string, path: string) {
  // The console under test declares one local credential. Ambient subscription
  // logins from the host would add platforms to the vendor picker and make the
  // case depend on the machine, so they are cleared.
  const daemon = await launchCli(dir, { configPath: path, stateDir: join(dir, 'state'), webDir, env: {
    HOME: dir, GRAPH_SYNTH_KEY: SECRET,
    GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY: '', GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN: '',
    GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN: '', GRAPH_SUBSCRIPTION_COMMAND_GOAT_API_KEY: '',
    GRAPH_SUBSCRIPTION_DEEPSEEK_API_KEY: '',
  } });
  cleanup.push(() => daemon.close());
  return daemon;
}

export async function session(url: string) {
  const home = await fetch(url, { headers: { origin: url } });
  const cookie = home.headers.get('set-cookie') ?? '';
  const headers = { origin: url, cookie, 'content-type': 'application/json' };
  return {
    get: (path: string) => fetch(`${url}${path}`, { headers }),
    post: (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  };
}
