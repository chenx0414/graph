import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadGraphConfig, parseGraphConfig, resolveCredentialSecret } from '../../src/server/config.ts';
import { startGraphDaemon, type GraphDaemon } from '../../src/server/start.ts';
import { parseArgs } from '../../src/server/cli.ts';
import { RuntimeError } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeWeb(dir: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><body><div id="root">Graph</div></body></html>');
  return dir;
}

async function configFile(dir: string, extra: Record<string, unknown>) {
  const path = join(dir, 'graph.config.json');
  await writeFile(path, JSON.stringify({ version: 1, ...extra }, null, 2));
  return path;
}

const SECRET_ENV = { GRAPH_TEST_KEY: 'synthetic-secret' };

function modelConfig() {
  return {
    models: {
      entries: [{
        id: 'local', provider: 'fixture', grade: 'medium', api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9/v1', contextWindow: 1000, maxTokens: 100, credentialId: 'local',
      }],
    },
    credentials: { local: { secretRef: 'GRAPH_TEST_KEY' } },
    limits: { credentials: { local: 2 } },
  };
}

async function session(url: string) {
  const home = await fetch(url, { headers: { origin: url } });
  const cookie = home.headers.get('set-cookie') ?? '';
  const headers = { origin: url, cookie, 'content-type': 'application/json' };
  return { get: (path: string) => fetch(`${url}${path}`, { headers }), home };
}

test('config parsing rejects unknown references and resolves relative project roots', async () => {
  const dir = await temp('config');
  const config = parseGraphConfig({
    version: 1,
    projects: [{ id: 'a', root: './project' }],
    ...modelConfig(),
  }, join(dir, 'graph.config.json'));
  expect(config.projects[0]!.root).toBe(resolve(dir, 'project'));
  expect(config.models!.entries[0]!.credentialId).toBe('local');
  const withThinking = parseGraphConfig({
    version: 1,
    ...modelConfig(),
    models: { entries: [{ ...modelConfig().models.entries[0]!, defaultThinkingLevel: 'high' }] },
  }, join(dir, 'graph.config.json'));
  expect(withThinking.models!.entries[0]!.defaultThinkingLevel).toBe('high');

  const base = { version: 1, projects: [], ...modelConfig() };
  expect(() => parseGraphConfig({ ...base, credentials: {} }, 'x')).toThrowError(/unknown credential/);
  expect(() => parseGraphConfig({ ...base, models: { entries: [{ ...modelConfig().models.entries[0]!, grade: 'urgent' }] } }, 'x')).toThrowError(/grade/);
  expect(() => parseGraphConfig({ ...base, credentials: { local: { secretRef: 'not a name' } } }, 'x')).toThrowError(/secretRef/);
  expect(() => parseGraphConfig({ ...base, limits: { credentials: { missing: 1 } } }, 'x')).toThrowError(/unknown credential/);
  expect(() => parseGraphConfig({ ...base, models: { entries: [modelConfig().models.entries[0]!, modelConfig().models.entries[0]!] } }, 'x')).toThrowError(/duplicate model/);
  expect(() => parseGraphConfig({ ...base, models: { entries: [{ ...modelConfig().models.entries[0]!, defaultThinkingLevel: 'extreme' }] } }, 'x')).toThrowError(/defaultThinkingLevel/);
  expect(() => parseGraphConfig({ version: 2 }, 'x')).toThrowError(/version must be 1/);
});

test('credential secrets resolve from the referenced environment variable only', async () => {
  const dir = await temp('secret');
  const path = await configFile(dir, modelConfig());
  const config = await loadGraphConfig(path);
  expect(resolveCredentialSecret(config, 'local', SECRET_ENV)).toEqual({ configured: true, secretRef: 'GRAPH_TEST_KEY', value: 'synthetic-secret' });
  expect(resolveCredentialSecret(config, 'local', {})).toEqual({ configured: false, secretRef: 'GRAPH_TEST_KEY' });
});

test('view-only start serves the real page, reports startup state, and has zero model dispatch', async () => {
  const dir = await temp('view');
  const web = await fakeWeb(join(dir, 'web'));
  const path = await configFile(dir, { projects: [{ id: 'sample', root: dir }], ...modelConfig() });
  const daemon = await startGraphDaemon({ configPath: path, stateDir: join(dir, 'state'), webDir: web, port: 0, mode: 'view', env: SECRET_ENV, log: () => undefined });
  cleanup.push(() => daemon.close());
  expect(daemon.configured).toBe(true);
  expect(daemon.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const api = await session(daemon.url);
  const cookie = api.home.headers.get('set-cookie') ?? '';
  expect(await (await fetch(`${daemon.url}/`)).text()).toContain('id="root"');
  expect(await (await api.get('/api/startup')).json()).toMatchObject({ mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 });
  const { taskId } = await (await fetch(`${daemon.url}/api/tasks`, {
    method: 'POST', headers: { origin: daemon.url, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'sample', request: 'View only', requestId: 'begin' }),
  })).json() as { taskId: string };
  await new Promise(resolve => setTimeout(resolve, 100));
  const view = await (await api.get(`/api/tasks/${taskId}`)).json() as { status: string };
  expect(view.status).toBe('discussing');
});

test('the daemon seeds and compiles the Main Agent recipe for the resource library', async () => {
  const dir = await temp('main-recipe');
  const web = await fakeWeb(join(dir, 'web'));
  const graphHome = join(dir, 'graph-home');
  const path = await configFile(dir, { projects: [] });
  const daemon = await startGraphDaemon({
    configPath: path,
    stateDir: join(dir, 'state'),
    graphHome,
    webDir: web,
    port: 0,
    mode: 'view',
    env: {},
    log: () => undefined,
  });
  cleanup.push(() => daemon.close());
  const combinations = daemon.server.runtime.catalog.agentCombinations();
  expect(combinations).toEqual([
    expect.objectContaining({
      id: 'main',
      mode: 'main',
      status: 'valid',
      resources: [],
    }),
  ]);
  expect(daemon.server.runtime.catalog.definitions()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'main', version: 1 }),
  ]));
  const api = await session(daemon.url);
  const settings = await (await api.get('/api/settings')).json() as { agentCombinations: { id: string; mode?: string }[] };
  expect(settings.agentCombinations).toEqual([
    expect.objectContaining({ id: 'main', mode: 'main' }),
  ]);
});

test('restart keeps the same explicit state directory and its tasks', async () => {
  const dir = await temp('restart');
  const web = await fakeWeb(join(dir, 'web'));
  const path = await configFile(dir, { projects: [{ id: 'sample', root: dir }] });
  const stateDir = join(dir, 'state');
  let daemon = await startGraphDaemon({ configPath: path, stateDir, webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined });
  cleanup.push(() => daemon.close());
  const first = await session(daemon.url);
  await fetch(`${daemon.url}/api/tasks`, {
    method: 'POST', headers: { origin: daemon.url, cookie: first.home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'sample', request: 'Persist me', requestId: 'begin-1' }),
  });
  await daemon.close();
  daemon = await startGraphDaemon({ configPath: path, stateDir, webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined });
  cleanup.push(() => daemon.close());
  expect(daemon.stateDir).toBe(await realpathOf(stateDir));
  const second = await session(daemon.url);
  const tasks = await (await second.get('/api/tasks')).json() as { id: string; phase: string }[];
  expect(tasks).toHaveLength(1);
});

async function realpathOf(path: string) {
  const { realpath } = await import('node:fs/promises');
  return realpath(path);
}

test('a second daemon on the same state directory is rejected by the owner lock', async () => {
  const dir = await temp('owner');
  const web = await fakeWeb(join(dir, 'web'));
  const path = await configFile(dir, { projects: [] });
  const stateDir = join(dir, 'state');
  const first = await startGraphDaemon({ configPath: path, stateDir, webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined });
  cleanup.push(() => first.close());
  await expect(startGraphDaemon({ configPath: path, stateDir, webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined }))
    .rejects.toMatchObject({ code: 'owner_busy' });
});

test('missing web build, missing config, busy port and execution gaps fail with explicit codes', async () => {
  const dir = await temp('errors');
  const web = await fakeWeb(join(dir, 'web'));
  const path = await configFile(dir, { projects: [] });

  await expect(startGraphDaemon({ configPath: path, stateDir: join(dir, 's1'), webDir: join(dir, 'missing'), port: 0, mode: 'view', env: {}, log: () => undefined }))
    .rejects.toMatchObject({ code: 'web_build_missing' });
  await expect(startGraphDaemon({ configPath: join(dir, 'nope.json'), stateDir: join(dir, 's2'), webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined }))
    .rejects.toMatchObject({ code: 'invalid_config' });
  await expect(startGraphDaemon({ configPath: path, stateDir: join(dir, 's3'), webDir: web, port: 0, mode: 'execute', env: {}, log: () => undefined }))
    .rejects.toMatchObject({ code: 'models_missing' });

  const modelPath = await configFile(join(await temp('missing-key')), modelConfig());
  await expect(startGraphDaemon({ configPath: modelPath, stateDir: join(dir, 's4'), webDir: web, port: 0, mode: 'execute', env: {}, log: () => undefined }))
    .rejects.toMatchObject({ code: 'credentials_missing' });

  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', () => resolve()));
  cleanup.push(() => new Promise<void>(resolve => blocker.close(() => resolve())));
  const port = (blocker.address() as { port: number }).port;
  await expect(startGraphDaemon({ configPath: path, stateDir: join(dir, 's5'), webDir: web, port, mode: 'view', env: {}, log: () => undefined }))
    .rejects.toMatchObject({ code: 'port_in_use' });

  const leftover = await new Promise<RuntimeError | null>(resolve => {
    startGraphDaemon({ configPath: path, stateDir: join(dir, 's5'), webDir: web, port: 0, mode: 'view', env: {}, log: () => undefined })
      .then(daemon => daemon.close().then(() => resolve(null)))
      .catch(error => resolve(error as RuntimeError));
  });
  expect(leftover).toBeNull();
});

test('CLI argument parsing defaults stay explicit and reject bad input', () => {
  const cwd = '/tmp/graph-cli-test';
  const parsed = parseArgs([], { HOME: '/root-home' }, cwd);
  expect(parsed).toMatchObject({ configPath: null, mode: 'view', port: 4173, webDir: join(cwd, 'dist', 'web') });
  expect(parsed.stateDir).toBe(join('/root-home', '.local', 'state', 'graph'));
  expect(parseArgs(['--execute', '--port', '8080'], {}, cwd)).toMatchObject({ mode: 'execute', port: 8080 });
  expect(parseArgs(['--config', 'custom.json', '--state-dir', 's'], {}, cwd).configPath).toBe(join(cwd, 'custom.json'));
  expect(() => parseArgs(['--port', 'abc'], {}, cwd)).toThrowError(/Invalid port/);
  expect(() => parseArgs(['--unknown'], {}, cwd)).toThrowError(/Unknown argument/);
  expect(() => parseArgs(['--execute', '--view-only'], {}, cwd)).toThrowError(/mutually exclusive/);
});

test('the CLI entry starts, prints its address, and stops cleanly on SIGTERM', async () => {
  const dir = await temp('cli');
  const web = await fakeWeb(join(dir, 'web'));
  const path = await configFile(dir, { projects: [{ id: 'sample', root: dir }] });
  const child = spawn(process.execPath, ['src/server/cli.ts', '--config', path, '--state-dir', join(dir, 'state'), '--web-dir', web, '--port', '0'], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanup.push(() => { child.kill('SIGKILL'); });
  const stdout: string[] = [];
  let url: string | null = null;
  const deadline = Date.now() + 20_000;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout.push(chunk);
    const match = /address:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(stdout.join(''));
    if (match && !url) url = match[1]!;
  });
  while (!url && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  expect(url, stdout.join('')).not.toBeNull();
  expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ ok: true });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  child.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 10_000))]);
  expect(code).toBe(0);
});
