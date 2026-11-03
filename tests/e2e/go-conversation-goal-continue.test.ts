import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

/**
 * A goal is the work, so one finished turn does not end it - and there is no
 * turn cap that ends it either.
 *
 * These cases drive the real daemon and a scripted provider: the goal starts its
 * own next turn while it is still active, it stops when a turn spends nothing
 * (nothing to account means nothing to continue from), and resuming a paused
 * goal starts the next turn immediately instead of waiting for the person to
 * speak again.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function goalConversation(plans: ResponsePlan[], credential: string) {
  const root = await mkdtemp(join(tmpdir(), 'graph-goal-continue-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await openaiServer(plans);
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
    credentials: { local: { secretRef: credential } },
    limits: { defaultBudgetTokens: 3_000_000 },
  }, null, 2));
  const daemon = await launchCli(root, { configPath, env: { [credential]: 'synthetic-only' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, body?: object) => {
    const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };
  const messages = async (conversationId: string) => ((await request(`/api/conversations/${conversationId}`)).body.messages ?? []) as { role?: string; kind?: string; text?: string }[];
  const replies = async (conversationId: string) => (await messages(conversationId)).filter(message => message.role === 'assistant').length;
  const goalOf = async (conversationId: string) => ((await request(`/api/conversations/${conversationId}/goal`)).body.goal ?? null) as Record<string, any> | null;
  const start = async (text: string, requestId: string) => {
    const created = await request('/api/conversations', { projectId: 'p', model: 'main', text, requestId });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return String(created.body.conversationId);
  };
  return { root, request, messages, replies, start, provider, goalOf };
}

test('a goal without a budget starts its next turn by itself, with no turn cap', async () => {
  const { request, messages, replies, start, provider } = await goalConversation([
    { text: '第一步', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '第二步', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '第三步', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '第四步', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '第五步没有用量', usage: { prompt_tokens: 0, completion_tokens: 0 } },
  ], 'GRAPH_GOAL_AUTO_KEY');
  const conversationId = await start('/goal 连续推进', 'goal-continue');

  // Five turns: the goal keeps starting its own. The last one spends nothing,
  // so the chain ends there - not because a number of turns ran out.
  await expect.poll(() => replies(conversationId), { timeout: 90_000, interval: 250 }).toBe(5);
  expect(provider.requests.length).toBe(5);
  const transcript = await messages(conversationId);
  expect(transcript.filter(message => message.role === 'user' && message.text?.startsWith('继续推进目标')).length, JSON.stringify(transcript)).toBeGreaterThanOrEqual(3);
  expect((await request(`/api/conversations/${conversationId}/goal`)).body.goal).toMatchObject({ status: 'active', budgetTokens: 0, usedTokens: 200 });
  // Nothing paused it for the person: a goal is not capped at a few turns.
  expect(transcript.some(message => message.kind === 'goal' && message.text?.includes('自动连续推进'))).toBe(false);
}, 180_000);

test('resuming a paused goal starts the next turn immediately', async () => {
  const { request, messages, replies, start, provider } = await goalConversation([
    { text: '开始做', usage: { prompt_tokens: 0, completion_tokens: 0 } },
    { text: '接着做', usage: { prompt_tokens: 0, completion_tokens: 0 } },
  ], 'GRAPH_GOAL_RESUME_KEY');
  const conversationId = await start('/goal 恢复后继续', 'goal-resume');

  await expect.poll(() => replies(conversationId), { timeout: 60_000, interval: 250 }).toBe(1);
  const paused = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal pause', requestId: 'goal-resume-pause' });
  expect(paused.body.goal.status).toBe('paused');
  expect(provider.requests.length).toBe(1);

  // Resume means "go on": the goal becomes active and its turn starts now,
  // exactly like a freshly set goal.
  const resumed = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal resume', requestId: 'goal-resume-go' });
  expect(resumed.body.goal.status).toBe('active');
  expect(resumed.body.started, JSON.stringify(resumed.body)).toBe(true);
  await expect.poll(() => replies(conversationId), { timeout: 60_000, interval: 250 }).toBe(2);
  expect(provider.requests.length).toBe(2);
  const transcript = await messages(conversationId);
  expect(transcript.filter(message => message.role === 'user' && message.text?.includes('开始执行这个目标')).length).toBe(2);
}, 180_000);

/**
 * A goal stored while budgets existed is the same situation as a person
 * pausing: it reads as paused, and resume is the one way back. What it must not
 * do is come back with its old ceiling and stop again on the next turn.
 */
test('a historical budget-limited row resumes and never re-pauses on the old number', async () => {
  const { root, request, messages, replies, start, provider, goalOf } = await goalConversation([
    { text: '开始做', usage: { prompt_tokens: 0, completion_tokens: 0 } },
    { text: '接着做', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '再推一轮', usage: { prompt_tokens: 0, completion_tokens: 0 } },
  ], 'GRAPH_GOAL_LEGACY_KEY');
  const conversationId = await start('/goal 交付 CSV 导出', 'goal-legacy');
  await expect.poll(() => replies(conversationId), { timeout: 60_000, interval: 250 }).toBe(1);

  // The row as an older runtime wrote it: a spent budget and the status that
  // said the number had run out.
  const db = new DatabaseSync(join(root, 'state/tasks.sqlite'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare('UPDATE conversation_goals SET status=?, budget_tokens=?, used_tokens=? WHERE conversation_id=?')
    .run('budget_limited', 5000, 6000, conversationId);
  db.close();

  // Reading it is the D1 normalisation: paused, and the number is not part of
  // what the goal is any more.
  await expect.poll(() => goalOf(conversationId), { timeout: 30_000, interval: 250 }).toMatchObject({ status: 'paused', budgetTokens: 0, usedTokens: 6000 });

  const resumed = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal resume', requestId: 'goal-legacy-resume' });
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  expect(resumed.body.goal).toMatchObject({ status: 'active', budgetTokens: 0, usedTokens: 6000 });
  expect(resumed.body.started, JSON.stringify(resumed.body)).toBe(true);

  // Resume rewrites the retired column instead of carrying it forward.
  const after = new DatabaseSync(join(root, 'state/tasks.sqlite'));
  after.exec('PRAGMA busy_timeout=5000');
  const row = after.prepare('SELECT status,budget_tokens FROM conversation_goals WHERE conversation_id=?').get(conversationId) as { status: string; budget_tokens: number };
  after.close();
  expect(row).toMatchObject({ status: 'active', budget_tokens: 0 });

  // A full round runs on top of a goal that already spent more than the old
  // ceiling, and it keeps going: nothing re-pauses on that number.
  await expect.poll(() => replies(conversationId), { timeout: 60_000, interval: 250 }).toBe(3);
  await expect.poll(() => goalOf(conversationId), { timeout: 30_000, interval: 250 }).toMatchObject({ status: 'active', usedTokens: 6050, budgetTokens: 0 });
  const transcript = await messages(conversationId);
  expect(transcript.some(message => message.kind === 'goal' && message.text?.includes('历史数据里的预算')), JSON.stringify(transcript)).toBe(false);
  expect(transcript.some(message => message.role === 'user' && message.text?.startsWith('继续推进目标')), JSON.stringify(transcript)).toBe(true);
  expect(provider.requests.length).toBe(3);
}, 180_000);
