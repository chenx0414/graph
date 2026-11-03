import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

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

/**
 * The second half of a goal: it has to reach the model and it has to cost
 * something. A goal is injected into the master's prompt only while it is
 * active, every settled turn spends its budget, and a spent budget stops it
 * instead of pretending the goal still drives the work.
 */
test('a goal reaches the model, counts real usage and stops at its budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-goal-turn-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await openaiServer([
    { text: '第一轮完成', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '第二轮完成', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '第三轮完成', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '第四轮完成', usage: { prompt_tokens: 40, completion_tokens: 10 } },
  ]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    access: { mode: 'full' },
    models: { entries: [
      { id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' },
    ] },
    credentials: { local: { secretRef: 'GRAPH_GOAL_KEY' } },
    limits: { defaultBudgetTokens: 3_000_000 },
  }, null, 2));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_GOAL_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, body?: object) => {
    const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };
  const created = await request('/api/conversations', { projectId: 'p', model: 'main', text: '开始工作', requestId: 'goal-start' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = String(created.body.conversationId);
  const messages = async () => ((await request(`/api/conversations/${conversationId}`)).body.messages ?? []) as { role?: string; kind?: string; text?: string }[];
  const replies = async () => (await messages()).filter(message => message.role === 'assistant').length;
  const turn = async (text: string, requestId: string, expected: number) => {
    const sent = await request(`/api/conversations/${conversationId}/messages`, { text, requestId });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await expect.poll(replies, { timeout: 30_000, interval: 250 }).toBe(expected);
  };

  await expect.poll(replies, { timeout: 30_000, interval: 250 }).toBe(1);
  const set = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal 交付 CSV 导出 +100', requestId: 'goal-set' });
  expect(set.body.goal).toMatchObject({ objective: '交付 CSV 导出', status: 'active', usedTokens: 0, budgetTokens: 100 });

  await turn('第二轮', 'goal-turn-2', 2);
  const afterOne = (await request(`/api/conversations/${conversationId}/goal`)).body.goal as Record<string, any>;
  expect(afterOne).toMatchObject({ status: 'active', usedTokens: 50, budgetTokens: 100 });
  // The standing goal is part of what the model was told, not just a row.
  expect(JSON.stringify(provider.requests[1])).toContain('Standing goal');
  expect(JSON.stringify(provider.requests[1])).toContain('交付 CSV 导出');

  await turn('第三轮', 'goal-turn-3', 3);
  const spent = (await request(`/api/conversations/${conversationId}/goal`)).body.goal as Record<string, any>;
  expect(spent).toMatchObject({ status: 'budget_limited', usedTokens: 100, budgetTokens: 100 });
  const visible = (await messages()).filter(message => message.kind === 'goal');
  expect(visible.some(message => message.text?.includes('预算已用完')), JSON.stringify(visible)).toBe(true);
  // The budget stops the goal, not the conversation: the next turn still runs,
  // but it no longer carries the goal and it no longer spends the goal budget.
  await turn('第四轮', 'goal-turn-4', 4);
  expect(JSON.stringify(provider.requests[3])).not.toContain('Standing goal');
  expect((await request(`/api/conversations/${conversationId}/goal`)).body.goal).toMatchObject({ status: 'budget_limited', usedTokens: 100 });

  const extended = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal +100', requestId: 'goal-extend' });
  expect(extended.body.goal).toMatchObject({ status: 'active', usedTokens: 100, budgetTokens: 200 });
  const done = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal done 已交付', requestId: 'goal-done' });
  expect(done.body.goal).toMatchObject({ status: 'completed', checkNote: '已交付' });
}, 120_000);
