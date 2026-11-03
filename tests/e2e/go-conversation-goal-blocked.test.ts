import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

/**
 * blocked is evidence, and it is counted per round.
 *
 * The first time something stands in the way the model keeps working. The goal
 * stops only once the same blocker has been reported in each of the last three
 * rounds - so a round that does not report it breaks the run, and three reports
 * spread over four rounds are not three rounds of being stuck.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

const BLOCKER = '拿不到生产环境的 API key，导出接口无法联调';

/** One turn that reports the same blocker, then answers. */
function blockedTurn(turn: number): ResponsePlan[] {
  return [
    {
      tools: [{ id: `goal-blocked-${turn}`, name: 'goal', arguments: JSON.stringify({ action: 'blocked', note: BLOCKER, requestId: `goal-blocked-${turn}` }) }],
      usage: { prompt_tokens: 40, completion_tokens: 10 },
    },
    { text: `第 ${turn} 轮还是被挡住`, usage: { prompt_tokens: 40, completion_tokens: 10 } },
  ];
}

/** One turn that reports nothing: it breaks the run of identical blockers. */
function clearTurn(turn: number): ResponsePlan[] {
  return [{ text: `第 ${turn} 轮没有报告阻碍`, usage: { prompt_tokens: 40, completion_tokens: 10 } }];
}

test('the same blocker pauses the goal only after three consecutive rounds of it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-goal-blocked-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await openaiServer([
    ...blockedTurn(1),
    ...blockedTurn(2),
    ...clearTurn(3),
    ...blockedTurn(4),
    ...blockedTurn(5),
    ...blockedTurn(6),
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

  await expect.poll(() => goal(conversationId), { timeout: 120_000, interval: 250 }).toMatchObject({ status: 'paused' });
  const transcript = await messages(conversationId);
  const goalLines = transcript.filter(message => message.kind === 'goal');

  // The report that followed the quiet round started the count over: two lines
  // say "第 1 轮", the report in round 1 and the report in round 4.
  expect(goalLines.filter(message => message.text?.includes('第 1 轮')).length, JSON.stringify(goalLines.map(message => message.text))).toBe(2);
  expect(goalLines.some(message => message.text?.includes('第 2 轮'))).toBe(true);
  // Round 3 reported nothing, so rounds 2 and 4 never formed a run of three.
  const stopped = goalLines.filter(message => message.text?.includes('卡住 3 轮'));
  expect(stopped.length, JSON.stringify(goalLines.map(message => message.text))).toBe(1);
  expect(stopped[0]?.text).toContain('导出接口无法联调');
  expect((await goal(conversationId))?.checkNote ?? '').not.toContain('验收通过');

  // Six rounds: the five that report the blocker ask twice (the tool call, then
  // the answer) and the quiet round asks once. Nothing ran after the pause.
  expect(provider.requests.length).toBe(11);
  expect(transcript.filter(message => message.role === 'assistant').length).toBe(6);
}, 240_000);
