import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

/**
 * A goal is the work, so one finished turn does not end it.
 *
 * These cases drive the real daemon and a scripted provider: the goal starts
 * its own next turn while it still has room, the budget is what stops a goal
 * that has one, and a goal without a budget advances a bounded number of turns
 * and then pauses for a person - because nothing else would stop it.
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
  const start = async (text: string, requestId: string) => {
    const created = await request('/api/conversations', { projectId: 'p', model: 'main', text, requestId });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return String(created.body.conversationId);
  };
  return { request, messages, replies, start };
}

test('a goal with budget left starts its next turn by itself', async () => {
  const { request, messages, replies, start } = await goalConversation([
    { text: '第一轮', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '第二轮', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '第三轮', usage: { prompt_tokens: 40, completion_tokens: 10 } },
  ], 'GRAPH_GOAL_AUTO_KEY');
  const conversationId = await start('/goal 连续推进 +150', 'goal-continue');

  // Three turns of fifty tokens spend the budget exactly: the first from the
  // command, the next two from the goal itself.
  await expect.poll(() => replies(conversationId), { timeout: 60_000, interval: 250 }).toBe(3);
  const transcript = await messages(conversationId);
  expect(transcript.some(message => message.role === 'user' && message.text?.startsWith('继续推进目标')), JSON.stringify(transcript)).toBe(true);

  // The budget is the brake: the goal is stopped and nothing else starts.
  expect((await request(`/api/conversations/${conversationId}/goal`)).body.goal).toMatchObject({ status: 'budget_limited', usedTokens: 150, budgetTokens: 150 });
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(await replies(conversationId)).toBe(3);
}, 120_000);

test('a goal without a budget advances a few turns and then pauses for a person', async () => {
  const { request, messages, replies, start } = await goalConversation([
    { text: '第一步', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '第二步', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '第三步', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '第四步', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '第五步', usage: { prompt_tokens: 40, completion_tokens: 10 } },
  ], 'GRAPH_GOAL_CAP_KEY');
  const conversationId = await start('/goal 无预算连续推进', 'goal-cap');

  // One turn from the command plus four automatic continuations, then the pause
  // that keeps an unbudgeted goal from spending for ever.
  await expect.poll(() => replies(conversationId), { timeout: 90_000, interval: 250 }).toBe(5);
  expect((await request(`/api/conversations/${conversationId}/goal`)).body.goal).toMatchObject({ status: 'paused', budgetTokens: 0, usedTokens: 250 });
  const transcript = await messages(conversationId);
  expect(transcript.some(message => message.kind === 'goal' && message.text?.includes('已自动连续推进 4 轮')), JSON.stringify(transcript)).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(await replies(conversationId)).toBe(5);
}, 180_000);
