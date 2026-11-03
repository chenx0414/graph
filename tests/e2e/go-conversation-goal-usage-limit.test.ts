import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * A provider that refuses a turn for capacity reasons is a recoverable stop,
 * not a finished goal.
 *
 * The real daemon is driven against a scripted provider that answers 429: the
 * goal must stop as usage_limited, say so in the transcript, and come back with
 * /goal resume once the quota exists again. A turn that never ran must not count
 * as work done and must not spend the goal.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('a provider 429 stops the goal as usage_limited and resume brings it back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-goal-usage-limit-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  // The transport retries a capacity answer within its own bound before the turn
  // fails: the provider says "wait 0" so the proof stays about the goal, not
  // about how long the harness sleeps.
  const busy = { status: 429, headers: { 'retry-after': '0' }, error: 'rate limit reached', errorCode: 'rate_limit' };
  const provider = await openaiServer([
    busy, busy, busy,
    { text: '额度恢复了，继续做', usage: { prompt_tokens: 0, completion_tokens: 0 } },
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
    credentials: { local: { secretRef: 'GRAPH_GOAL_USAGE_KEY' } },
    limits: { defaultBudgetTokens: 3_000_000 },
  }, null, 2));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_GOAL_USAGE_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, body?: object) => {
    const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };
  const messages = async (conversationId: string) => ((await request(`/api/conversations/${conversationId}`)).body.messages ?? []) as { role?: string; kind?: string; text?: string; state?: string }[];
  const goal = async (conversationId: string) => ((await request(`/api/conversations/${conversationId}/goal`)).body.goal ?? null) as Record<string, any> | null;

  const created = await request('/api/conversations', { projectId: 'p', model: 'main', text: '/goal 交付 CSV 导出', requestId: 'goal-usage-limit' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = String(created.body.conversationId);

  // The refused turn stops the goal as recoverable instead of pretending it is
  // still working.
  await expect.poll(() => goal(conversationId), { timeout: 60_000, interval: 250 }).toMatchObject({ status: 'usage_limited' });
  const stopped = await goal(conversationId);
  expect(stopped).toMatchObject({ usedTokens: 0, budgetTokens: 0 });
  const transcript = await messages(conversationId);
  expect(transcript.some(message => message.kind === 'goal' && message.text?.includes('额度/容量限制')), JSON.stringify(transcript.slice(-6))).toBe(true);
  // Nothing continued: a goal that stopped for capacity does not queue another
  // turn nobody can answer.
  expect(transcript.filter(message => message.role === 'user' && message.text?.includes('开始执行这个目标')).length).toBe(1);
  expect(transcript.some(message => message.role === 'user' && message.text?.startsWith('继续推进目标'))).toBe(false);

  // Resume puts it back to active and starts its turn like a freshly set goal.
  const resumed = await request(`/api/conversations/${conversationId}/messages`, { text: '/goal resume', requestId: 'goal-usage-resume' });
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  expect(resumed.body.goal.status).toBe('active');
  expect(resumed.body.started, JSON.stringify(resumed.body)).toBe(true);
  await expect.poll(() => goal(conversationId), { timeout: 30_000, interval: 250 }).toMatchObject({ status: 'active' });
  const afterResume = await messages(conversationId);
  expect(afterResume.filter(message => message.role === 'user' && message.text?.includes('开始执行这个目标')).length).toBe(2);
}, 180_000);
