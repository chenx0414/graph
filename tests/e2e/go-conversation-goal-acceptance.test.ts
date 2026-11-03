import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

/**
 * A completion claim is not a completed goal.
 *
 * These cases drive the real daemon and a scripted provider through all three
 * paths of the independent acceptance turn: a rejected claim keeps the goal
 * running with the reasons carried into the next turn, an accepted claim is the
 * only thing that completes it, and an acceptance that could not be read is
 * never counted as a pass.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface Message { role?: string; kind?: string; text?: string; data?: Record<string, any> }

async function goalConversation(plans: ResponsePlan[], credential: string) {
  const root = await mkdtemp(join(tmpdir(), 'graph-goal-acceptance-'));
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
  const messages = async (conversationId: string) => ((await request(`/api/conversations/${conversationId}`)).body.messages ?? []) as Message[];
  const goal = async (conversationId: string) => ((await request(`/api/conversations/${conversationId}/goal`)).body.goal ?? null) as Record<string, any> | null;
  const replies = async (conversationId: string) => (await messages(conversationId)).filter(message => message.role === 'assistant').length;
  const start = async (text: string, requestId: string) => {
    const created = await request('/api/conversations', { projectId: 'p', model: 'main', text, requestId });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return String(created.body.conversationId);
  };
  return { request, messages, goal, replies, start, provider };
}

/** One completion claim: the model calls the goal tool, then says it is done. */
function claimTurn(text: string): ResponsePlan {
  return {
    tools: [{ id: 'goal-complete', name: 'goal', arguments: JSON.stringify({ action: 'complete', note: '导出已上线，跑了测试', requestId: 'goal-claim' }) }],
    usage: { prompt_tokens: 40, completion_tokens: 10 },
  };
}

test('a rejected acceptance does not complete the goal and the reasons reach the next turn', async () => {
  const { messages, goal, replies, start } = await goalConversation([
    claimTurn('第一轮'),
    { text: '导出已上线，跑了测试', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: 'VERDICT: fail\n- [fail] 测试没跑: 没有看到任何测试输出，无法确认导出可用', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '我先把测试补上', usage: { prompt_tokens: 0, completion_tokens: 0 } },
  ], 'GRAPH_GOAL_ACCEPT_FAIL_KEY');
  const conversationId = await start('/goal 交付 CSV 导出', 'goal-accept-fail');

  // The rejection is what the test waits for: the goal is active from the
  // start, so its status alone would pass before any turn ran.
  await expect.poll(async () => (await messages(conversationId)).some(message => message.kind === 'goal' && message.text?.includes('验收未通过')), { timeout: 60_000, interval: 250 }).toBe(true);
  const transcript = await messages(conversationId);

  // The claim asked for acceptance, and the goal is not finished.
  expect(transcript.some(message => message.kind === 'goal' && message.text?.includes('进入独立验收')), JSON.stringify(transcript.slice(-8))).toBe(true);
  expect(transcript.some(message => message.kind === 'goal' && message.text?.includes('验收未通过（第 1 轮）')), JSON.stringify(transcript.slice(-8))).toBe(true);
  const current = await goal(conversationId);
  expect(current).toMatchObject({ status: 'active' });
  expect(current?.checkNote ?? '').not.toContain('验收通过');

  // The rejection travels: the next turn's instruction names what failed.
  const continuation = transcript.filter(message => message.role === 'user' && message.text?.startsWith('继续推进目标'));
  expect(continuation.length, JSON.stringify(transcript.map(message => [message.role, message.text?.slice(0, 30)]))).toBeGreaterThan(0);
  expect(continuation.at(-1)?.text).toContain('上一轮验收没有通过');
  expect(continuation.at(-1)?.text).toContain('测试没跑');

  // The acceptance turn itself is a system-style instruction, not the person typing.
  expect(transcript.some(message => message.role === 'user' && message.data?.source?.kind === 'goal_acceptance' && message.text?.includes('独立验收请求')), JSON.stringify(transcript.slice(-8))).toBe(true);
  expect(await replies(conversationId)).toBeGreaterThanOrEqual(3);
}, 180_000);

test('only an acceptance pass completes the goal, and the final report carries the verdict', async () => {
  const { messages, goal, start, provider } = await goalConversation([
    claimTurn('第一轮'),
    { text: '导出已上线，跑了测试', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: 'VERDICT: pass\n- [pass] 导出可用: 实跑导出测试通过\n- [pass] 文件到位: 工作区里能看到导出实现', usage: { prompt_tokens: 40, completion_tokens: 10 } },
  ], 'GRAPH_GOAL_ACCEPT_PASS_KEY');
  const conversationId = await start('/goal 交付 CSV 导出', 'goal-accept-pass');

  await expect.poll(() => goal(conversationId), { timeout: 60_000, interval: 250 }).toMatchObject({ status: 'completed' });
  const current = await goal(conversationId);
  // Every turn counted, including the acceptance turn itself: the claim turn
  // (50), the answer after its tool call (50) and the acceptance (50).
  expect(current).toMatchObject({ usedTokens: 150 });
  expect(String(current?.checkNote)).toContain('验收通过');
  expect(String(current?.checkNote)).toContain('导出可用');

  // The tool the model read says what complete does: it asks for an
  // independent acceptance check, it does not finish the goal.
  const toolText = JSON.stringify((provider.requests[0] as { tools?: unknown }).tools ?? []);
  expect(toolText, toolText.slice(0, 400)).toContain('independent acceptance check');
  expect(toolText).not.toContain('it ends the goal');

  const transcript = await messages(conversationId);
  const report = transcript.filter(message => message.kind === 'goal' && message.text?.includes('验收结论：通过'));
  expect(report.length, JSON.stringify(transcript.slice(-6))).toBe(1);
  expect(report[0]?.text).toContain('含验收轮');
  expect(report[0]?.text).toContain('已用 150 tokens');
  expect(report[0]?.text).toContain('实跑导出测试通过');
}, 180_000);

test('an acceptance turn that yields no verdict is never counted as a pass', async () => {
  const { messages, goal, replies, start, provider } = await goalConversation([
    claimTurn('第一轮'),
    { text: '导出已上线，跑了测试', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: '看起来差不多了，应该没问题。', usage: { prompt_tokens: 40, completion_tokens: 10 } },
  ], 'GRAPH_GOAL_ACCEPT_ERROR_KEY');
  const conversationId = await start('/goal 交付 CSV 导出', 'goal-accept-error');

  await expect.poll(async () => (await messages(conversationId)).some(message => message.kind === 'goal' && message.text?.includes('验收没有得出结论')), { timeout: 60_000, interval: 250 }).toBe(true);
  const current = await goal(conversationId);
  expect(current).toMatchObject({ status: 'active' });
  expect(String(current?.checkNote ?? '')).not.toContain('验收通过');

  // Nothing advances on a verdict nobody could read: the claim turn and the
  // acceptance turn ran, no continuation was queued, and the provider was not
  // asked again (the tool-call step of the claim is a request, not a reply).
  expect(provider.requests.length).toBe(3);
  expect(await replies(conversationId)).toBe(2);
  const transcript = await messages(conversationId);
  expect(transcript.some(message => message.role === 'user' && message.text?.startsWith('继续推进目标'))).toBe(false);
}, 180_000);
