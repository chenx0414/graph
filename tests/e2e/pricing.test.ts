import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test('actual invocation costs distinguish complete prices, free prices and unknown prices', async () => {
  const provider = await openaiServer(Array.from({ length: 4 }, () => ({ text: 'priced reply', usage: { prompt_tokens: 1_100_000, completion_tokens: 500_000, prompt_tokens_details: { cached_tokens: 100_000 } } })));
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-cost-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const pricing = { currency: 'USD', unit: 'per_million_tokens', sourceUrl: 'manual', retrievedAt: '2026-09-15', catalogRevision: 'r1', status: 'known' };
  const cases = [
    { id: 'priced', cost: { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 1 }, pricing, expected: { amount: 4.05, currency: 'USD', unit: 'per_million_tokens', priceRevision: 'r1' } },
    { id: 'free', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, pricing, expected: { amount: 0, currency: 'USD', unit: 'per_million_tokens', priceRevision: 'r1' } },
    { id: 'unknown', expected: { unknown: true } },
    { id: 'legacy', cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, expected: { amount: 1.6 } },
  ];
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }], credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } }, models: { entries: cases.map(row => ({ id: row.id, provider: 'graph-openai', modelId: 'local', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 2_000_000, maxTokens: 256, credentialId: 'local', ...(row.cost ? { cost: row.cost } : {}), ...(row.pricing ? { pricing: row.pricing } : {}) })) } }));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir, port: 0, mode: 'execute', dynamic: true, env: { HOME: root, GRAPH_LOCAL_KEY: 'cost-key' }, log: () => undefined });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  for (const row of cases) {
    const response = await fetch(`${daemon.url}/api/conversations`, { method: 'POST', headers, body: JSON.stringify({ text: `price ${row.id}`, model: row.id, requestId: row.id }) });
    expect(response.status).toBe(200);
    const created = await response.json() as { taskId: string };
    await expect.poll(async () => (await (await fetch(`${daemon.url}/api/tasks/${created.taskId}`, { headers })).json()).invocations[0]?.cost, { timeout: 20_000 }).toEqual(row.expected);
  }
}, 120_000);
