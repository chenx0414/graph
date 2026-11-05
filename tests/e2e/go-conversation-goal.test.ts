import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * A goal has no budget: the number a person can still type is ignored, a bare
 * top-up changes nothing, and an old budget-limited row reads as paused.
 *
 * This drives the real daemon: /goal is a command that acts on the goal row and
 * leaves one visible line instead of reaching the model, and the retired budget
 * is proven retired by the receipts a person would read.
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
  const goalLines = async (conversationId: string) => ((await request(`/api/conversations/${conversationId}`)).body.messages ?? []) as { kind?: string; text?: string; data?: Record<string, any> }[];

  const created = await request('/api/conversations', { projectId: 'p', text: 'hello', requestId: 'conversation' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = String(created.body.conversationId);

  expect((await request(`/api/conversations/${conversationId}/goal`)).body.goal).toBeNull();

  // The number a /goal line can still carry is ignored, and the receipt says so.
  const set = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal 把导出做成 CSV +5000', requestId: 'goal-set' });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  expect(set.body.command).toBe('goal');
  expect(set.body.budgetIgnored, JSON.stringify(set.body)).toBe(true);
  expect(set.body.goal).toMatchObject({ objective: '把导出做成 CSV', status: 'active', budgetTokens: 0, usedTokens: 0 });

  const lines = await goalLines(conversationId);
  expect(lines.filter(message => message.kind === 'goal'), JSON.stringify(lines)).toHaveLength(1);
  expect(lines.some(message => message.kind === 'goal' && message.text?.includes('已忽略 +N')), JSON.stringify(lines)).toBe(true);

  expect((await request(`/api/conversations/${conversationId}/goal`)).body.goal).toMatchObject({ objective: '把导出做成 CSV', status: 'active' });

  expect((await request(`/api/conversations/${conversationId}/messages`, { text: '/goal pause', requestId: 'goal-pause' })).body.goal.status).toBe('paused');
  expect((await request(`/api/conversations/${conversationId}/messages`, { text: '/goal resume', requestId: 'goal-resume' })).body.goal.status).toBe('active');

  // A bare top-up buys nothing and changes nothing: it answers instead of
  // failing, and the goal it aimed at is untouched.
  const topUp = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal +900', requestId: 'goal-topup' });
  expect(topUp.status, JSON.stringify(topUp.body)).toBe(200);
  expect(topUp.body).toMatchObject({ command: 'goal', action: 'extend', budgetIgnored: true });
  const untouched = await request(`/api/conversations/${conversationId}/goal`);
  expect(untouched.body.goal).toMatchObject({ objective: '把导出做成 CSV', status: 'active', budgetTokens: 0, usedTokens: 0 });
  const afterTopUp = await goalLines(conversationId);
  expect(afterTopUp.some(message => message.kind === 'goal' && message.text?.includes('目标现在没有上限')), JSON.stringify(afterTopUp.slice(-3))).toBe(true);

  const cleared = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal clear', requestId: 'goal-clear' });
  expect(cleared.body.cleared, JSON.stringify(cleared.body)).toBe(true);
  expect((await request(`/api/conversations/${conversationId}/goal`)).body.goal).toBeNull();

  // The very first message of a new conversation is a command too: it must not
  // be sent to the model, and the conversation is titled by the objective.
  const first = await request('/api/conversations', { text: '/goal 首个消息就是目标 +40', requestId: 'goal-first' });
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body).toMatchObject({ command: 'goal', action: 'set', title: '首个消息就是目标' });
  expect(first.body.goal).toMatchObject({ objective: '首个消息就是目标', status: 'active', budgetTokens: 0 });
  const firstView = await request(`/api/conversations/${first.body.conversationId}`);
  expect((firstView.body.messages ?? []).some((message: { kind?: string; text?: string }) => message.kind === 'goal' && message.text?.includes('首个消息就是目标'))).toBe(true);

  // A bare /goal only shows; a plain message is not a command.
  expect((await request(`/api/conversations/${conversationId}/messages`, { text: '/goal', requestId: 'goal-show' })).body.goal).toBeNull();
  expect((await request(`/api/conversations/${conversationId}/messages`, { text: 'hello again', requestId: 'plain' })).body.command).toBeUndefined();
}, 120_000);

/**
 * A goal reaches the model and it counts real usage, and no number stops it:
 * the loop ends when a turn spends nothing (nothing to account means nothing to
 * continue from), not because a cap was reached.
 */
test('a goal reaches the model, counts real usage and keeps working without a budget', async () => {
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
    { text: '第五轮没有用量', usage: { prompt_tokens: 0, completion_tokens: 0 } },
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

  await expect.poll(replies, { timeout: 30_000, interval: 250 }).toBe(1);
  const set = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal 交付 CSV 导出 +100', requestId: 'goal-set' });
  expect(set.body.goal).toMatchObject({ objective: '交付 CSV 导出', status: 'active', usedTokens: 0, budgetTokens: 0 });
  // Setting the goal is the instruction to work on it: a turn starts without
  // anyone repeating the objective, and it spends the goal it just set.
  expect(set.body.started, JSON.stringify(set.body)).toBe(true);
  // Four turns of fifty tokens each: one from the command and three the goal
  // started itself. The fifth spends nothing, so nothing continues from it.
  await expect.poll(replies, { timeout: 60_000, interval: 250 }).toBe(5);
  const spent = (await request(`/api/conversations/${conversationId}/goal`)).body.goal as Record<string, any>;
  // The goal is between rounds here: every finished round runs a review before
  // the next one, so "verifying" is the working state - what must never happen
  // is a stop the person has to clear.
  expect(spent).toMatchObject({ usedTokens: 150, budgetTokens: 0 });
  expect(['active', 'verifying', 'completed'], `status after the rounds: ${spent.status}`).toContain(spent.status);
  // The standing goal is part of what the model was told, not just a row - and
  // it says there is no ceiling.
  expect(JSON.stringify(provider.requests[1])).toContain('Standing goal');
  expect(JSON.stringify(provider.requests[1])).toContain('交付 CSV 导出');
  expect(JSON.stringify(provider.requests[1])).toContain('未设上限');
  expect(JSON.stringify(provider.requests[1])).toContain('开始执行这个目标');
  expect(JSON.stringify(provider.requests[2])).toContain('继续推进目标');
  const visible = (await messages()).filter(message => message.kind === 'goal');
  expect(visible.some(message => message.text?.includes('目标已设定')), JSON.stringify(visible)).toBe(true);

  // A number changes nothing about a running goal.
  const topUp = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal +100', requestId: 'goal-topup' });
  expect(topUp.body).toMatchObject({ action: 'extend', budgetIgnored: true });
  // Same between-rounds state as above: the number is what matters here, and the
  // goal is either waiting for its next round or running that round's review.
  const between = (await request(`/api/conversations/${conversationId}/goal`)).body.goal;
  expect(between).toMatchObject({ usedTokens: 150, budgetTokens: 0 });
  expect(['active', 'verifying', 'completed'], `status between rounds: ${between.status}`).toContain(between.status);

  const done = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal done 已交付', requestId: 'goal-done' });
  expect(done.body.goal).toMatchObject({ status: 'completed', checkNote: '已交付' });
}, 180_000);

/**
 * A goal typed as the first message of a new conversation is still an
 * instruction to work: the conversation starts on it instead of sitting there
 * until the person speaks again. Only the commands that state or resume an
 * objective start a turn.
 */
test('a goal set as the first message starts the work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-goal-first-turn-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await openaiServer([
    { text: '开始了', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '没有用量就停', usage: { prompt_tokens: 0, completion_tokens: 0 } },
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
    credentials: { local: { secretRef: 'GRAPH_GOAL_FIRST_KEY' } },
    limits: { defaultBudgetTokens: 3_000_000 },
  }, null, 2));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_GOAL_FIRST_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, body?: object) => {
    const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };

  const created = await request('/api/conversations', { projectId: 'p', model: 'main', text: '/goal 先修好导出 +50', requestId: 'goal-first-turn' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  expect(created.body).toMatchObject({ command: 'goal', action: 'set', started: true, title: '先修好导出' });
  const conversationId = String(created.body.conversationId);
  const messages = async () => ((await request(`/api/conversations/${conversationId}`)).body.messages ?? []) as { role?: string; kind?: string; text?: string; data?: Record<string, any> }[];
  const replies = async () => (await messages()).filter(message => message.role === 'assistant').length;

  await expect.poll(replies, { timeout: 60_000, interval: 250 }).toBe(2);
  expect(provider.requests.length).toBe(2);
  const prompt = JSON.stringify(provider.requests[0]);
  expect(prompt).toContain('Standing goal');
  expect(prompt).toContain('先修好导出');
  // The turn starts from a visible instruction, not from nothing: the model is
  // told to begin, and the transcript says why it did.
  const transcript = await messages();
  expect(transcript.some(message => message.role === 'user' && message.text?.includes('开始执行这个目标')), JSON.stringify(transcript)).toBe(true);
  expect(transcript.some(message => message.kind === 'goal' && message.text?.includes('先修好导出')), JSON.stringify(transcript)).toBe(true);
  // The goal kept itself going without a budget; it stopped because the last
  // turn had nothing to account, not because a number was reached.
  const afterFirstRounds = (await request(`/api/conversations/${conversationId}/goal`)).body.goal;
  expect(afterFirstRounds).toMatchObject({ usedTokens: 50, budgetTokens: 0 });
  expect(['active', 'verifying', 'completed'], `status after the first rounds: ${afterFirstRounds.status}`).toContain(afterFirstRounds.status);

  // A command that only changes the goal does not start another turn.
  const finished = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal done 导出修好了', requestId: 'goal-first-done' });
  expect(finished.body.goal).toMatchObject({ status: 'completed', checkNote: '导出修好了' });
  expect(provider.requests.length).toBe(2);
  expect(await replies()).toBe(2);
}, 180_000);
