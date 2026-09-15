import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { afterEach, expect, test } from 'vitest';
import { estimateCost } from '../../src/catalog/models.ts';
import { PROVIDER_TEMPLATES, providerTemplate, templateModelEntry } from '../../src/catalog/providers.ts';
import { applyPriceSnapshot, PRICE_SNAPSHOT, snapshotFor } from '../../src/catalog/price-snapshot.ts';
import { startGraphDaemon } from '../../src/server/start.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test('every archived price carries amounts, currency, unit, source and date', () => {
  expect(PRICE_SNAPSHOT.length).toBeGreaterThan(0);
  for (const entry of PRICE_SNAPSHOT) {
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      expect(Number.isFinite(entry.cost[field])).toBe(true);
      expect(entry.cost[field]).toBeGreaterThanOrEqual(0);
    }
    expect(entry.currency).toMatch(/^[A-Z]{3}$/);
    expect(entry.unit).toBe('per_million_tokens');
    expect(entry.sourceUrl).toMatch(/^https:\/\//);
    expect(entry.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entry.catalogRevision).toContain(entry.retrievedAt);
  }
  // At least one template model shows a reference price with provenance.
  const anthropic = providerTemplate('anthropic')!;
  const sonnet = anthropic.models.find(model => model.id === 'claude-sonnet-4-5')!;
  expect(sonnet.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  expect(sonnet.pricing).toMatchObject({ currency: 'USD', status: 'known', retrievedAt: '2026-09-15' });
  expect(sonnet.pricing!.sourceUrl).toBe('https://www.anthropic.com/pricing');
  const entry = templateModelEntry(anthropic, sonnet, 'anthropic-key');
  expect(entry.cost).toEqual(sonnet.cost);
  expect(entry.pricing).toMatchObject({ catalogRevision: '2026-09-15.anthropic' });
});

test('template models without a verified snapshot stay unknown, never zero', () => {
  const openai = providerTemplate('openai')!;
  for (const model of openai.models) {
    expect(snapshotFor(openai.id, model.id)).toBeUndefined();
    expect(model.cost).toBeUndefined();
    expect(model.pricing).toBeUndefined();
    const entry = templateModelEntry(openai, model, 'openai-key');
    expect('cost' in entry).toBe(false);
    expect('pricing' in entry).toBe(false);
  }
  // No template ever ships an all-zero price without provenance.
  for (const template of PROVIDER_TEMPLATES) {
    for (const model of template.models) {
      if (!model.cost) continue;
      expect(model.pricing?.sourceUrl).toBeTruthy();
      expect(model.pricing?.retrievedAt).toBeTruthy();
    }
  }
});

test('a successful refresh stamps a new revision while a failed one keeps the old amount as stale', () => {
  type Doc = { version: number; models: { entries: Record<string, any>[] } };
  const document: Doc = {
    version: 1,
    models: { entries: [
      { id: 'sonnet', provider: 'anthropic', modelId: 'claude-sonnet-4-5', cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, pricing: { currency: 'USD', unit: 'per_million_tokens', sourceUrl: 'https://www.anthropic.com/pricing', retrievedAt: '2026-01-01', catalogRevision: 'old', status: 'known' } },
      { id: 'unknown-model', provider: 'openai', cost: undefined },
      { id: 'manual', provider: 'custom', cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 }, pricing: { currency: 'USD', unit: 'per_million_tokens', sourceUrl: 'manual', status: 'known' } },
    ] },
  };
  const failed = applyPriceSnapshot(document, { verify: () => false, revision: 'r2', retrievedAt: '2026-09-15' });
  const failedEntries = (failed.document as Doc).models.entries;
  expect(failedEntries[0]!.cost).toEqual({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
  expect(failedEntries[0]!.pricing).toMatchObject({ status: 'stale' });
  expect(failed.results.find(result => result.modelId === 'claude-sonnet-4-5')?.status).toBe('stale');
  expect(failed.results.find(result => result.modelId === 'unknown-model')?.status).toBe('unknown');
  expect(failed.results.find(result => result.modelId === 'manual')?.status).toBe('manual');
  // The original input document is not mutated.
  expect(document.models.entries[0]!.pricing.status).toBe('known');

  const ok = applyPriceSnapshot(document, { verify: () => true, revision: 'r3', retrievedAt: '2026-09-16' });
  const okEntry = (ok.document as Doc).models.entries[0]!;
  expect(okEntry.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  expect(okEntry.pricing).toMatchObject({ status: 'known', catalogRevision: 'r3', retrievedAt: '2026-09-16' });
  // Hand check: one million input tokens at the archived rate costs $3.
  expect(estimateCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, okEntry.cost, okEntry.pricing)).toEqual({
    amount: 3, currency: 'USD', unit: 'per_million_tokens', priceRevision: 'r3',
  });
});

async function daemonWith(config: Record<string, unknown>, options: { priceVerify?: (snapshot: { provider: string; modelId: string }) => boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-price-refresh-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  const web = join(root, 'web');
  await mkdir(web, { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><html><body>Graph</body></html>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, ...config, projects: [{ id: 'p', root: projectRoot }] }, null, 2));
  const daemon = await startGraphDaemon({
    configPath, stateDir: join(root, 'state'), webDir: web, port: 0, mode: 'execute', dynamic: true,
    env: { ANTHROPIC_API_KEY: 'synthetic' }, log: () => undefined,
    ...(options.priceVerify ? { priceVerify: options.priceVerify as never } : {}),
  });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const cookie = home.headers.get('set-cookie') ?? '';
  return { daemon, configPath, headers: { origin: daemon.url, cookie, 'content-type': 'application/json' } };
}

const modelEntry = (pricing: Record<string, unknown>) => ({
  models: { entries: [{
    id: 'sonnet', provider: 'anthropic', modelId: 'claude-sonnet-4-5', grade: 'highest', api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com', contextWindow: 200_000, maxTokens: 8_192, credentialId: 'anthropic',
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, pricing,
  }] },
  credentials: { anthropic: { secretRef: 'ANTHROPIC_API_KEY' } },
});

test('the refresh endpoint is explicit: failure marks the entry stale and keeps the old amount', async () => {
  const { daemon, configPath, headers } = await daemonWith(modelEntry({ currency: 'USD', unit: 'per_million_tokens', sourceUrl: 'https://www.anthropic.com/pricing', retrievedAt: '2026-01-01', catalogRevision: 'old', status: 'known' }), { priceVerify: () => false });
  const before = JSON.parse(await readFile(configPath, 'utf8'));
  const response = await fetch(`${daemon.url}/api/pricing/refresh`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: before.revision ?? 0 }) });
  expect(response.status).toBe(200);
  const body = await response.json() as { applied: boolean; restartRequired: boolean; results: { modelId: string; status: string }[] };
  expect(body.applied).toBe(true);
  expect(body.restartRequired).toBe(false);
  expect(body.results.find(result => result.modelId === 'claude-sonnet-4-5')?.status).toBe('stale');
  const after = JSON.parse(await readFile(configPath, 'utf8'));
  const entry = after.models.entries[0];
  expect(entry.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  expect(entry.pricing.status).toBe('stale');
}, 60_000);

test('a verified refresh bumps the revision that the next invocation freezes', async () => {
  const { daemon, configPath, headers } = await daemonWith(modelEntry({ currency: 'USD', unit: 'per_million_tokens', sourceUrl: 'https://www.anthropic.com/pricing', retrievedAt: '2026-01-01', catalogRevision: 'old', status: 'known' }), { priceVerify: () => true });
  const before = JSON.parse(await readFile(configPath, 'utf8'));
  const response = await fetch(`${daemon.url}/api/pricing/refresh`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: before.revision ?? 0 }) });
  const body = await response.json() as { applied: boolean; results: { modelId: string; status: string }[] };
  expect(body.applied).toBe(true);
  expect(body.results.find(result => result.modelId === 'claude-sonnet-4-5')?.status).toBe('known');
  const after = JSON.parse(await readFile(configPath, 'utf8'));
  const pricing = after.models.entries[0].pricing;
  expect(pricing.status).toBe('known');
  expect(pricing.catalogRevision).toContain('refresh');
  const cost = estimateCost({ input: 1_000, output: 1_000, cacheRead: 0, cacheWrite: 0 }, after.models.entries[0].cost, pricing);
  expect(cost).toMatchObject({ amount: 0.018, currency: 'USD' });
  // The pre-refresh frozen estimate is unchanged by construction.
  const stale = estimateCost({ input: 1_000, output: 1_000, cacheRead: 0, cacheWrite: 0 }, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, { currency: 'USD', unit: 'per_million_tokens', catalogRevision: 'old', status: 'known' });
  expect(stale).toMatchObject({ amount: 0.002, priceRevision: 'old' });
}, 60_000);
