import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

/**
 * blocked is evidence, not an opinion.
 *
 * The first time something stands in the way the model keeps working: the goal
 * only stops once the SAME blocker has stood for three consecutive turns. The
 * proof is the real daemon, a scripted provider that reports the identical
 * blocker each turn, and the transcript a person would read.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

const BLOCKER = '拿不到生产环境的 API key，导出接口无法联调';

/** One turn: report the same blocker, then answer. */
function blockedTurn(turn: number): ResponsePlan[] {
  return [
    {
      tools: [{ id: `goal-blocked-${turn}`, name: 'goal', arguments: JSON.stringify({ action: 'blocked', note: BLOCKER, requestId: `goal-blocked-${turn}` }) }],
      usage: { prompt_tokens: 40, completion_tokens: 10 },
    },
    { text: `第 ${turn} 轮还是被挡住`, usage: { prompt_tokens: 40, completion_tokens: 10 } },
  ];
}

test('the same blocker pauses the goal only after three consecutive turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-goal-blocked-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await openaiServer([...blockedTurn(1), ...blockedTurn(2), ...blockedTurn(3)]);
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
    credentials: { local: { secretRef: 'GRAPH_GOAL_BLOCKED_KEY' } },
    limits: { defaultBudgetTokens: 3_000_000 },
  }, null, 2));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_GOAL_BLOCKED_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, body?: object) => {
    const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };
  const messages = async (conversationId: string) => ((await request(`/api/conversations/${conversationId}`)).body.messages ?? []) as { role?: string; kind?: string; text?: string }[];
  const goal = async (conversationId: string) => ((await request(`/api/conversations/${conversationId}/goal`)).body.goal ?? null) as Record<string, any> | null;

  const created = await request('/api/conversations', { projectId: 'p', model: 'main', text: '/goal 交付 CSV 导出', requestId: 'goal-blocked' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = String(created.body.conversationId);

  await expect.poll(() => goal(conversationId), { timeout: 90_000, interval: 250 }).toMatchObject({ status: 'paused' });
  const transcript = await messages(conversationId);
  // The first two reports did not stop it: the goal kept working, and the
  // transcript says why each time.
  expect(transcript.some(message => message.kind === 'goal' && message.text?.includes('第 1 轮')), JSON.stringify(transcript)).toBe(true);
  expect(transcript.some(message => message.kind === 'goal' && message.text?.includes('第 2 轮')), JSON.stringify(transcript)).toBe(true);
  // The third identical blocker is what paused it, with the blocker named.
  const stopped = transcript.filter(message => message.kind === 'goal' && message.text?.includes('卡住 3 轮'));
  expect(stopped.length, JSON.stringify(transcript)).toBe(1);
  expect(stopped[0]?.text).toContain('导出接口无法联调');
  expect((await goal(conversationId))?.checkNote ?? '').not.toContain('验收通过');

  // Three turns, two requests each: nothing kept running after the pause.
  expect(provider.requests.length).toBe(6);
  expect(transcript.filter(message => message.role === 'assistant').length).toBe(3);
}, 180_000);
