import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { ensureBackendBinary } from '../helpers/backend-binary.ts';
import { findGraphd, graphdSearchStarts } from '../../src/server/go-launch.ts';

/**
 * How the daemon starts, and how it refuses to start.
 *
 * The daemon is the product's only front door: the console, the desktop app
 * and every script talk to it. A refusal has to name what is wrong, because
 * the person who started it has to be able to fix it; a start has to say
 * where it listens, because everything else is written against that address.
 *
 * The proof is the real binary: the arguments it rejects, the codes it
 * refuses with, the page it serves, the state it keeps and the lock it holds.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

const SECRET_ENV = { GRAPH_TEST_KEY: 'synthetic-secret' };

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-e2e-go-startup-${name}-`));
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

/** The binary the suite drives. */
function backendBinary(): string {
  ensureBackendBinary();
  return findGraphd([process.cwd(), resolve(process.cwd()), ...graphdSearchStarts()]);
}

/** Run the binary once and read what it said. */
function runBinary(args: string[], env: Record<string, string> = {}) {
  const child = spawnSync(backendBinary(), args, { encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: child.status ?? -1, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}

test('the real Go CLI rejects invalid arguments before starting an application', () => {
  for (const [args, reason] of [
    [['--port', 'abc'], /Invalid port/],
    [['--unknown'], /Unknown argument/],
    [['--execute', '--view-only'], /mutually exclusive/],
  ] as const) {
    const child = runBinary([...args]);
    expect(child.status, `${args.join(' ')}: ${child.stderr}`).toBe(2);
    expect(child.stderr).toMatch(reason);
  }
}, 60_000);

test('missing web build, missing config, execution gaps and a busy port fail with explicit codes', async () => {
  const dir = await temp('errors');
  const web = await fakeWeb(join(dir, 'web'));
  const path = await configFile(dir, { projects: [] });

  // The console was never built.
  const webMissing = runBinary(['--state-dir', join(dir, 's1'), '--web-dir', join(dir, 'missing'), '--port', '0']);
  expect(webMissing.status, webMissing.stderr).toBe(1);
  expect(webMissing.stderr).toMatch(/web_build_missing/);

  // There is no configuration to serve.
  const configMissing = runBinary(['--config', join(dir, 'nope.json'), '--state-dir', join(dir, 's2'), '--web-dir', web, '--port', '0']);
  expect(configMissing.status, configMissing.stderr).toBe(1);
  expect(configMissing.stderr).toMatch(/invalid_config/);

  // Execution without a model.
  const modelsMissing = runBinary(['--config', path, '--state-dir', join(dir, 's3'), '--web-dir', web, '--port', '0', '--execute']);
  expect(modelsMissing.status, modelsMissing.stderr).toBe(1);
  expect(modelsMissing.stderr).toMatch(/models_missing/);

  // Execution with a model but without its key.
  const modelPath = await configFile(await temp('missing-key'), modelConfig());
  const credentialsMissing = runBinary(['--config', modelPath, '--state-dir', join(dir, 's4'), '--web-dir', web, '--port', '0', '--execute']);
  expect(credentialsMissing.status, credentialsMissing.stderr).toBe(1);
  expect(credentialsMissing.stderr).toMatch(/credentials_missing/);

  // The address is taken.
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', () => resolve()));
  cleanup.push(() => new Promise<void>(resolve => blocker.close(() => resolve())));
  const port = (blocker.address() as { port: number }).port;
  const busy = runBinary(['--config', path, '--state-dir', join(dir, 's5'), '--web-dir', web, '--port', String(port)]);
  expect(busy.status, busy.stderr).toBe(1);
  expect(busy.stderr).toMatch(/port_in_use/);
}, 120_000);

test('view-only start serves the real page, reports startup state and dispatches nothing', async () => {
  const dir = await temp('view');
  const web = await fakeWeb(join(dir, 'web'));
  const path = await configFile(dir, { projects: [{ id: 'sample', root: dir }], ...modelConfig() });
  const daemon = await launchCli(dir, { configPath: path, env: SECRET_ENV });
  cleanup.push(() => daemon.close());

  // The console is served, not a placeholder.
  const page = await fetch(daemon.url);
  expect(await page.text()).toContain('id="root"');

  // The startup state names the mode and the models it can reach.
  const startup = await daemon.request('/api/startup');
  expect(startup.status).toBe(200);
  expect(await startup.json()).toMatchObject({ mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 });

  // A task in view-only mode is discussed, never dispatched.
  const created = await daemon.request('/api/tasks', {
    method: 'POST', body: JSON.stringify({ projectId: 'sample', request: 'View only', requestId: 'begin' }),
  });
  const taskId = (await created.json() as { taskId: string }).taskId;
  await new Promise(resolve => setTimeout(resolve, 500));
  const view = await daemon.request(`/api/tasks/${taskId}`);
  expect((await view.json() as { status: string }).status).toBe('discussing');
}, 120_000);

test('a rebuilt web bundle is served without a daemon restart', async () => {
  const dir = await temp('web-rebuild');
  const web = await fakeWeb(join(dir, 'web'));
  const path = await configFile(dir, { projects: [], ...modelConfig() });
  const daemon = await launchCli(dir, { configPath: path, env: SECRET_ENV });
  cleanup.push(() => daemon.close());
  expect(await (await fetch(daemon.url)).text()).toContain('id="root"');

  // A window reload is enough after a rebuild: the page is read from disk
  // like its assets, not pinned when the daemon started.
  await writeFile(join(web, 'index.html'), '<!doctype html><html><body><div id="root">Graph rebuilt</div></body></html>');
  expect(await (await fetch(daemon.url)).text()).toContain('Graph rebuilt');
}, 120_000);

test('the daemon seeds and compiles the Main Agent recipe for the resource library', async () => {
  const dir = await temp('main-recipe');
  const web = await fakeWeb(join(dir, 'web'));
  const path = await configFile(dir, { projects: [] });
  const daemon = await launchCli(dir, { configPath: path });
  cleanup.push(() => daemon.close());

  const catalog = await daemon.request('/api/catalog');
  expect(catalog.status).toBe(200);
  const definitions = (await catalog.json() as { definitions?: { id: string; version: number }[] }).definitions ?? [];
  expect(definitions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'main', version: 1 })]));

  const settings = await daemon.request('/api/settings');
  expect(settings.status).toBe(200);
  const combinations = (await settings.json() as { agentCombinations?: { id: string; mode?: string }[] }).agentCombinations ?? [];
  expect(combinations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'main', mode: 'main' })]));
}, 120_000);

test('restart keeps the same explicit state directory and its tasks', async () => {
  const dir = await temp('restart');
  const web = await fakeWeb(join(dir, 'web'));
  const path = await configFile(dir, { projects: [{ id: 'sample', root: dir }] });
  let daemon = await launchCli(dir, { configPath: path });
  cleanup.push(() => daemon.close());
  const created = await daemon.request('/api/tasks', {
    method: 'POST', body: JSON.stringify({ projectId: 'sample', request: 'Persist me', requestId: 'begin-1' }),
  });
  expect(created.status).toBe(200);
  await daemon.close();

  daemon = await launchCli(dir, { configPath: path });
  cleanup.push(() => daemon.close());
  const tasks = await daemon.request('/api/tasks');
  expect(tasks.status).toBe(200);
  expect((await tasks.json() as unknown[]).length).toBe(1);
}, 120_000);

test('a second daemon on the same state directory is rejected by the owner lock', async () => {
  const dir = await temp('owner');
  const web = await fakeWeb(join(dir, 'web'));
  const path = await configFile(dir, { projects: [] });
  const first = await launchCli(dir, { configPath: path });
  cleanup.push(() => first.close());

  // The second daemon says who owns the directory instead of writing beside it.
  const second = runBinary(['--config', path, '--state-dir', join(dir, 'state'), '--web-dir', web, '--port', '0']);
  expect(second.status, second.stderr).toBe(1);
  expect(second.stderr).toMatch(/owner_busy/);
}, 120_000);

test('the CLI entry starts, prints its address, and stops cleanly on SIGTERM', async () => {
  const dir = await temp('cli');
  const web = await fakeWeb(join(dir, 'web'));
  const path = await configFile(dir, { projects: [{ id: 'sample', root: dir }] });
  const child: ChildProcess = spawn(backendBinary(), [
    '--config', path, '--state-dir', join(dir, 'state'), '--web-dir', web, '--port', '0',
  ], { cwd: dir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanup.push(() => { child.kill('SIGKILL'); });
  const stdout: string[] = [];
  let url: string | null = null;
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    stdout.push(chunk);
    const match = /address:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(stdout.join(''));
    if (match && !url) url = match[1]!;
  });
  const deadline = Date.now() + 20_000;
  while (!url && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  expect(url, stdout.join('')).not.toBeNull();

  const health = await fetch(`${url}/api/health`);
  expect(await health.json()).toEqual({ ok: true });

  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  child.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 10_000))]);
  expect(code).toBe(0);
}, 120_000);

test('config parsing rejects unknown references and resolves relative project roots', async () => {
  const dir = await temp('config');
  const web = await fakeWeb(join(dir, 'web'));
  const base = { version: 1, projects: [], ...modelConfig() };
  const entry = modelConfig().models.entries[0];
  for (const [document, reason] of [
    [{ ...base, credentials: {} }, /references unknown credential/],
    [{ ...base, models: { entries: [{ ...entry, grade: 'urgent' }] } }, /grade must be one of/],
    [{ ...base, credentials: { local: { secretRef: 'not a name' } } }, /secretRef must be an environment variable name/],
    [{ ...base, limits: { credentials: { missing: 1 } } }, /references unknown credential/],
    [{ ...base, models: { entries: [entry, entry] } }, /duplicate model id/],
    [{ ...base, models: { entries: [{ ...entry, defaultThinkingLevel: 'extreme' }] } }, /defaultThinkingLevel/],
    [{ version: 2 }, /version must be 1/],
  ] as const) {
    const path = join(dir, 'graph.config.json');
    await writeFile(path, JSON.stringify(document));
    const refused = runBinary(['--config', path, '--state-dir', join(dir, `s-${reason.source}`), '--web-dir', web, '--port', '0']);
    expect(refused.status, `${reason}: ${refused.stderr}`).toBe(1);
    expect(refused.stderr).toMatch(reason);
  }

  // A project root that is relative is read against the configuration file.
  await mkdir(join(dir, 'project'), { recursive: true });
  const path = await configFile(dir, { projects: [{ id: 'a', root: './project' }], ...modelConfig() });
  const daemon = await launchCli(dir, { configPath: path, env: SECRET_ENV });
  cleanup.push(() => daemon.close());
  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'a', model: 'local', text: 'Where am I?', requestId: 'relative-root' }),
  });
  expect(created.status, JSON.stringify(await created.clone().text())).toBe(200);
  const conversationId = (await created.json() as { conversationId: string }).conversationId;
  const view = await daemon.request(`/api/conversations/${conversationId}`);
  const projectRoot = (await view.json() as { projectRoot?: string }).projectRoot;
  expect(projectRoot).toBe(resolve(dir, 'project'));
}, 120_000);

test('credential secrets resolve from the referenced environment variable only', async () => {
  const dir = await temp('secret');
  const web = await fakeWeb(join(dir, 'web'));
  const path = await configFile(dir, { projects: [], ...modelConfig() });

  const withSecret = await launchCli(dir, { configPath: path, env: SECRET_ENV });
  cleanup.push(() => withSecret.close());
  const configured = await withSecret.request('/api/config');
  expect(configured.status).toBe(200);
  const body = await configured.text();
  expect(JSON.parse(body)).toMatchObject({
    config: { credentials: { local: { secretRef: 'GRAPH_TEST_KEY', configured: true } } },
  });
  // The value itself never travels with the configuration.
  expect(body).not.toContain('synthetic-secret');

  // Without the environment variable the credential is not configured, and the
  // daemon says so instead of pretending it is ready.
  const other = await temp('secret-without');
  await fakeWeb(join(other, 'web'));
  const withoutSecret = await launchCli(other, { configPath: path, env: {} });
  cleanup.push(() => withoutSecret.close());
  const missing = await withoutSecret.request('/api/config');
  expect(missing.status).toBe(200);
  expect(JSON.parse(await missing.text())).toMatchObject({
    config: { credentials: { local: { secretRef: 'GRAPH_TEST_KEY', configured: false } } },
  });
}, 120_000);
