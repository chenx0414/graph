import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The configuration the user actually saved.
 *
 * A configuration is what the user typed, and the daemon has to give it back
 * the way it was written: a credential that names its platform, a model that
 * says which modalities it takes, two accounts that point at the same
 * upstream model but stay independent of each other.
 *
 * A configuration the daemon refuses must also leave the disk alone: an
 * invalid candidate is not a partial save.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ChatBody { tools?: unknown[]; messages?: { role: string; content: unknown }[] }

/** A provider that records what it was asked and which key it was given. */
async function upstream() {
  const requests: ChatBody[] = [];
  const authorizations: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()) as ChatBody);
    authorizations.push(request.headers.authorization ?? '');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Answered.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    requests, authorizations,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('real config saves preserve model metadata and independent upstream connections while invalid candidates leave disk unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-config-contracts-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const first = await upstream();
  const second = await upstream();
  cleanup.push(() => first.close(), () => second.close());
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  const entry = { id: 'first', provider: 'platform-first', modelId: 'same-upstream', grade: 'high', api: 'openai-completions',
    baseUrl: first.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'first' };
  const initial = {
    version: 1,
    projects: [{ id: 'p', root }],
    credentials: {
      first: { secretRef: 'GRAPH_FIRST_KEY' },
      second: { secretRef: 'GRAPH_SECOND_KEY', platform: 'opencode-go', displayName: 'Second account' },
    },
    models: { entries: [entry, { ...entry, id: 'second', provider: 'platform-second', baseUrl: second.baseUrl, credentialId: 'second', input: ['text', 'image'], reasoning: false }] },
  };
  await writeFile(configPath, JSON.stringify(initial));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_FIRST_KEY: 'first-key', GRAPH_SECOND_KEY: 'second-key' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const get = async <T>(path: string): Promise<T> => (await daemon.request(path)).json() as Promise<T>;
  const post = (path: string, body: unknown) => daemon.request(path, { method: 'POST', body: JSON.stringify(body) });

  // What the user wrote is what the daemon gives back.
  const observed = await get<{ revision: number; config: { credentials: Record<string, any>; models: { entries: any[] } } }>('/api/config');
  expect(observed.config.credentials.second).toMatchObject({ platform: 'opencode-go', displayName: 'Second account', secretRef: 'GRAPH_SECOND_KEY' });
  expect(observed.config.credentials.first).not.toHaveProperty('platform');
  expect(observed.config.models.entries).toMatchObject([{ id: 'first', reasoning: true }, { id: 'second', input: ['text', 'image'], reasoning: false }]);
  expect(observed.config.models.entries[0]).not.toHaveProperty('input');

  // A candidate the daemon refuses is refused by name, and nothing is written.
  const original = await readFile(configPath, 'utf8');
  const invalid: { document: unknown; reason: string }[] = [
    ...['   ', 7].map(platform => ({ document: { ...initial, credentials: { ...initial.credentials, second: { ...initial.credentials.second, platform } } }, reason: 'credentials.second.platform' })),
    ...[
      { input: ['image'], reason: 'must include "text"' },
      { input: ['text', 'audio'], reason: 'unsupported input modality' },
      { input: ['text', 'text'], reason: 'must not contain duplicate' },
    ].map(row => ({ document: { ...initial, models: { entries: [entry, { ...initial.models.entries[1], input: row.input }] } }, reason: row.reason })),
  ];
  for (const candidate of invalid) {
    const response = await post('/api/config', { expectedRevision: 0, document: candidate.document });
    expect(response.status, JSON.stringify(candidate.reason)).toBe(400);
    expect((await response.json() as { message: string }).message).toContain(candidate.reason);
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect((await get<{ revision: number }>('/api/config')).revision).toBe(0);
  }

  // Two accounts, one upstream model, and each of them its own key.
  for (const [model, provider, key] of [['first', first, 'first-key'], ['second', second, 'second-key']] as const) {
    const response = await post('/api/conversations', { projectId: 'p', text: `Use ${model} endpoint`, model, requestId: model });
    expect(response.status).toBe(200);
    const created = await response.json() as { taskId: string };
    await expect.poll(async () => (await get<{ invocations?: { cost?: unknown }[] }>(`/api/tasks/${created.taskId}`)).invocations?.[0]?.cost,
      { timeout: 30_000, interval: 250 }).toEqual({ unknown: true });
    const sent = provider.requests.find(request => {
      const body = request as ChatBody;
      return Boolean(body.tools?.length) && body.messages?.some(message => message.role === 'user'
        && JSON.stringify(message.content).includes(`Use ${model} endpoint`));
    });
    expect(sent, `the ${model} endpoint never got its request`).toBeTruthy();
    expect(sent!).toMatchObject({ model: 'same-upstream' });
    const index = provider.requests.indexOf(sent!);
    expect(provider.authorizations[index]).toBe(`Bearer ${key}`);
  }
  const settings = await get<{ models: { id: string; modelId: string }[] }>('/api/settings');
  expect(settings.models.map(model => [model.id, model.modelId])).toEqual([['first', 'same-upstream'], ['second', 'same-upstream']]);
}, 120_000);

test('the real CLI starts with an unlimited default and rejects zero or negative defaults before serving', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-config-startup-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  const document = { version: 1, projects: [{ id: 'p', root }], limits: { defaultBudgetTokens: null as number | null } };
  await writeFile(configPath, JSON.stringify(document));
  const options = { configPath, env: { PI_CODING_AGENT_DIR: join(root, 'pi') } };
  const ready = await launchCli(root, options);
  cleanup.push(() => ready.close());
  const response = await ready.request('/api/config');
  expect(response.status).toBe(200);
  expect((await response.json() as { config: { limits: { defaultBudgetTokens: number | null } } }).config.limits)
    .toMatchObject({ defaultBudgetTokens: null });
  await ready.close();
  for (const tokens of [0, -1]) {
    await writeFile(configPath, JSON.stringify({ ...document, limits: { defaultBudgetTokens: tokens } }));
    let failure: unknown;
    try {
      const unexpected = await launchCli(root, options);
      cleanup.push(() => unexpected.close());
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('CLI exited before startup (1)');
    expect(message).toContain('limits.defaultBudgetTokens');
    expect(message).toContain('positive integer');
  }
}, 60_000);
