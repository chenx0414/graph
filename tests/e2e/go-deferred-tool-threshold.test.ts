import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { launchCli } from '../helpers/cli-daemon.ts';
import { anthropicMessagesServer, type AnthropicMessagesPlan } from '../fixtures/anthropic-messages-server.ts';

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

interface ToolCall {
  toolCallId: string;
  name: string;
  state: string;
  reason?: string;
  result?: string;
}

interface Message {
  id: string;
  seq: number;
  role: string;
  text: string;
  data: Record<string, unknown> | null;
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
  await writeFile(join(project, 'README.md'), '# Threshold\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  return { root, project };
}

async function service(root: string, project: string, plans: AnthropicMessagesPlan[], env: NodeJS.ProcessEnv = {}) {
  const provider = await anthropicMessagesServer(plans);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_DEFERRED_THRESHOLD_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-anthropic', grade: 'high',
      api: 'anthropic-messages', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
      credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_DEFERRED_THRESHOLD_KEY: 'synthetic-deferred-threshold-key', ...env },
    extraArgs: ['--execute'],
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

async function openConversation(service_: Service, requestId: string) {
  const created = await service_.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: '跑一条命令。', requestId }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return (created.body as { conversationId: string }).conversationId;
}

function toolRows(messages: Message[]) {
  return messages.filter(entry => entry.role === 'tool');
}

function served(service_: Service) {
  return JSON.stringify(service_.provider.requests);
}

test('阈值：命令超过阈值后自动交接给后台作业，回执当场到达、结果作为后续消息回来', async () => {
  const { root, project } = await workspace('graph-deferred-threshold-slow-');
  const service_ = await service(root, project, [
    { tool: { id: 'slow-call', name: 'bash', input: { command: 'sleep 5; echo late-marker' } } },
    { text: '命令已经转到后台了。' },
    { text: 'late-marker 回来了。' },
  ], { GRAPH_DEFER_THRESHOLD_MS: '1000' });
  const conversationId = await openConversation(service_, 'threshold-slow-conversation');

  await expect.poll(async () => (await service_.toolCalls(conversationId)).length, {
    timeout: 60_000, interval: 200,
  }).toBe(1);

  const call = (await service_.toolCalls(conversationId))[0]!;
  expect(call.name).toBe('bash');

  const rows = toolRows(await service_.messages(conversationId));
  expect(rows.length, `这一条调用在会话里留下了 ${rows.length} 条工具行`).toBe(1);
  await expect.poll(() => served(service_), { timeout: 60_000, interval: 200 })
    .toContain('已在后台执行，结果会作为后续消息到达');

  await expect.poll(async () => (await service_.toolCalls(conversationId))[0]?.state, {
    timeout: 120_000, interval: 500,
  }).toBe('settled');
  const settled = (await service_.toolCalls(conversationId))[0]!;
  expect(settled.result ?? '', '后台作业没有把命令输出写进记录').toContain('late-marker');

  await expect.poll(async () => (await service_.messages(conversationId))
    .filter(entry => entry.role === 'assistant' && entry.text.includes('late-marker 回来了。')).length, {
    timeout: 120_000, interval: 500,
  }).toBe(1);
}, 240_000);

test('阈值：阈值内完成的命令照旧内联返回，不留后台记录', async () => {
  const { root, project } = await workspace('graph-deferred-threshold-fast-');
  const service_ = await service(root, project, [
    { tool: { id: 'fast-call', name: 'bash', input: { command: 'echo quick-marker' } } },
    { text: '命令输出了 quick-marker。' },
  ]);
  const conversationId = await openConversation(service_, 'threshold-fast-conversation');

  await expect.poll(async () => (await service_.messages(conversationId))
    .filter(entry => entry.role === 'assistant' && entry.text.includes('命令输出了 quick-marker。')).length, {
    timeout: 120_000, interval: 500,
  }).toBe(1);

  const rows = toolRows(await service_.messages(conversationId));
  expect(rows.length, `这一条调用在会话里留下了 ${rows.length} 条工具行`).toBe(1);
  expect(served(service_), '快命令拿到的不是真实输出').toContain('quick-marker');
  expect(served(service_), '快命令被转成了后台作业').not.toContain('已在后台执行');

  const calls = await service_.toolCalls(conversationId);
  expect(calls.length, `快命令留下了 ${calls.length} 条后台记录`).toBe(0);
}, 240_000);

test('阈值：timeout 不超过阈值的命令保持同步，超时后不转后台', async () => {
  const { root, project } = await workspace('graph-deferred-threshold-timeout-');
  const service_ = await service(root, project, [
    { tool: { id: 'bounded-call', name: 'bash', input: { command: 'sleep 5; echo never-marker', timeout: 800 } } },
    { text: '命令超时了。' },
  ]);
  const conversationId = await openConversation(service_, 'threshold-timeout-conversation');

  await expect.poll(async () => (await service_.messages(conversationId))
    .filter(entry => entry.role === 'assistant' && entry.text.includes('命令超时了。')).length, {
    timeout: 120_000, interval: 500,
  }).toBe(1);

  const rows = toolRows(await service_.messages(conversationId));
  expect(rows.length, `这一条调用在会话里留下了 ${rows.length} 条工具行`).toBe(1);
  expect(served(service_), '带短 timeout 的命令被转成了后台作业').not.toContain('已在后台执行');

  const calls = await service_.toolCalls(conversationId);
  expect(calls.length, `带短 timeout 的命令留下了 ${calls.length} 条后台记录`).toBe(0);
}, 240_000);
