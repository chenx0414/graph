import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * Where the global supervisor works.
 *
 * The main Agent is the one Agent whose job is this repository: it changes the
 * harness, runs the checks and reads its own source. An unbound conversation
 * has no project of its own, and the synthetic one it gets points at the
 * conversation's state directory - so every relative path in a command and
 * every casual `ls` answered about a snapshot of nothing. The checkout the
 * daemon runs from is the workspace instead.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('the global main Agent works in the checkout it runs from', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-main-workspace-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  await mkdir(checkout, { recursive: true });
  // A file that exists only in the checkout: the listing either names it or
  // the Agent was looking somewhere else.
  await writeFile(join(checkout, 'CHECKOUT-MARKER.txt'), 'this checkout is the workspace\n');
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const provider = await openaiServer([
    { tools: [{ id: 'read-marker', name: 'read', arguments: JSON.stringify({ path: 'CHECKOUT-MARKER.txt' }) }] },
    { text: 'Listed the workspace.' },
  ]);
  cleanup.push(() => provider.close());

  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{ id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath,
    webDir: join(root, 'web'),
    env: { GRAPH_LOCAL_KEY: 'key-local', GRAPH_RSI_ROOT: checkout },
    extraArgs: ['--execute'],
  });
  cleanup.push(() => daemon.close());

  // No projectId: this is the global supervisor's own conversation.
  const created = await daemon.request('/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'local', text: 'Read the marker in your workspace.', requestId: 'main-workspace' }),
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const { conversationId } = await created.json() as { conversationId: string };

  await expect.poll(async () => {
    const view = await daemon.request(`/api/conversations/${conversationId}`);
    const body = await view.json() as { master?: { status?: string } };
    return body.master?.status;
  }, { timeout: 60_000, interval: 250 }).toBe('succeeded');

  const view = await daemon.request(`/api/conversations/${conversationId}`);
  const body = await view.json() as {
    messages?: { role?: string; text?: string; data?: { tool?: string; result?: string } }[];
  };
  const tool = (body.messages ?? []).filter(message => message.role === 'tool').map(message => message.text ?? '').join('\n');
  // The marker exists only inside the checkout, so a read that did not fail is
  // a read that resolved there. The failure names the directory it tried.
  expect(tool, `the read failed, so the relative path left the checkout: ${tool.slice(0, 400)}`).not.toContain('Tool failed');
  expect(tool, 'the relative path resolved outside the checkout').not.toContain('state/conversations');
}, 120_000);
