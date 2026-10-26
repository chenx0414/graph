import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
import { cleanup, type Endpoint, anthropicEndpoint, endpoint, type Case, cases, type ModelRow, type ConversationView } from "./go-thinking.fixture.ts";



test('the chosen thinking strength reaches the provider', async () => {
  const provider = await endpoint('thinking selected');
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-thinking-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const entries = cases.map(row => ({
    id: row.id, provider: row.provider, modelId: row.modelId, grade: 'high', api: 'openai-completions',
    baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local',
    ...(row.defaultThinkingLevel ? { defaultThinkingLevel: row.defaultThinkingLevel } : {}),
  }));
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_THINKING_KEY' } },
    models: { entries },
  }));
  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_THINKING_KEY: 'thinking-key' }, extraArgs: ['--execute', '--kernel', 'pig'],
  });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => await daemon.request(path, init);

  // The console learns the strengths from the same place the daemon clamps to.
  const settings = await (await request('/api/settings')).json() as { models?: ModelRow[] };
  const config = await (await request('/api/config')).json() as { config?: { models?: { entries?: ModelRow[] } } };

  for (const row of cases) {
    const expected = row.levels.map(level => ({ level, label: level }));
    for (const models of [settings.models ?? [], config.config?.models?.entries ?? []]) {
      const model = models.find(candidate => candidate.id === row.id);
      expect(model, `the model ${row.id} is offered`).toBeTruthy();
      expect(model!.thinkingOptions, `the strengths of ${row.id}`).toEqual(expected);
    }

    const created = await request('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'p', model: row.id, text: `choose ${row.id}`,
        ...(row.requested ? { thinkingLevel: row.requested } : {}),
        requestId: `thinking-${row.id}`,
      }),
    });
    expect(created.status, `the conversation of ${row.id} starts`).toBe(200);
    const conversationId = (await created.json() as { conversationId: string }).conversationId;

    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      return ((await view.json()) as ConversationView).master?.status;
    }, { timeout: 30_000, interval: 250 }).toBe('succeeded');

    // The strength the daemon settled on is the one the conversation reports.
    const view = (await request(`/api/conversations/${conversationId}`)).json() as Promise<ConversationView>;
    expect((await view).telemetry).toMatchObject({ model: row.id, thinkingLevel: row.selected });

    // And it is the strength that left the process.
    const sent = provider.bodies.find(body => {
      const messages = (body.messages ?? []) as { role: string; content: unknown }[];
      return messages.some(message => message.role === 'user'
        && JSON.stringify(message.content).includes(`choose ${row.id}`));
    });
    expect(sent, `the request of ${row.id} was sent`).toBeTruthy();
    expect(sent!.model).toBe(row.modelId);
    if (row.wire === 'none') {
      expect(sent, 'a provider that cannot read the plain field is not asked in it').not.toHaveProperty('reasoning_effort');
      expect(sent, 'a provider that cannot read the plain field is not asked in it').not.toHaveProperty('reasoning');
      expect(sent, 'a provider that cannot read the plain field is not asked in it').not.toHaveProperty('thinking');
    } else if (row.selected === 'off') {
      expect(sent, 'a model without strengths asks for no effort').not.toHaveProperty('reasoning_effort');
    } else {
      expect(sent, `the effort of ${row.id}`).toMatchObject({ reasoning_effort: row.selected });
    }
  }
}, 180_000);



test('a conversation keeps the strength of the model the user picks', async () => {
  const provider = await endpoint('strength follows the model');
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-thinking-switch-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_THINKING_KEY' } },
    models: { entries: [
      { id: 'grok', provider: 'grok', modelId: 'grok-4.6', grade: 'high', api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' },
      { id: 'deepseek', provider: 'deepseek', modelId: 'deepseek-flash', grade: 'high', api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' },
      { id: 'empty', provider: 'llmgateway-providers', modelId: 'novita/ling-3.0-flash', grade: 'high', api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' },
    ] },
  }));
  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_THINKING_KEY: 'thinking-key' }, extraArgs: ['--execute', '--kernel', 'pig'],
  });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => await daemon.request(path, init);

  const created = await request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'grok', text: 'first strength', requestId: 'switch-create' }),
  });
  const conversationId = (await created.json() as { conversationId: string }).conversationId;
  await expect.poll(async () => {
    const view = await request(`/api/conversations/${conversationId}`);
    return ((await view.json()) as ConversationView).master?.status;
  }, { timeout: 30_000, interval: 250 }).toBe('succeeded');

  // The console's model control: a new model, and the strength the user wants
  // for it. The model does not take 'medium', so the daemon settles on the
  // strength it does take.
  const selected = await request(`/api/conversations/${conversationId}/model`, {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek', thinkingLevel: 'medium', requestId: 'switch-model' }),
  });
  expect(selected.status).toBe(200);
  expect(await selected.json()).toMatchObject({ model: 'deepseek', thinkingLevel: 'high', changed: true });

  const chat = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: 'after the switch', requestId: 'switch-message' }),
  });
  expect(chat.status).toBe(200);
  await expect.poll(async () => {
    const sent = provider.bodies.find(body => {
      const messages = (body.messages ?? []) as { role: string; content: unknown }[];
      return messages.some(message => message.role === 'user'
        && JSON.stringify(message.content).includes('after the switch'));
    });
    return sent?.reasoning_effort;
  }, { timeout: 30_000, interval: 250 }).toBe('high');
  const switched = provider.bodies.find(body => {
    const messages = (body.messages ?? []) as { role: string; content: unknown }[];
    return messages.some(message => message.role === 'user'
      && JSON.stringify(message.content).includes('after the switch'));
  });
  expect(switched!.model).toBe('deepseek-flash');

  // A model with no strengths at all: the conversation stops asking for one.
  const emptied = await request(`/api/conversations/${conversationId}/model`, {
    method: 'POST',
    body: JSON.stringify({ model: 'empty', thinkingLevel: 'high', requestId: 'switch-empty' }),
  });
  expect(await emptied.json()).toMatchObject({ model: 'empty', thinkingLevel: 'off' });

  const last = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: 'without a strength', requestId: 'switch-empty-message' }),
  });
  expect(last.status).toBe(200);
  await expect.poll(async () => {
    const sent = provider.bodies.find(body => {
      const messages = (body.messages ?? []) as { role: string; content: unknown }[];
      return messages.some(message => message.role === 'user'
        && JSON.stringify(message.content).includes('without a strength'));
    });
    return sent?.model;
  }, { timeout: 30_000, interval: 250 }).toBe('novita/ling-3.0-flash');
  const without = provider.bodies.find(body => {
    const messages = (body.messages ?? []) as { role: string; content: unknown }[];
    return messages.some(message => message.role === 'user'
      && JSON.stringify(message.content).includes('without a strength'));
  });
  expect(without, 'a model without strengths asks for no effort').not.toHaveProperty('reasoning_effort');

  // The conversation reports the strength it actually runs at.
  const view = (await request(`/api/conversations/${conversationId}`)).json() as Promise<ConversationView>;
  expect((await view).telemetry).toMatchObject({ model: 'empty', thinkingLevel: 'off' });
}, 180_000);



test('an Anthropic model is asked for a thinking budget, and for none when it has no strengths', async () => {
  const provider = await anthropicEndpoint('Budgeted answer.');
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-thinking-anthropic-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_THINKING_KEY' } },
    models: { entries: [
      // A model the catalog names strengths for: it runs at its second
      // strongest one, and that strength is a budget of tokens.
      { id: 'claude', provider: 'anthropic', modelId: 'claude-opus-5-5', grade: 'high', api: 'anthropic-messages',
        baseUrl: provider.baseUrl, contextWindow: 200_000, maxTokens: 32_000, credentialId: 'local' },
      // A model the catalog names no strength for: it runs without one.
      { id: 'plain', provider: 'llmgateway-providers', modelId: 'novita/ling-3.0-flash', grade: 'high', api: 'anthropic-messages',
        baseUrl: provider.baseUrl, contextWindow: 32_000, maxTokens: 4_096, credentialId: 'local' },
    ] },
  }));
  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_THINKING_KEY: 'thinking-key' }, extraArgs: ['--execute', '--kernel', 'pig'],
  });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => await daemon.request(path, init);

  const settings = await (await request('/api/settings')).json() as { models?: ModelRow[] };
  const claude = (settings.models ?? []).find(model => model.id === 'claude');
  expect(claude?.thinkingOptions?.map(option => option.level)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);

  const created = await request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'claude', text: 'budget it', requestId: 'anthropic-budget' }),
  });
  const conversationId = (await created.json() as { conversationId: string }).conversationId;
  await expect.poll(async () => {
    const view = await request(`/api/conversations/${conversationId}`);
    return ((await view.json()) as ConversationView).master?.status;
  }, { timeout: 30_000, interval: 250 }).toBe('succeeded');

  // The strength this model runs at is a budget of tokens, and the ceiling the
  // answer is given is the model's own.
  const sent = provider.bodies.find(body => {
    const messages = (body.messages ?? []) as { role: string; content: unknown }[];
    return messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('budget it'));
  });
  expect(sent, 'the Anthropic request was sent').toBeTruthy();
  expect(sent!.thinking).toMatchObject({ type: 'enabled', budget_tokens: 16384, display: 'summarized' });
  expect(sent!.max_tokens).toBe(32_000);
  expect(provider.headers[0]?.['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');

  // A model with no strengths is asked for no budget at all.
  const plain = await request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'plain', text: 'no budget', requestId: 'anthropic-plain' }),
  });
  const plainId = (await plain.json() as { conversationId: string }).conversationId;
  await expect.poll(async () => {
    const view = await request(`/api/conversations/${plainId}`);
    return ((await view.json()) as ConversationView).master?.status;
  }, { timeout: 30_000, interval: 250 }).toBe('succeeded');
  const without = provider.bodies.find(body => {
    const messages = (body.messages ?? []) as { role: string; content: unknown }[];
    return messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('no budget'));
  });
  expect(without, 'the Anthropic request was sent').toBeTruthy();
  expect(without).not.toHaveProperty('thinking');
  expect(without!.max_tokens).toBe(4_096);
}, 180_000);
