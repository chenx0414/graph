import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { launchCli } from '../helpers/cli-daemon.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('real config saves preserve model metadata and independent upstream connections while invalid candidates leave disk unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-config-contracts-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const first = await openaiServer([{ text: 'first connection' }]);
  const second = await openaiServer([{ text: 'second connection' }]);
  cleanup.push(() => first.close(), () => second.close());
  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  const entry = { id: 'first', provider: 'platform-first', modelId: 'same-upstream', grade: 'high', api: 'openai-completions', baseUrl: first.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'first' };
  const initial = { version: 1, projects: [{ id: 'p', root }], credentials: { first: { secretRef: 'GRAPH_FIRST_KEY' }, second: { secretRef: 'GRAPH_SECOND_KEY', platform: 'opencode-go', displayName: 'Second account' } }, models: { entries: [entry, { ...entry, id: 'second', provider: 'platform-second', baseUrl: second.model.baseUrl, credentialId: 'second', input: ['text', 'image'], reasoning: false }] } };
  await writeFile(configPath, JSON.stringify(initial));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir, port: 0, mode: 'execute', dynamic: true, env: { HOME: root, GRAPH_FIRST_KEY: 'first-key', GRAPH_SECOND_KEY: 'second-key' }, log: () => undefined });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const get = async (path: string) => (await fetch(`${daemon.url}${path}`, { headers })).json();
  const post = (path: string, body: unknown) => fetch(`${daemon.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const observed = await get('/api/config');
  expect(observed.config.credentials.second).toMatchObject({ platform: 'opencode-go', displayName: 'Second account', secretRef: 'GRAPH_SECOND_KEY' });
  expect(observed.config.credentials.first).not.toHaveProperty('platform');
  expect(observed.config.models.entries).toMatchObject([{ id: 'first', reasoning: true }, { id: 'second', input: ['text', 'image'], reasoning: false }]);
  expect(observed.config.models.entries[0]).not.toHaveProperty('input');
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
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain(candidate.reason);
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect((await get('/api/config')).revision).toBe(0);
  }
  for (const [model, provider, key] of [['first', first, 'first-key'], ['second', second, 'second-key']] as const) {
    const response = await post('/api/conversations', { text: `Use ${model} endpoint`, model, requestId: model });
    expect(response.status).toBe(200);
    const created = await response.json() as { taskId: string };
    await expect.poll(async () => (await get(`/api/tasks/${created.taskId}`)).invocations[0]?.cost, { timeout: 20000 }).toEqual({ unknown: true });
    const sent = provider.requests.find(request => {
      const body = request as { tools?: unknown[]; messages?: { role: string; content: unknown }[] };
      return Boolean(body.tools?.length) && body.messages?.some(message => message.role === 'user' && JSON.stringify(message.content).includes(`Use ${model} endpoint`));
    });
    expect(sent).toMatchObject({ model: 'same-upstream' });
    const index = provider.requests.indexOf(sent);
    expect(provider.authorizations[index]).toBe(`Bearer ${key}`);
  }
  expect((await get('/api/settings')).models.map((model: { id: string; modelId: string }) => [model.id, model.modelId])).toEqual([['first', 'same-upstream'], ['second', 'same-upstream']]);
}, 90_000);

// A ready daemon is the positive control; the same executable must refuse invalid startup policies.
test('the real CLI starts with an unlimited default and rejects zero or negative defaults before serving', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-config-startup-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  const document = { version: 1, projects: [{ id: 'p', root }], limits: { defaultBudgetTokens: null as number | null } };
  await writeFile(configPath, JSON.stringify(document));
  const options = { configPath, env: { PI_CODING_AGENT_DIR: join(root, 'pi') } };
  const ready = await launchCli(root, options);
  cleanup.push(() => ready.close());
  const response = await ready.request('/api/config');
  expect(response.status).toBe(200);
  expect((await response.json() as { config: { limits: unknown } }).config.limits).toMatchObject({ defaultBudgetTokens: null });
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
