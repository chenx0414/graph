import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

/**
 * Every finished answer is reviewed in a context of its own.
 *
 * The person who sets a goal is not its reviewer and the worker is not either:
 * the worker answers, and a separate turn - one that did not do the work and
 * does not read its transcript - decides whether the goal is done. Nobody calls
 * the goal tool to say "complete" in this case; the runtime asks for the review.
 *
 * Two facts are asserted, and the second is what makes the review independent:
 * the acceptance turn happens with no completion claim, and its provider request
 * carries the acceptance instruction alone instead of the working transcript.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture(plans: ResponsePlan[], credential: string) {
  const root = await mkdtemp(join(tmpdir(), 'graph-goal-round-acceptance-'));
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
    // No project: this goal has no graph owner, so it runs in the conversation and
    // exercises the in-chat acceptance loop.
    projects: [],
    access: { mode: 'full' },
    models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] },
    credentials: { local: { secretRef: credential } },
    limits: { defaultBudgetTokens: 3_000_000 },
  }, null, 2));
  const daemon = await launchCli(root, { configPath, env: { [credential]: 'synthetic-only' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, body?: object) => {
    const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };
  const messages = async (conversationId: string) => ((await request(`/api/conversations/${conversationId}`)).body.messages ?? []) as { role?: string; kind?: string; text?: string; data?: any }[];
  const goal = async (conversationId: string) => ((await request(`/api/conversations/${conversationId}/goal`)).body.goal ?? null) as Record<string, any> | null;
  return { request, messages, goal, provider };
}

type SentRequest = { messages: { role: string; content: unknown }[] };

function lastText(request: SentRequest): string {
  const last = request.messages[request.messages.length - 1];
  if (!last) return '';
  return typeof last.content === 'string'
    ? last.content
    : (last.content as { type?: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
}

test('a finished answer is reviewed without a completion claim, in a context of its own', async () => {
  const f = await fixture([
    { text: '第一步：把导出脚本写完。', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: 'VERDICT: fail\n- [fail] 还没有跑过导出：先跑一次再交付。', usage: { prompt_tokens: 30, completion_tokens: 8 } },
    { text: '第二步：导出已跑通，CSV 在 deliverables/export.csv。', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: 'VERDICT: pass\n- [pass] 导出可用：文件存在且内容可读。', usage: { prompt_tokens: 30, completion_tokens: 8 } },
  ], 'GRAPH_GOAL_ROUND_KEY');

  // No single project can own a graph here, so this goal runs in the conversation and
  // exercises the in-chat acceptance loop.
  const created = await f.request('/api/conversations', { model: 'main', text: '/goal 交付 CSV 导出', requestId: 'goal-round-acceptance' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = String(created.body.conversationId);

  // No goal tool call is scripted anywhere: the review is the runtime's.
  await expect.poll(async () => (await f.goal(conversationId))?.status, { timeout: 120_000, interval: 250 }).toBe('completed');

  const transcript = await f.messages(conversationId);
  const reviews = transcript.filter(message => message.role === 'user' && message.data?.source?.kind === 'goal_acceptance');
  expect(reviews.length, JSON.stringify(transcript.map(message => message.text?.slice(0, 40)))).toBe(2);
  expect(transcript.some(message => (message.text ?? '').includes('完成声明已提交')), 'nobody claimed completion').toBe(false);

  // The review requests are the ones whose last message is the acceptance
  // instruction; a working turn that follows one carries it in its history.
  const reviewRequests = (f.provider.requests as SentRequest[]).filter(request => lastText(request).includes('独立验收请求'));
  expect(reviewRequests.length).toBe(2);
  for (const review of reviewRequests) {
    // Its own context: the acceptance instruction and nothing else. The prompt
    // quotes this round's answer on purpose - that is the material being judged -
    // but the transcript that produced it must not come along.
    // The proof of an independent context: no answer of a working turn travelled
    // into the request. A shared session would carry them; this one carries at
    // most its own earlier verdict, which is the reviewer's own memory.
    const earlier = review.messages
      .filter(message => message.role === 'assistant')
      .map(message => (typeof message.content === 'string' ? message.content : ''))
      .join('\n');
    expect(earlier, 'a review must not read the work that produced the round').not.toContain('第一步：');
    expect(earlier).not.toContain('第二步：');
  }
});
