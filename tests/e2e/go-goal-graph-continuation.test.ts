import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// A goal is worked in one place. Once it has a graph, that graph is where the
// work happens and the conversation keeps only the objective and the state: the
// status bar, not a second working transcript. Measured 2026-11-06: the chat kept
// auto-continuing a graph-owned goal, so a failed acceptance came back as a new
// turn in the same window the person was reading ("我又看到了这个聊天窗口返回了
// 失败重跑续跑").
//
// The proof is a real daemon and a real settled turn: a goal that names a graph
// must not queue a continuation, and one that names none still must - the second
// case is what keeps the behaviour honest rather than "stop continuing anything".

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function conversation(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-goal-continue-${prefix}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
  const provider = await openaiServer([
    { text: '先做第一步。', usage: { prompt_tokens: 200, completion_tokens: 8 } },
    { text: '继续做第二步。', usage: { prompt_tokens: 220, completion_tokens: 8 } },
  ]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_GOAL_CONTINUE_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_GOAL_CONTINUE_KEY: 'synthetic-only' } });
  cleanup.push(() => daemon.close());
  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: '开始。', requestId: 'goal-continue-start' }),
  });
  const text = await created.text();
  expect(created.status, text).toBe(200);
  const conversationId = (JSON.parse(text) as { conversationId: string }).conversationId;
  const db = join(root, 'state', 'tasks.sqlite');
  const write = (sql: string) => execFileSync('sqlite3', [db, sql]);
  // The opening turn has to settle before the goal exists, otherwise it can queue a
  // continuation under the load of a full suite and the case stops being about the
  // goal at all.
  await expect.poll(async () => (await (await daemon.request(`/api/conversations/${conversationId}`)).json() as { messages?: Message[] }).messages?.some(message => (message.text ?? '').includes('先做第一步')), { timeout: 60_000, interval: 250 }).toBe(true);
  return { daemon, conversationId, provider, write };
}

function goalRow(write: (sql: string) => void, conversationId: string, graphId: string) {
  write(`INSERT INTO conversation_goals(conversation_id,objective,status,graph_id,graph_owner_task,created_at,updated_at)
    VALUES('${conversationId}','把导出做成 CSV','active','${graphId}','',${Date.now()},${Date.now()})`);
}

interface Message { kind?: string; text?: string; data?: { source?: { kind?: string } } }
const transcript = async (daemon: Awaited<ReturnType<typeof launchCli>>, id: string) =>
  ((await (await daemon.request(`/api/conversations/${id}`)).json()) as { messages?: Message[] }).messages ?? [];
const continued = (messages: Message[]) => messages.some(message => message.data?.source?.kind === 'goal_continue');

test('a goal that has a graph is not continued in the conversation', async () => {
  const { daemon, conversationId, provider, write } = await conversation('graph');
  goalRow(write, conversationId, 'graph-owned');
  await daemon.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ text: '先做第一步。', requestId: 'graph-owned-turn' }),
  });
  await expect.poll(async () => (await transcript(daemon, conversationId)).some(message => (message.text ?? '').includes('先做第一步')), { timeout: 60_000, interval: 250 }).toBe(true);
  // Give the runtime the same window it would use to queue a continuation.
  await new Promise(resolve => setTimeout(resolve, 4_000));
  const messages = await transcript(daemon, conversationId);
  // The acceptance request happens to quote the phrase "继续推进目标"; what matters is
  // whether a continuation turn was queued, which is what its source records.
  expect(continued(messages), JSON.stringify(messages.map(message => message.data ?? {})).slice(0, 1_500)).toBe(false);
  expect(provider.requests.length).toBeGreaterThan(0);
}, 120_000);

test('a goal without a graph is still continued', async () => {
  const { daemon, conversationId, provider, write } = await conversation('chat');
  goalRow(write, conversationId, '');
  await daemon.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ text: '先做第一步。', requestId: 'chat-owned-turn' }),
  });
  await expect.poll(async () => continued(await transcript(daemon, conversationId)), { timeout: 60_000, interval: 250 }).toBe(true);
  // The continuation is a second turn, and it was answered.
  await expect.poll(async () => (await transcript(daemon, conversationId)).map(message => message.text ?? '').join('\n'),
    { timeout: 60_000, interval: 250 }).toContain('继续做第二步。');
}, 120_000);
