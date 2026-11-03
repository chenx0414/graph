import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A goal is a persistent objective, not a bigger message.
 *
 * Measured 2026-11-03 (Codex /goal): the objective lives outside the chat with
 * a status, a budget and a completion note, so a thread can carry an objective
 * while every turn still starts from what the person asked.
 *
 * This drives the real daemon: /goal is a command that acts on that row and
 * leaves one visible line instead of reaching the model.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('a conversation keeps one goal through set, show, pause, resume and clear', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-goal-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'));
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: join(root, 'project') }] }));
  const daemon = await launchCli(root, { configPath });
  cleanup.push(() => daemon.close());
  const request = async (path: string, body?: object) => {
    const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };

  const created = await request('/api/conversations', { projectId: 'p', text: 'hello', requestId: 'conversation' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = String(created.body.conversationId);

  expect((await request(`/api/conversations/${conversationId}/goal`)).body.goal).toBeNull();

  const set = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal 把导出做成 CSV +5000', requestId: 'goal-set' });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  expect(set.body.command).toBe('goal');
  expect(set.body.goal).toMatchObject({ objective: '把导出做成 CSV', status: 'active', budgetTokens: 5000 });

  expect((await request(`/api/conversations/${conversationId}/goal`)).body.goal).toMatchObject({ objective: '把导出做成 CSV', status: 'active' });

  const view = await request(`/api/conversations/${conversationId}`);
  const messages = (view.body.messages ?? []) as { kind?: string; text?: string }[];
  expect(messages.filter(message => message.kind === 'goal')).toHaveLength(1);
  expect(messages.some(message => message.kind === 'goal' && message.text?.includes('把导出做成 CSV')), JSON.stringify(messages.slice(-4))).toBe(true);

  expect((await request(`/api/conversations/${conversationId}/messages`, { text: '/goal pause', requestId: 'goal-pause' })).body.goal.status).toBe('paused');
  expect((await request(`/api/conversations/${conversationId}/messages`, { text: '/goal resume', requestId: 'goal-resume' })).body.goal.status).toBe('active');
  const cleared = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal clear', requestId: 'goal-clear' });
  expect(cleared.body.cleared, JSON.stringify(cleared.body)).toBe(true);
  expect((await request(`/api/conversations/${conversationId}/goal`)).body.goal).toBeNull();

  // A bare /goal only shows; a plain message is not a command.
  expect((await request(`/api/conversations/${conversationId}/messages`, { text: '/goal', requestId: 'goal-show' })).body.goal).toBeNull();
  expect((await request(`/api/conversations/${conversationId}/messages`, { text: 'hello again', requestId: 'plain' })).body.command).toBeUndefined();
}, 120_000);
