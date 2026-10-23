import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { openaiServer, type ResponsePlan } from './openai-server.ts';

let webDir: string;
export const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-composer-lifecycle-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
afterAll(async () => { await rm(webDir, { recursive: true, force: true }); });

export async function fixture(plans: ResponsePlan[], finiteBudget = false, pauseResponse?: Promise<void>, browserOptions: { args?: string[]; suggestionPlans?: ResponsePlan[]; messageResponse?: Promise<void>; steerResponse?: Promise<void>; initiallyDrive?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-composer-lifecycle-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer(plans);
  cleanup.push(() => provider.close());
  const suggestion = browserOptions.suggestionPlans ? await openaiServer(browserOptions.suggestionPlans) : undefined;
  if (suggestion) cleanup.push(() => suggestion.close());
  const options = {
    stateDir: join(root, 'state'), catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') }, projects: [{ id: 'alpha', root }], webDir, autoDrive: true,
    ...(finiteBudget ? { limits: { defaultBudgetTokens: 20_000_000 } } : {}),
    models: { entries: [{ id: 'local', provider: provider.model.provider, grade: 'high' as const, api: 'openai-completions' as const,
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }, ...(suggestion ? [{ id: 'cheap', provider: suggestion.model.provider, grade: 'low' as const, api: 'openai-completions' as const, baseUrl: suggestion.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }] : [])], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  };
  let server = await openGraphServer({ ...options, autoDrive: browserOptions.initiallyDrive !== false });
  server.runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'lifecycle-master');
  cleanup.push(() => server.close());
  let browserUrl = server.url;
  if (pauseResponse || browserOptions.messageResponse || browserOptions.steerResponse) {
    // Delay delivery of a genuine application response at the network boundary.
    // No owner DTO or pause transition is supplied by this transport proxy.
    const proxy = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined && !['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const upstream = await fetch(`${server.url}${request.url}`, {
        method: request.method ?? 'GET', headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      if (request.url?.endsWith('/pause')) await pauseResponse;
      if (request.url?.endsWith('/messages') && request.method === 'POST') await browserOptions.messageResponse;
      if (request.url?.endsWith('/steer') && request.method === 'POST') await browserOptions.steerResponse;
      // fetch decodes gzip before exposing body; forward headers for those bytes.
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
      response.writeHead(upstream.status, Object.fromEntries(responseHeaders));
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          while (!response.destroyed) {
            const chunk = await reader.read();
            if (chunk.done) break;
            response.write(chunk.value);
          }
        } catch (error) {
          if (!response.destroyed) response.destroy(error instanceof Error ? error : new Error(String(error)));
        } finally { reader.releaseLock(); }
      }
      response.end();
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    browserUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    cleanup.push(async () => { proxy.closeAllConnections(); await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); });
  }
  const browser = await chromium.launch({ headless: true, ...(browserOptions.args ? { args: browserOptions.args } : {}) });
  cleanup.push(() => browser.close());
  const context = await browser.newContext({ extraHTTPHeaders: { origin: browserUrl } });
  const page = await context.newPage();
  await page.request.get(browserUrl);
  async function post(path: string, data: Record<string, unknown> = {}) {
    const response = await page.request.post(`${browserUrl}${path}`, { data: { requestId: crypto.randomUUID(), ...data } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  async function view(id: string) { return (await page.request.get(`${browserUrl}/api/conversations/${id}`)).json(); }
  async function events(id: string) { return (await page.request.get(`${browserUrl}/api/conversations/${id}/events?limit=500`)).json() as Promise<{ type: string; data: Record<string, unknown> }[]>; }
  async function open(id: string) { await page.goto(`${browserUrl}/#/conversations/${id}`); await page.waitForURL(`${browserUrl}/#/conversations/${id}`); await page.locator('[data-testid="conversation"]:visible').getByTestId('chat-input').waitFor(); }
  async function answered(id: string, count: number) {
    await expect.poll(async () => (await view(id)).messages.filter((message: { role: string }) => message.role === 'assistant').length, { timeout: 30_000 }).toBe(count);
  }
  return { root, get url() { return browserUrl; }, page, provider, suggestion, post, view, events, open, answered, get runtime() { return server.runtime; }, async restart(restoredBinding?: { targetTaskId: string; sourceTaskId: string }) {
    await server.close();
    if (restoredBinding) {
      // External restore input changes only a current binding. Every instance,
      // invocation, receipt and row order came from the closed real producer.
      const snapshot = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
      try {
        const binding = snapshot.prepare("SELECT instance_id FROM nodes WHERE task_id=? AND id='master'");
        const source = binding.get(restoredBinding.sourceTaskId) as { instance_id: string };
        const target = binding.get(restoredBinding.targetTaskId) as { instance_id: string };
        expect(source.instance_id).toBeTruthy(); expect(target.instance_id).toBeTruthy();
        // Two independently produced instances remain uniquely bound. The
        // external restore input exchanges bindings without touching history.
        snapshot.exec('BEGIN');
        try {
          const update = snapshot.prepare("UPDATE nodes SET instance_id=? WHERE task_id=? AND id='master'");
          expect(update.run(null, restoredBinding.targetTaskId).changes).toBe(1);
          expect(update.run(target.instance_id, restoredBinding.sourceTaskId).changes).toBe(1);
          expect(update.run(source.instance_id, restoredBinding.targetTaskId).changes).toBe(1);
          snapshot.exec('COMMIT');
        } catch (error) { snapshot.exec('ROLLBACK'); throw error; }
      } finally { snapshot.close(); }
    }
    server = await openGraphServer(options);
    if (!pauseResponse && !browserOptions.messageResponse && !browserOptions.steerResponse) browserUrl = server.url;
    await context.setExtraHTTPHeaders({ origin: browserUrl });
    await page.request.get(browserUrl);
  } };
}

export const usage = (input: number, cached: number): NonNullable<ResponsePlan['usage']> => ({ prompt_tokens: input, completion_tokens: 2, prompt_tokens_details: { cached_tokens: cached } });
