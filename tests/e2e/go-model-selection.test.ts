import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * Which model a turn runs on.
 *
 * Graph used to answer that with a grade: every model carried a tier, every
 * recipe carried a recommended grade, and the runtime resolved one into the
 * other through a per-grade preference list. The layering is gone. A model is
 * whatever the configuration names, and the only selection left is the
 * explicit one: a requested model id when a node names it, otherwise the first
 * model in the configured directory.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('a turn without a requested model runs on the first configured model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-model-selection-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  // One provider, two model ids. The first one is the cheap one: under the old
  // grade resolution a main turn asked for "high" and landed on the second.
  const provider = await openaiServer([{ text: 'answered' }]);
  cleanup.push(() => provider.close());

  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [
      { id: 'cheap', modelId: 'cheap-model', provider: 'graph-openai', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' },
      { id: 'dear', modelId: 'dear-model', provider: 'graph-openai', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' },
    ] },
  }));

  const daemon = await launchCli(root, {
    configPath,
    webDir: join(root, 'web'),
    env: { GRAPH_LOCAL_KEY: 'key-local' },
    extraArgs: ['--execute'],
  });
  cleanup.push(() => daemon.close());

  const created = await daemon.request('/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'p', text: 'Say something.', requestId: 'model-selection' }),
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const { conversationId } = await created.json() as { conversationId: string };
  await expect.poll(async () => {
    const view = await daemon.request(`/api/conversations/${conversationId}`);
    const body = await view.json() as { master?: { status?: string } };
    return body.master?.status;
  }, { timeout: 60_000, interval: 250 }).toBe('succeeded');

  const asked = (provider.requests as { model?: string }[]).map(request => request.model);
  expect(asked.length, 'no request reached the provider').toBeGreaterThan(0);
  expect(asked[0], 'a grade still decided which model ran the turn').toBe('cheap-model');
}, 120_000);

test('the configuration and the recipes carry no grade at all', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-model-grades-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await openaiServer([{ text: 'ok' }]);
  cleanup.push(() => provider.close());

  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: {
      entries: [{ id: 'only', modelId: 'only', provider: 'graph-openai', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }],
      preferences: { high: ['only'] },
    },
  }));
  const daemon = await launchCli(root, { configPath, webDir: join(root, 'web'), env: { GRAPH_LOCAL_KEY: 'key-local' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());

  const listed = await daemon.request('/api/config');
  expect(listed.status).toBe(200);
  const view = await listed.json() as {
    config: { models?: { entries?: Record<string, unknown>[]; preferences?: unknown } | null };
  };
  const entries = view.config.models?.entries ?? [];
  expect(entries.length, 'the configured model is still listed').toBe(1);
  expect(entries[0]!.grade, 'the model still carries a grade').toBeUndefined();
  expect(view.config.models?.preferences, 'the per-grade preference table still exists').toBeUndefined();

  const catalog = await (await daemon.request('/api/catalog')).json() as {
    agentCombinations?: { recommendedGrade?: unknown; id?: string }[];
  };
  const combinations = catalog.agentCombinations ?? [];
  expect(combinations.length, 'the recipes are still listed').toBeGreaterThan(0);
  for (const combination of combinations) {
    expect(combination.recommendedGrade, `recipe ${combination.id} still recommends a grade`).toBeUndefined();
  }
}, 120_000);
