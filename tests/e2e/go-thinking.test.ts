import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The thinking strength a user picks must reach the model.
 *
 * A console that offers "xhigh" and a provider that is never told about it are
 * two different products: the user chooses a strength, the daemon clamps it to
 * what the model actually accepts, and the request that leaves the process
 * carries that strength. A model with no discrete strengths runs without an
 * effort at all, and the request says nothing about thinking.
 *
 * The daemon runs on the PiG kernel, so the Go process itself owns the model
 * channel: the request the endpoint records is the Go transport's own request,
 * not a sidecar's.
 *
 * The proof is the real daemon and a real endpoint that records every request
 * body it was sent.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface Endpoint {
  baseUrl: string;
  bodies: Record<string, unknown>[];
  close: () => Promise<void>;
}

async function endpoint(text = 'Answered.'): Promise<Endpoint> {
  const bodies: Record<string, unknown>[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    try { bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>); }
    catch { bodies.push({}); }
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

interface Case {
  id: string;
  provider: string;
  modelId: string;
  levels: string[];
  requested?: string;
  defaultThinkingLevel?: string;
  selected: string;
  /** 'none' marks a provider that is not asked for a strength in the plain way. */
  wire?: 'none';
}

// The catalog is the authority on what a model accepts: a level it does not
// name is denied, so the daemon clamps the request to the nearest strength the
// model does take.
const cases: Case[] = [
  // 'max' is stronger than grok offers: the nearest strength it does offer wins.
  { id: 'grok', provider: 'grok', modelId: 'grok-4.6', levels: ['low', 'medium', 'high', 'xhigh'], requested: 'max', selected: 'xhigh' },
  // 'medium' sits between deepseek's levels: the next stronger one wins.
  { id: 'deepseek', provider: 'deepseek', modelId: 'deepseek-flash', levels: ['low', 'high', 'max'], requested: 'medium', selected: 'high' },
  // A saved default the model does not accept is clamped the same way.
  { id: 'account', provider: 'opencode-go-3', modelId: 'deepseek-v4.1-flash', levels: ['low', 'high', 'max'], defaultThinkingLevel: 'xhigh', selected: 'max' },
  // Without a request the model runs at its second strongest strength.
  { id: 'toggle', provider: 'opencode-go', modelId: 'mimo-v2.6-pro', levels: ['minimal', 'low', 'medium', 'high'], selected: 'medium' },
  // A model the catalog does not know still runs: its own default levels apply.
  { id: 'unknown', provider: 'no-such-provider', modelId: 'no-such-model', levels: ['minimal', 'low', 'medium', 'high'], defaultThinkingLevel: 'xhigh', selected: 'high' },
  // 'off' is not a strength: the nearest one the model takes wins.
  { id: 'deepseek-off', provider: 'deepseek', modelId: 'deepseek-flash', levels: ['low', 'high', 'max'], requested: 'off', selected: 'low' },
  // A model with one strength runs at that one.
  { id: 'single', provider: 'nano-gpt', modelId: 'openai/gpt-5-pro', levels: ['high'], selected: 'high' },
  // A provider that does not understand the plain effort field is not asked in
  // that way at all: a request it cannot read is a request it refuses.
  { id: 'xai', provider: 'xai', modelId: 'grok-4.6', levels: ['low', 'medium', 'high', 'xhigh'], selected: 'high', wire: 'none' },
  // A model with no discrete strengths runs without one at all.
  { id: 'empty', provider: 'llmgateway-providers', modelId: 'novita/ling-3.0-flash', levels: [], selected: 'off' },
];

interface ModelRow { id: string; thinkingOptions?: { level: string; label: string }[] }
interface ConversationView { master?: { status?: string }; telemetry?: { model?: string; thinkingLevel?: string } }

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
