import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * What one invocation really cost.
 *
 * A price is two facts: the rates the model charges, and the price sheet
 * those rates came from. A model with rates and a sheet reports an amount
 * and says which sheet it used; a model whose rates are all zero is free,
 * and it still says which sheet it used; a model with no rates at all has no
 * honest answer, and the runtime says "unknown" rather than inventing one.
 *
 * The proof is the real daemon reading a real provider's real usage: the
 * cached tokens are billed at the cache rate, not at the input rate.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface Invocation { cost?: unknown }

test('an invocation reports what it really cost: a priced model, a free model, an unknown one and a legacy one', async () => {
  // One usage for every call: 1.1M prompt tokens of which 100k are cached,
  // and 500k completion tokens.
  const usage = { prompt_tokens: 1_100_000, completion_tokens: 500_000, prompt_tokens_details: { cached_tokens: 100_000 } };
  const server: Server = createServer((_request, response) => {
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'priced reply' }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

  const pricing = { currency: 'USD', unit: 'per_million_tokens', sourceUrl: 'manual', retrievedAt: '2026-09-15', catalogRevision: 'r1', status: 'known' };
  const cases = [
    // 1M billable input at 2, 500k output at 4, 100k cache reads at 0.5.
    { id: 'priced', cost: { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 1 }, pricing,
      expected: { amount: 4.05, currency: 'USD', unit: 'per_million_tokens', priceRevision: 'r1' } },
    // Every rate is zero: free, and the sheet it was priced on is still named.
    { id: 'free', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, pricing,
      expected: { amount: 0, currency: 'USD', unit: 'per_million_tokens', priceRevision: 'r1' } },
    // No rates at all: there is no honest amount to report.
    { id: 'unknown', expected: { unknown: true } },
    // Rates without a sheet: the amount is still computable, and it is reported bare.
    { id: 'legacy', cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      expected: { amount: 1.6 } },
  ];

  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-pricing-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: cases.map(row => ({
      id: row.id, provider: 'graph-openai', modelId: 'local', grade: 'high', api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 2_000_000, maxTokens: 256, credentialId: 'local',
      ...(row.cost ? { cost: row.cost } : {}),
      ...(row.pricing ? { pricing: row.pricing } : {}),
    })) },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_LOCAL_KEY: 'cost-key' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };

  for (const row of cases) {
    const created = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: row.id, text: `price ${row.id}`, requestId: row.id }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const taskId = (created.body as { taskId: string }).taskId;
    // The cost is what the invocation recorded, not what the configuration hoped for.
    await expect.poll(async () => {
      const view = await request(`/api/tasks/${taskId}`);
      const invocations = (view.body as { invocations?: Invocation[] }).invocations ?? [];
      return invocations[0]?.cost;
    }, { timeout: 60_000, interval: 250 }).toEqual(row.expected);
  }
}, 240_000);
