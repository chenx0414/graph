import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { estimateCost } from '../../src/catalog/models.ts';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test('cost normalization uses per-million units, keeps currency and never fills unknown with zero', () => {
  const usage = { input: 1_000_000, output: 500_000, cacheRead: 100_000, cacheWrite: 0 };
  const pricing = { currency: 'USD', unit: 'per_million_tokens' as const, sourceUrl: 'https://example.test/pricing', retrievedAt: '2026-09-15', catalogRevision: '2026-09-15', status: 'known' as const };
  expect(estimateCost(usage, { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 1 }, pricing)).toEqual({
    amount: 4.05, currency: 'USD', unit: 'per_million_tokens', priceRevision: '2026-09-15',
  });
  // A configured free price is a real zero with provenance.
  expect(estimateCost(usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, pricing)).toMatchObject({ amount: 0, currency: 'USD' });
  // Missing price is unknown, not zero.
  expect(estimateCost(usage)).toEqual({ unknown: true });
  expect(estimateCost(usage, undefined, pricing)).toEqual({ unknown: true });
  // Legacy entries without currency still produce the historical amount shape.
  expect(estimateCost(usage, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })).toEqual({ amount: 1.6 });
});

test('a price refresh changes future invocations and leaves recorded cost snapshots untouched', async () => {
  const provider = await openaiServer([{ text: 'first' }, { text: 'second' }]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-pricing-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const web = join(root, 'web');
  await mkdir(web, { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><html><body><div id="root">Graph</div></body></html>');
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  const configPath = join(root, 'graph.config.json');

  const document = (input: number, output: number, revision: string) => ({
    version: 1,
    projects: [{ id: 'p', root: projectRoot }],
    models: { entries: [{
      id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local',
      cost: { input, output, cacheRead: 0, cacheWrite: 0 },
      pricing: { currency: 'USD', unit: 'per_million_tokens', sourceUrl: 'https://example.test/pricing', retrievedAt: '2026-09-15', catalogRevision: revision, status: 'known' },
    }] },
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
  });
  await writeFile(configPath, JSON.stringify({ ...document(2, 4, 'r1'), revision: 0 }, null, 2));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), webDir: web, port: 0, mode: 'execute', dynamic: true, env: {}, log: () => undefined });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  await fetch(`${daemon.url}/api/app/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-graph-app-token': daemon.appToken, origin: daemon.url },
    body: JSON.stringify({ ref: 'GRAPH_LOCAL_KEY', value: 'key-1' }),
  });

  const runOne = async (text: string, requestId: string) => {
    const created = await (await fetch(`${daemon.url}/api/conversations`, { method: 'POST', headers, body: JSON.stringify({ text, requestId }) })).json() as { conversationId: string; taskId: string };
    const deadline = Date.now() + 10_000;
    for (;;) {
      const view = await (await fetch(`${daemon.url}/api/tasks/${created.taskId}`, { headers })).json() as { invocations: { usage: unknown; cost: unknown }[]; nodes: { status: string }[] };
      // Wait for settlement: a dispatched invocation may not have its frozen
      // cost snapshot yet under parallel test load.
      if (view.invocations.length && view.invocations.every(invocation => invocation.cost !== null)) return { ...view, taskId: created.taskId };
      if (Date.now() > deadline) throw new Error('invocation not recorded');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const first = await runOne('第一句。', 'price-1');
  // Usage: 25 non-cache input, 10 output (the fixture reports 15 cached of 40 prompt).
  expect(first.invocations[0]!.cost).toMatchObject({ amount: (25 * 2 + 10 * 4) / 1_000_000, currency: 'USD', priceRevision: 'r1' });

  const updated = await fetch(`${daemon.url}/api/config`, {
    method: 'POST', headers, body: JSON.stringify({ expectedRevision: 0, document: document(20, 40, 'r2') }),
  });
  expect(await updated.json()).toMatchObject({ applied: true, effectiveRevision: 1 });
  const second = await runOne('第二句。', 'price-2');
  expect(second.invocations[0]!.cost).toMatchObject({ amount: (25 * 20 + 10 * 40) / 1_000_000, currency: 'USD', priceRevision: 'r2' });

  // The historical record still carries the first price revision and amount.
  const replay = await (await fetch(`${daemon.url}/api/tasks/${first.taskId}`, { headers })).json() as { invocations: { cost: unknown }[] };
  expect(replay.invocations[0]!.cost).toMatchObject({ amount: (25 * 2 + 10 * 4) / 1_000_000, currency: 'USD', priceRevision: 'r1' });
}, 60_000);
