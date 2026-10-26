import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { ensureBackendBinary } from '../helpers/backend-binary.ts';

/**
 * Old work is reclaimed, and the claim about it is honest.
 *
 * The state directory grows with every event a task records. The reclaim
 * command reports what an old task's history would cost, changes nothing
 * while it reports, and - when told to - deletes exactly what it reported.
 * A task keeps the two events it is born and changed with, whatever the
 * window says, and the state directory is still a state directory afterwards:
 * the daemon opens it and the conversations are still there.
 *
 * The proof is a real daemon, a real conversation, a real task, a real
 * database and the real command line.
 */

const run = promisify(execFile);

test('the reclaim command reports what old work would cost and reclaims exactly that', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-reclaim-'));
  const webDir = join(root, 'web');
  await mkdir(webDir, { recursive: true });
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: root }] }));
  const stateDir = join(root, 'state');
  const binary = ensureBackendBinary();

  // A real daemon, a real task, a real conversation and the events they record.
  const daemon = await launchCli(root, { configPath, stateDir, webDir });
  const task = await daemon.request('/api/tasks', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', request: 'A task of its own.', requestId: 'reclaim-task' }),
  });
  expect(task.status).toBe(200);
  const taskId = (await task.json() as { taskId: string }).taskId;
  await daemon.request(`/api/tasks/${taskId}/say`, {
    method: 'POST', body: JSON.stringify({ text: 'A change of heart.', requestId: 'reclaim-requirement' }),
  });
  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', text: 'Reclaim my history.', requestId: 'reclaim' }),
  });
  expect(created.status).toBe(200);
  const conversationId = (await created.json() as { conversationId: string }).conversationId;
  for (let index = 0; index < 4; index += 1) {
    await daemon.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: `Message ${index + 1}`, requestId: `reclaim-${index}` }),
    });
  }
  await daemon.close();

  const database = new DatabaseSync(join(stateDir, 'tasks.sqlite'));
  const events = () => database.prepare('SELECT cursor, task_id, type FROM events ORDER BY cursor').all() as { cursor: number; task_id: string; type: string }[];
  const before = events();
  expect(before.length).toBeGreaterThan(3);
  // The task is born with one event and changed with another; the conversation
  // records its own.
  expect(before.some(event => event.type === 'task.created')).toBe(true);
  expect(before.some(event => event.type === 'requirement.changed')).toBe(true);

  const reclaim = async (extra: string[]) => {
    const result = await run(binary, ['reclaim', '--state-dir', stateDir, '--keep-events', '1', '--min-age-days', '0', ...extra], { cwd: root });
    return JSON.parse(result.stdout) as {
      plan: { Events: number; Capabilities: number; Handoffs: number };
      applied?: { Events: number; Capabilities: number; Handoffs: number };
      backup?: string;
    };
  };

  // The report names what would go, and it changes nothing while it reports.
  const dry = await reclaim([]);
  expect(dry.plan.Events).toBeGreaterThan(0);
  expect(dry.applied).toBeUndefined();
  expect(events()).toHaveLength(before.length);

  // Told to reclaim, it deletes exactly what it reported.
  const applied = await reclaim(['--apply']);
  expect(applied.applied?.Events).toBe(dry.plan.Events);
  const survivors = events();
  expect(survivors).toHaveLength(before.length - dry.plan.Events);
  // A task keeps the event it was born with and the event it was changed with.
  expect(survivors.filter(event => event.type === 'task.created')).toHaveLength(1);
  expect(survivors.filter(event => event.type === 'requirement.changed')).toHaveLength(1);
  // Everything else is windowed: one plain event per task is left.
  const plain = survivors.filter(event => event.type !== 'task.created' && event.type !== 'requirement.changed');
  expect(new Set(plain.map(event => event.task_id)).size).toBe(plain.length);
  expect(plain.length).toBeLessThanOrEqual(2);
  // A copy of the database was taken before anything was deleted.
  expect(applied.backup).toBeTruthy();
  expect(existsSync(applied.backup!)).toBe(true);

  // The state directory is still a state directory: the daemon opens it and
  // the conversation is still there.
  database.close();
  const again = await launchCli(root, { configPath, stateDir, webDir });
  try {
    const view = await again.request(`/api/conversations/${conversationId}`);
    expect(view.status).toBe(200);
  } finally {
    await again.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
