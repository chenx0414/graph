import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * The task surface of the Go backend, over real HTTP.
 *
 * A user opens the console, starts a task, talks to it and reads it back. The
 * contract is that the HTTP surface answers with the same facts the task
 * runtime holds: the task is listed, the view carries the request and the
 * messages, and the event cursor of a task reconnects where the client left
 * off. The command channel is closed to a call without a session and to a call
 * from a foreign origin.
 *
 * The proof is a real executable, a real loopback socket and a real state
 * directory: the process under test is the Go backend, not a stand-in.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-task-http-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  // The master answers with text: this file proves the HTTP surface, not the
  // agent loop, so the model only has to be a real reachable provider.
  const provider = await openaiServer(Array.from({ length: 8 }, () => ({ text: 'Working on it.' })));
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_TASK_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high',
      api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256,
      credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_TASK_KEY: 'synthetic-task-key' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  return { root, project, daemon, request };
}

test('the Go task surface starts a task, lists it and reads it back', async () => {
  const f = await fixture();

  const begun = await f.request('/api/tasks', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', request: 'Add search', requestId: 'begin' }),
  });
  expect(begun.status, JSON.stringify(begun.body)).toBe(200);
  const taskId = (begun.body as { taskId: string }).taskId;
  expect(taskId).toBeTruthy();

  const said = await f.request(`/api/tasks/${taskId}/say`, {
    method: 'POST', body: JSON.stringify({ text: 'Case insensitive', requestId: 'say' }),
  });
  expect(said.status, JSON.stringify(said.body)).toBe(200);

  const list = await f.request('/api/tasks');
  expect(list.status).toBe(200);
  const tasks = list.body as { id: string; request: string; phase: string }[];
  expect(tasks.some(task => task.id === taskId && task.request === 'Add search')).toBe(true);

  const view = await f.request(`/api/tasks/${taskId}`);
  expect(view.status).toBe(200);
  const task = view.body as { id: string; request: string; messages: { text: string }[] };
  expect(task.id).toBe(taskId);
  expect(task.request).toBe('Add search');
  // The conversation of the task starts with the request itself and keeps every
  // message the user sent to it.
  expect(task.messages.map(message => message.text)).toEqual(['Add search', 'Case insensitive']);
}, 60_000);

test('the Go task event cursor reconnects where the client left off', async () => {
  const f = await fixture();

  const begun = await f.request('/api/tasks', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', request: 'Work', requestId: 'begin' }),
  });
  const taskId = (begun.body as { taskId: string }).taskId;

  const first = await f.request(`/api/tasks/${taskId}/events?after=0`);
  expect(first.status).toBe(200);
  const events = first.body as { cursor: number; type: string }[];
  expect(events.some(event => event.type === 'task.created')).toBe(true);
  const cursor = events[events.length - 1]!.cursor;

  await f.request(`/api/tasks/${taskId}/say`, {
    method: 'POST', body: JSON.stringify({ text: 'More detail', requestId: 'say' }),
  });

  const again = await f.request(`/api/tasks/${taskId}/events?after=${cursor}`);
  const later = again.body as { cursor: number; type: string }[];
  expect(later.some(event => event.type === 'requirement.changed')).toBe(true);
  // The cursor only moves forward: a reconnect never replays what it already read.
  expect(later.every(event => event.cursor > cursor)).toBe(true);
}, 60_000);

test('the Go task channel is closed to an anonymous or foreign caller', async () => {
  const f = await fixture();

  const begun = await f.request('/api/tasks', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', request: 'Work', requestId: 'begin' }),
  });
  const taskId = (begun.body as { taskId: string }).taskId;

  // No session cookie: the command channel does not answer.
  const anonymous = await fetch(`${f.daemon.url}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'p', request: 'No cookie', requestId: 'x' }),
  });
  expect(anonymous.status).toBe(401);

  // A foreign origin cannot use the channel either, read or write.
  const foreign = await fetch(`${f.daemon.url}/api/tasks/${taskId}/answer`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json',
      cookie: (await fetch(f.daemon.url)).headers.get('set-cookie') ?? '' },
    body: JSON.stringify({ questionId: 'x', answer: { type: 'acknowledge' }, requestId: 'forge' }),
  });
  expect(foreign.status).toBeGreaterThanOrEqual(400);
}, 60_000);
