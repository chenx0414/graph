import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * What a price refresh is allowed to do.
 *
 * A refresh re-stamps an archived price only when the official page still
 * names the model. A page that does not is a failed verification: the old
 * amount is kept and the entry is marked stale - never silently re-stamped,
 * never zero-filled. A verified refresh re-stamps the price and the revision
 * it froze, so the next invocation is priced with the revision it ran under.
 *
 * The proof is the real daemon and a real price page it can be pointed at.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

const MODEL_ID = 'claude-sonnet-4-5';

/** A price page that names the model - or one that does not. */
async function pricePage(namesTheModel: boolean): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const body = namesTheModel
      ? `<html><body>Pricing for ${MODEL_ID} and every other model.</body></html>`
      : '<html><body>Pricing for models we no longer list.</body></html>';
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/pricing`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** A model service that answers one master turn. */
async function provider(text = 'Priced.'): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (request, response) => {
    for await (const chunk of request) { void chunk; }
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37, prompt_tokens_details: { cached_tokens: 10 } } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

interface ConfigDocument {
  revision?: number;
  models: { entries: { id: string; cost?: unknown; pricing?: Record<string, unknown> }[] };
}

async function fixture(priceUrl: string, providerBaseUrl: string) {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-price-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    models: { entries: [{
      id: 'sonnet', provider: 'anthropic', modelId: MODEL_ID, grade: 'highest', api: 'openai-completions',
      baseUrl: providerBaseUrl, contextWindow: 200000, maxTokens: 8192, credentialId: 'anthropic',
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      pricing: { currency: 'USD', unit: 'per_million_tokens', sourceUrl: 'https://www.anthropic.com/pricing', retrievedAt: '2026-01-01', catalogRevision: 'old', status: 'known' },
    }] },
    credentials: { anthropic: { secretRef: 'ANTHROPIC_API_KEY' } },
    limits: {},
  }, null, 2));
  const daemon = await launchCli(root, {
    configPath,
    env: { ANTHROPIC_API_KEY: 'synthetic', GRAPH_PRICE_SOURCE_URL: priceUrl },
    extraArgs: ['--execute'],
  });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  return { root, configPath, daemon, request };
}

test('the refresh endpoint is explicit: failure marks the entry stale and keeps the old amount', async () => {
  const page = await pricePage(false);
  cleanup.push(() => page.close());
  const vendor = await provider();
  cleanup.push(() => vendor.close());
  const f = await fixture(page.url, vendor.baseUrl);

  const before = JSON.parse(await readFile(f.configPath, 'utf8')) as ConfigDocument;
  const refreshed = await f.request('/api/pricing/refresh', {
    method: 'POST', body: JSON.stringify({ expectedRevision: before.revision ?? 0 }),
  });
  expect(refreshed.status).toBe(200);
  const body = refreshed.body as { applied: boolean; restartRequired: boolean; results: { modelId: string; status: string }[] };
  expect(body.applied).toBe(true);
  expect(body.restartRequired).toBe(false);
  expect(body.results.find(result => result.modelId === MODEL_ID)?.status).toBe('stale');

  // The old amount survives a failed verification: nothing is zero-filled and
  // nothing is silently re-stamped.
  const after = JSON.parse(await readFile(f.configPath, 'utf8')) as ConfigDocument;
  const entry = after.models.entries[0]!;
  expect(entry.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  expect(entry.pricing?.status).toBe('stale');
}, 120_000);

test('a verified refresh re-stamps the price the next invocation freezes', async () => {
  const page = await pricePage(true);
  cleanup.push(() => page.close());
  const vendor = await provider();
  cleanup.push(() => vendor.close());
  const f = await fixture(page.url, vendor.baseUrl);

  const before = JSON.parse(await readFile(f.configPath, 'utf8')) as ConfigDocument;
  const refreshed = await f.request('/api/pricing/refresh', {
    method: 'POST', body: JSON.stringify({ expectedRevision: before.revision ?? 0 }),
  });
  expect(refreshed.status).toBe(200);
  const body = refreshed.body as { applied: boolean; results: { modelId: string; status: string }[] };
  expect(body.applied).toBe(true);
  expect(body.results.find(result => result.modelId === MODEL_ID)?.status).toBe('known');

  const after = JSON.parse(await readFile(f.configPath, 'utf8')) as ConfigDocument;
  const entry = after.models.entries[0]!;
  expect(entry.pricing?.status).toBe('known');
  expect(String(entry.pricing?.catalogRevision)).toContain('refresh');

  // The next invocation is priced with the revision that was in effect when
  // it ran, not with the one that was archived before the refresh.
  const created = await f.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'sonnet', text: 'price the call', requestId: 'price-1' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const { taskId } = created.body as { taskId: string };
  await expect.poll(async () => {
    const view = await f.request(`/api/tasks/${taskId}/nodes/master/run`);
    const run = view.body as { invocations?: { cost?: { priceRevision?: string; amount?: number } }[] };
    return (run.invocations ?? []).length;
  }, { timeout: 30_000, interval: 250 }).toBeGreaterThan(0);
  const run = (await f.request(`/api/tasks/${taskId}/nodes/master/run`)).body as { invocations?: { cost?: { priceRevision?: string; amount?: number; currency?: string } }[] };
  const cost = run.invocations?.[0]?.cost;
  expect(cost?.priceRevision).toBe(entry.pricing?.catalogRevision);
  expect(cost?.currency).toBe('USD');
  // Thirty input tokens of which ten are cached, seven output tokens.
  expect(cost?.amount).toBeCloseTo((20 * 3 + 7 * 15 + 10 * 0.3) / 1_000_000, 12);
}, 120_000);
