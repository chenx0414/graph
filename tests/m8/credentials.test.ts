import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { openConfigStore, sanitizeConfig } from '../../src/server/config-service.ts';
import { loadGraphConfig } from '../../src/server/config.ts';
import { startGraphDaemon } from '../../src/server/start.ts';
import type { ModelEntry } from '../../src/catalog/models.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});
const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function entry(id: string, provider: string, baseUrl: string): ModelEntry {
  return { id, provider, grade: 'high', api: 'openai-completions', baseUrl, contextWindow: 32_000, maxTokens: 256 };
}

const checkAction = (root: string) => ({
  check: {
    kind: 'program' as const,
    prepare: async () => async () => ({
      outcome: 'completed' as const,
      output: null,
      evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: join(root, 'ok.txt'), digest: 'a'.repeat(64) } }],
    }),
  },
});

async function runOneTask(runtime: Awaited<ReturnType<typeof openTaskRuntime>>, model: string, request: string) {
  const { taskId } = await runtime.user.begin({ projectId: 'project', request, requestId: `begin-${request}` });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: request,
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, `proposal-${request}`);
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: `accept-${request}` });
  await runtime.host.runReady();
  await runtime.host.runReady();
  return taskId;
}

test('two local endpoints receive their own credentials and a model switch cannot cross keys', async () => {
  const root = await temp('credentials');
  const providerA = await openaiServer([{ text: 'Alpha result' }]);
  cleanup.push(() => providerA.close());
  const providerB = await openaiServer([{ text: 'Beta result' }]);
  cleanup.push(() => providerB.close());
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const alpha = { ...providerA.model, id: 'alpha', provider: 'graph-alpha' };
  const beta = { ...providerB.model, id: 'beta', provider: 'graph-beta' };
  modelRuntime.registerProvider('graph-alpha', { baseUrl: alpha.baseUrl, api: 'openai-completions', apiKey: 'key-alpha', models: [alpha] });
  modelRuntime.registerProvider('graph-beta', { baseUrl: beta.baseUrl, api: 'openai-completions', apiKey: 'key-beta', models: [beta] });

  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    models: {
      entries: [entry('alpha', 'graph-alpha', alpha.baseUrl), entry('beta', 'graph-beta', beta.baseUrl)],
      apiKey: 'legacy-fallback-never-used',
      modelRuntime,
      credentialFor: model => model.id === 'alpha' ? { credentialId: 'cred-alpha', apiKey: 'key-alpha' } : { credentialId: 'cred-beta', apiKey: 'key-beta' },
    },
    actions: checkAction(root),
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  await runOneTask(runtime, 'alpha', 'Alpha task');
  await runOneTask(runtime, 'beta', 'Beta task');
  expect(providerA.authorizations).toEqual(['Bearer key-alpha']);
  expect(providerB.authorizations).toEqual(['Bearer key-beta']);
});

test('a model without a resolvable credential is refused before any provider request', async () => {
  const root = await temp('missing-credential');
  const provider = await openaiServer([{ text: 'never sent' }]);
  cleanup.push(() => provider.close());
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const bound = { ...provider.model, id: 'bound', provider: 'graph-alpha' };
  modelRuntime.registerProvider('graph-alpha', { baseUrl: bound.baseUrl, api: 'openai-completions', apiKey: 'key', models: [bound] });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    models: { entries: [entry('bound', 'graph-alpha', bound.baseUrl)], modelRuntime, credentialFor: () => undefined },
    actions: checkAction(root),
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const taskId = await runOneTask(runtime, 'bound', 'No key');
  expect(provider.requests).toHaveLength(0);
  const view = await runtime.user.task(taskId).view();
  const node = view.nodes.find(candidate => candidate.id === 'work');
  expect(node?.status).not.toBe('completed');
  expect(JSON.stringify(view)).toContain('No credential bound');
});

test('config saves are atomic, versioned and never leak secrets', async () => {
  const dir = await temp('config-store');
  const path = join(dir, 'graph.config.json');
  const document = {
    version: 1,
    projects: [{ id: 'sample', root: dir }],
    models: { entries: [{ id: 'local', provider: 'local', grade: 'medium', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', contextWindow: 1000, maxTokens: 100, credentialId: 'local' }] },
    credentials: { local: { secretRef: 'GRAPH_SECRET_REF' } },
    limits: { credentials: { local: 2 } },
  };
  await writeFile(path, JSON.stringify({ ...document, revision: 0 }, null, 2));
  const store = await openConfigStore(path);
  expect((await store.snapshot()).revision).toBe(0);

  const saved = await store.save({ ...document, projects: [{ id: 'sample', root: dir }, { id: 'second', root: dir }] }, 0);
  expect(saved.revision).toBe(1);
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ revision: 1 });
  expect(await store.snapshot()).toMatchObject({ revision: 1 });
  expect((await store.snapshot()).config.projects).toHaveLength(2);

  const before = await readFile(path, 'utf8');
  await expect(store.save({ ...document, projects: [{ id: 'conflict', root: dir }] }, 0)).rejects.toMatchObject({ code: 'config_conflict' });
  expect(await readFile(path, 'utf8')).toBe(before);
  await expect(store.save({ ...document, models: { entries: [{ ...document.models.entries[0]!, grade: 'urgent' }] } }, 1)).rejects.toMatchObject({ code: 'invalid_config' });
  expect(await readFile(path, 'utf8')).toBe(before);

  await store.save({ ...document, projects: [], credentials: { local: { secretRef: 'GRAPH_SECRET_REF' } }, models: document.models, limits: document.limits }, 1);
  const loaded = await loadGraphConfig(path);
  const env = { GRAPH_SECRET_REF: 'super-secret-value' };
  const sanitized = JSON.stringify(sanitizeConfig(loaded, env));
  expect(sanitized).not.toContain('super-secret-value');
  expect(sanitized).toContain('"configured":true');
  expect(sanitized).toContain('GRAPH_SECRET_REF');
});

test('the config API round-trips a sanitized document, requires the current revision, and reports restart', async () => {
  const dir = await temp('config-api');
  const web = join(dir, 'web');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(web, { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><html><body><div id="root">Graph</div></body></html>');
  const path = join(dir, 'graph.config.json');
  const document = {
    version: 1,
    projects: [{ id: 'sample', root: dir }],
    credentials: { local: { secretRef: 'GRAPH_SECRET_REF' } },
  };
  await writeFile(path, JSON.stringify(document, null, 2));
  const daemon = await startGraphDaemon({ configPath: path, stateDir: join(dir, 'state'), webDir: web, port: 0, mode: 'view', env: { GRAPH_SECRET_REF: 'super-secret-value' }, log: () => undefined });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const cookie = home.headers.get('set-cookie') ?? '';
  const headers = { origin: daemon.url, cookie, 'content-type': 'application/json' };
  const configText = await (await fetch(`${daemon.url}/api/config`, { headers })).text();
  expect(configText).not.toContain('super-secret-value');
  expect(JSON.parse(configText)).toMatchObject({ revision: 0, config: { credentials: { local: { secretRef: 'GRAPH_SECRET_REF', configured: true } } } });
  const stale = await fetch(`${daemon.url}/api/config`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 5, document }) });
  expect(stale.status).toBe(400);
  expect(await stale.json()).toMatchObject({ code: 'config_conflict' });
  const saved = await fetch(`${daemon.url}/api/config`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 0, document: { ...document, projects: [{ id: 'sample', root: dir }] } }) });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ revision: 1, restartRequired: true });
});

test('new tasks record the configuration revision that was in effect', async () => {
  const root = await temp('revision');
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    config: { revision: () => 7 },
  });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Record revision', requestId: 'begin' });
  const created = runtime.events(taskId, 0).find(event => event.type === 'task.created');
  expect(created?.data).toMatchObject({ request: 'Record revision', configRevision: 7 });
  expect(usage).toBeDefined();
});
