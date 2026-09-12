import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openGraphServer } from '../../src/server/host.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function session(url: string) {
  const home = await fetch(url, { headers: { origin: url } });
  const cookie = home.headers.get('set-cookie') ?? '';
  const headers = { origin: url, cookie, 'content-type': 'application/json' };
  return {
    get: (path: string) => fetch(`${url}${path}`, { headers }),
    post: (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  };
}

test('stopping and reopening the HTTP host keeps pause, rejects duplicate begins, and resumes from the event cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m6-host-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'project', root }], autoDrive: false as const };
  let server = await openGraphServer(options);
  cleanup.push(async () => { try { await server.close(); } catch { /* already closed */ } });
  let api = await session(server.url);
  const begun = await (await api.post('/api/tasks', { projectId: 'project', request: 'Host restart', requestId: 'begin' })).json() as { taskId: string };
  expect(await (await api.post('/api/tasks', { projectId: 'project', request: 'Host restart', requestId: 'begin' })).json()).toEqual(begun);
  const paused = await api.post(`/api/tasks/${begun.taskId}/pause`, { requestId: 'pause' });
  expect(paused.status).toBe(200);
  const events = await (await api.get(`/api/tasks/${begun.taskId}/events?after=0`)).json() as { cursor: number; type: string }[];
  const cursor = events[events.length - 1]!.cursor;
  expect((await (await api.get(`/api/tasks/${begun.taskId}`)).json() as { status: string }).status).toBe('paused');
  await server.close();
  server = await openGraphServer(options);
  api = await session(server.url);
  const restored = await (await api.get(`/api/tasks/${begun.taskId}`)).json() as { status: string; id: string };
  expect(restored).toMatchObject({ id: begun.taskId, status: 'paused' });
  const later = await (await api.get(`/api/tasks/${begun.taskId}/events?after=${cursor}`)).json() as { type: string }[];
  const replay = await (await api.get(`/api/tasks/${begun.taskId}/events?after=${cursor}`)).json() as { type: string }[];
  expect(later).toEqual(replay);
  expect(later.every(event => event.type !== 'task.created')).toBe(true);
  await api.post(`/api/tasks/${begun.taskId}/resume`, { requestId: 'resume' });
  expect((await (await api.get(`/api/tasks/${begun.taskId}`)).json() as { status: string }).status).toBe('discussing');
});
