import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * A project that leaves the configuration keeps its history and stops taking
 * work.
 *
 * Removing a project from the configuration is not a deletion: the tasks that
 * ran in it stay readable, because their history is what the operator still
 * needs. What changes is that the project is gone from the console and that
 * new work for it is refused, instead of being silently accepted and lost.
 *
 * The proof is the real Go process and the real configuration file.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-removed-project-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const other = join(root, 'other-project');
  await mkdir(project, { recursive: true });
  await mkdir(other, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await openaiServer(Array.from({ length: 8 }, () => ({ text: 'Working on it.' })));
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }, { id: 'q', root: other }],
    credentials: { local: { secretRef: 'GRAPH_REMOVED_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_REMOVED_KEY: 'synthetic-removed-key' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  return { root, configPath, daemon, request };
}

test('a project removed from the configuration keeps its history and refuses new work', async () => {
  const f = await fixture();

  const begun = await f.request('/api/tasks', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', request: 'Work in the project that goes away', requestId: 'begin' }),
  });
  expect(begun.status, JSON.stringify(begun.body)).toBe(200);
  const taskId = (begun.body as { taskId: string }).taskId;

  // The project leaves the configuration.
  const document = JSON.parse(await readFile(f.configPath, 'utf8')) as {
    projects: { id: string; root: string }[];
  };
  document.projects = document.projects.filter(entry => entry.id !== 'p');
  const saved = await f.request('/api/config', {
    method: 'POST', body: JSON.stringify({ expectedRevision: 0, document }),
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body as { applied?: boolean }).toMatchObject({ applied: true });

  // The console no longer offers the project.
  const settings = await f.request('/api/settings');
  const projects = (settings.body as { projects: { id: string }[] }).projects.map(entry => entry.id);
  expect(projects).not.toContain('p');
  expect(projects).toContain('q');

  // Its history is still readable.
  const list = await f.request('/api/tasks');
  const tasks = list.body as { id: string; request: string }[];
  expect(tasks.some(task => task.id === taskId && task.request === 'Work in the project that goes away')).toBe(true);
  const view = await f.request(`/api/tasks/${taskId}`);
  expect(view.status).toBe(200);
  expect((view.body as { request?: string }).request).toBe('Work in the project that goes away');

  // And new work for it is refused instead of silently accepted.
  const refused = await f.request('/api/tasks', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', request: 'Work that can no longer start', requestId: 'begin-2' }),
  });
  expect(refused.status).toBe(400);
  expect((refused.body as { code?: string; message?: string }).code).toBe('invalid_input');
  expect((refused.body as { message?: string }).message).toContain('no longer part of the current configuration');
}, 60_000);
