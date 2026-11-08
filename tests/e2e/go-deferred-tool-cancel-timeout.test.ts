import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { launchCli } from '../helpers/cli-daemon.ts';
import { anthropicMessagesServer, type AnthropicMessagesPlan } from '../fixtures/anthropic-messages-server.ts';

/**
 * A3 — 取消与超时走同一条收尾路径，不留僵尸 operation。
 *
 * 三个触发点各一例，读的都是冻结契约（GET tool-calls / POST cancel）：终态、原因、
 * 以及「同一条调用只有一条观察」。取消还多一层证据：命令进程真的不在了（ps 里没有它的
 * 命令行），而不只是记录被改成 cancelled；重启一例则证明守护进程被 SIGKILL 之后，下次
 * 启动把没人管的调用收成 interrupted，而不是永远「进行中」。
 *
 * 真实守护进程 + 真工具（sh 真的在跑一个等闸门的循环）；只有外部 provider 被脚本化。
 */

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

interface ToolCall {
  toolCallId: string;
  name: string;
  state: string;
  requestId?: string;
  operationId?: string;
  startedAt?: number;
  finishedAt?: number | null;
  reason?: string;
  result?: string;
  ttlMs?: number;
}

interface Message {
  id: string;
  seq: number;
  role: string;
  kind: string;
  text: string;
  state: string;
  data: Record<string, unknown> | null;
  createdAt: number;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function workspace(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Deferred tool settle\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  return { root, project };
}

/**
 * 启动一套真服务。同一个 root 再调用一次就是「重启」：状态目录、graph-home、web 目录
 * 都在 root 下面，第二次启动接着用第一次留下的库。
 */
async function service(root: string, project: string, plans: AnthropicMessagesPlan[]) {
  const provider = await anthropicMessagesServer(plans);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_DEFERRED_SETTLE_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-anthropic', grade: 'high',
      api: 'anthropic-messages', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
      credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_DEFERRED_SETTLE_KEY: 'synthetic-deferred-settle-key' }, extraArgs: ['--execute'],
  });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const toolCalls = async (conversationId: string) => {
    const reply = await request(`/api/conversations/${conversationId}/tool-calls`);
    expect(reply.status, `GET tool-calls answered ${reply.status}: ${JSON.stringify(reply.body)}`).toBe(200);
    return ((reply.body as { toolCalls?: ToolCall[] }).toolCalls ?? []);
  };
  const messages = async (conversationId: string) => {
    const reply = await request(`/api/conversations/${conversationId}/history`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return ((reply.body as { messages?: Message[] }).messages ?? []);
  };
  return { daemon, provider, request, toolCalls, messages };
}

type Service = Awaited<ReturnType<typeof service>>;

/** 这条命令行还活着吗：不是问记录，是问操作系统。 */
function commandAlive(token: string) {
  const probe = spawnSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
  return (probe.stdout ?? '').split('\n').some(line => line.includes(token));
}

async function openConversation(service_: Service, requestId: string) {
  const created = await service_.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: '在后台跑这条命令。', requestId }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return (created.body as { conversationId: string }).conversationId;
}

async function toolCall(service_: Service, conversationId: string, toolCallId: string) {
  return (await service_.toolCalls(conversationId)).find(call => call.toolCallId === toolCallId);
}

/** 该 toolCallId 在会话记录里的工具行，以及它们携带的文本（原因可能落在 data 里）。 */
function toolRows(messages: Message[], toolCallId: string) {
  return messages.filter(entry => entry.role === 'tool' && (entry.data ?? {})['toolCallId'] === toolCallId);
}

function rowText(message: Message) {
  return `${message.text}\n${JSON.stringify(message.data ?? {})}`;
}

test('A3 取消：终态 cancelled 带原因，重放同 requestId 不产生第二次取消，命令进程真的被杀掉', async () => {
  const { root, project } = await workspace('graph-deferred-cancel-');
  const token = 'deferred-cancel-gate-token';
  const gate = join(project, token);
  const command = `while [ ! -f ${gate} ]; do sleep 0.2; done; echo late-marker`;
  const service_ = await service(root, project, [
    { tool: { id: 'cancel-call', name: 'bash', input: { command, async: true } } },
    { text: '后台命令已被受理。' },
    { text: '后台命令已被取消。' },
  ]);
  const conversationId = await openConversation(service_, 'cancel-conversation');

  await expect.poll(async () => (await toolCall(service_, conversationId, 'cancel-call'))?.state, {
    timeout: 60_000, interval: 200,
  }).toBe('running');
  // 命令真的在跑：这一条让后面的「不在了」有意义。
  await expect.poll(() => commandAlive(token), { timeout: 30_000, interval: 200 }).toBe(true);

  const cancelled = await service_.request(`/api/conversations/${conversationId}/tool-calls/cancel-call/cancel`, {
    method: 'POST', body: JSON.stringify({ requestId: 'cancel-1' }),
  });
  expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
  const body = cancelled.body as { toolCallId?: string; state?: string; reason?: string };
  expect(body.toolCallId).toBe('cancel-call');
  expect(body.state).toBe('cancelled');
  expect((body.reason ?? '').trim(), '取消没有给出原因').not.toBe('');

  // 同一个 requestId 重放：同一结果，不产生第二次取消。
  const replay = await service_.request(`/api/conversations/${conversationId}/tool-calls/cancel-call/cancel`, {
    method: 'POST', body: JSON.stringify({ requestId: 'cancel-1' }),
  });
  expect(replay.status, JSON.stringify(replay.body)).toBe(200);
  const replayed = replay.body as { toolCallId?: string; state?: string; reason?: string };
  expect(replayed).toMatchObject({ toolCallId: 'cancel-call', state: 'cancelled', reason: body.reason });

  const calls = await service_.toolCalls(conversationId);
  expect(calls.length, `一次调用却留下了 ${calls.length} 条记录`).toBe(1);
  expect(calls[0]!.state).toBe('cancelled');
  expect(calls[0]!.finishedAt ?? 0, '取消之后没有结束时间').toBeGreaterThan(0);
  expect(calls[0]!.reason ?? '').toBe(body.reason ?? '');

  // 无僵尸：取消之后这个命令行在 ps 里不存在。
  await expect.poll(() => commandAlive(token), { timeout: 30_000, interval: 200 }).toBe(false);

  // 会话里只有一条观察，而且带原因。
  const rows = toolRows(await service_.messages(conversationId), 'cancel-call');
  expect(rows.length, `同一 toolCallId 的工具行出现了 ${rows.length} 条`).toBe(1);
  expect((rows[0]!.data ?? {})['error'], '取消的工具行没有标成失败').toBe(true);
  expect(rowText(rows[0]!), '取消原因没有到达会话记录').toContain((body.reason ?? '').trim());

  // 收尾写了唤醒：下一轮只来一次。
  await expect.poll(async () => (await service_.messages(conversationId))
    .filter(entry => entry.role === 'assistant' && entry.text.includes('后台命令已被取消。')).length, {
    timeout: 60_000, interval: 200,
  }).toBe(1);
}, 180_000);

test('A3 超时：终态 timed_out 带原因，只有一条观察，命令进程被收掉', async () => {
  const { root, project } = await workspace('graph-deferred-timeout-');
  const token = 'deferred-timeout-gate-token';
  const gate = join(project, token);
  // 闸门永远不开：只有收尾路径能结束这次调用。每次调用的 timeout（毫秒）就是它的
  // 截止时间——契约里 deadline_at 由派发时刻的事实决定，而这是公开接口里唯一的时长声明。
  const command = `while [ ! -f ${gate} ]; do sleep 0.2; done; echo never-marker`;
  const service_ = await service(root, project, [
    { tool: { id: 'timeout-call', name: 'bash', input: { command, async: true, timeout: 3000 } } },
    { text: '后台命令已被受理。' },
    { text: '后台命令超时了。' },
  ]);
  const conversationId = await openConversation(service_, 'timeout-conversation');

  await expect.poll(async () => (await toolCall(service_, conversationId, 'timeout-call'))?.state, {
    timeout: 60_000, interval: 200,
  }).toBe('running');

  await expect.poll(async () => (await toolCall(service_, conversationId, 'timeout-call'))?.state, {
    timeout: 60_000, interval: 500,
  }).toBe('timed_out');

  const call = await toolCall(service_, conversationId, 'timeout-call');
  expect(call!.finishedAt ?? 0, '超时之后没有结束时间').toBeGreaterThan(0);
  expect((call!.reason ?? '').trim(), '超时没有给出原因').not.toBe('');
  expect(await service_.toolCalls(conversationId)).toHaveLength(1);

  await expect.poll(() => commandAlive(token), { timeout: 30_000, interval: 200 }).toBe(false);

  const rows = toolRows(await service_.messages(conversationId), 'timeout-call');
  expect(rows.length, `同一 toolCallId 的工具行出现了 ${rows.length} 条`).toBe(1);
  expect((rows[0]!.data ?? {})['error'], '超时的工具行没有标成失败').toBe(true);
  expect(rowText(rows[0]!), '超时原因没有到达会话记录').toContain((call!.reason ?? '').trim());

  await expect.poll(async () => (await service_.messages(conversationId))
    .filter(entry => entry.role === 'assistant' && entry.text.includes('后台命令超时了。')).length, {
    timeout: 60_000, interval: 200,
  }).toBe(1);
}, 180_000);

test('A3 重启对账：被 SIGKILL 打断的调用下次启动收成 interrupted，且不新增观察', async () => {
  const { root, project } = await workspace('graph-deferred-interrupted-');
  const token = 'deferred-interrupted-gate-token';
  const gate = join(project, token);
  const command = `while [ ! -f ${gate} ]; do sleep 0.2; done; echo orphan-marker`;
  const first = await service(root, project, [
    { tool: { id: 'orphan-call', name: 'bash', input: { command, async: true } } },
    { text: '后台命令已被受理。' },
  ]);
  const conversationId = await openConversation(first, 'interrupted-conversation');

  await expect.poll(async () => (await toolCall(first, conversationId, 'orphan-call'))?.state, {
    timeout: 60_000, interval: 200,
  }).toBe('running');
  const before = toolRows(await first.messages(conversationId), 'orphan-call');
  expect(before.length, '受理之后会话里没有工具行').toBe(1);

  // 进程被硬杀：没有收尾机会，记录停在 running——这正是启动对账要收拾的现场。
  const exited = once(first.daemon.child, 'exit');
  expect(first.daemon.child.kill('SIGKILL')).toBe(true);
  await exited;

  const second = await service(root, project, [{ text: '后台命令中断了。' }]);
  await expect.poll(async () => (await toolCall(second, conversationId, 'orphan-call'))?.state, {
    timeout: 60_000, interval: 200,
  }).toBe('interrupted');
  const call = await toolCall(second, conversationId, 'orphan-call');
  expect((call!.reason ?? '').trim(), '中断没有给出原因').not.toBe('');
  expect(await second.toolCalls(conversationId)).toHaveLength(1);

  const after = toolRows(await second.messages(conversationId), 'orphan-call');
  expect(after.length, `对账之后工具行变成 ${after.length} 条`).toBe(1);
  expect(after[0]!.id, '对账新建了一条观察，而不是就地更新').toBe(before[0]!.id);
  expect((after[0]!.data ?? {})['error'], '中断的工具行没有标成失败').toBe(true);
  expect(rowText(after[0]!), '中断原因没有到达会话记录').toContain((call!.reason ?? '').trim());
}, 180_000);

test('A3 列表带建议轮询间隔与每条调用的保留时长', async () => {
  const { root, project } = await workspace('graph-deferred-interval-');
  const command = 'sleep 30; echo late-marker';
  const service_ = await service(root, project, [
    { tool: { id: 'interval-call', name: 'bash', input: { command, async: true } } },
    { text: '后台命令已被受理。' },
  ]);
  const conversationId = await openConversation(service_, 'interval-conversation');

  await expect.poll(async () => (await toolCall(service_, conversationId, 'interval-call'))?.toolCallId, {
    timeout: 60_000, interval: 200,
  }).toBe('interval-call');

  const reply = await service_.request(`/api/conversations/${conversationId}/tool-calls`);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  const body = reply.body as { toolCalls?: ToolCall[]; pollIntervalMs?: number };
  const interval = body.pollIntervalMs ?? 0;
  expect(interval, '列表没有给出建议的轮询间隔').toBeGreaterThanOrEqual(500);
  expect(interval, '轮询间隔比一次唤醒还慢，等于让人硬猜').toBeLessThanOrEqual(30_000);

  const call = (body.toolCalls ?? [])[0];
  expect(call, '列表里没有那条调用').toBeTruthy();
  expect(call!.ttlMs ?? 0, '列表没有说这条调用还被保留多久').toBeGreaterThan(0);
  expect(call!.ttlMs ?? 0, '保留时长超过了约定的上限').toBeLessThanOrEqual(60 * 60 * 1000);
}, 240_000);
