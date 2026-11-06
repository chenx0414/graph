import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * Graph's own checkout is run by main, not by a supervisor of its own.
 *
 * Asking for the thread of the project whose root IS this checkout returns the
 * main conversation; no project conversation is created for it. Every other
 * project keeps its own supervisor thread exactly as before.
 */
test('the checkout project runs on the main thread while another project keeps its supervisor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-own-checkout-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await mkdir(join(root, 'other'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const checkout = process.cwd();
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [
        { id: 'checkout', root: checkout },
        { id: 'other', root: join(root, 'other') },
      ],
      credentials: { local: { secretRef: 'GRAPH_OWN_CHECKOUT_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-own', grade: 'high', api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_OWN_CHECKOUT_KEY: 'synthetic-own-key' }, extraArgs: [] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
    };

    const global = await request('/api/orchestration/global', 'POST', { requestId: 'own-global' });
    expect(global.status, JSON.stringify(global.body)).toBe(200);
    const mainConversation = String(global.body.conversationId);

    const own = await request('/api/projects/checkout/thread', 'POST', { requestId: 'own-thread' });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.conversationId).toBe(mainConversation);

    const other = await request('/api/projects/other/thread', 'POST', { requestId: 'other-thread' });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect(other.body.conversationId).not.toBe(mainConversation);

    // The same request twice is the same thread: no second supervisor appears.
    const ownAgain = await request('/api/projects/checkout/thread', 'POST', { requestId: 'own-thread-again' });
    expect(ownAgain.body.conversationId).toBe(mainConversation);
    const otherAgain = await request('/api/projects/other/thread', 'POST', { requestId: 'other-thread-again' });
    expect(otherAgain.body.conversationId).toBe(other.body.conversationId);
  } finally {
    await daemon?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
