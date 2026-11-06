import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { launchCli } from '../helpers/cli-daemon.ts';
import { anthropicMessagesServer } from '../fixtures/anthropic-messages-server.ts';

/**
 * A6 — 快速工具仍在同一轮里同步返回，不多付一次模型往返。
 *
 * 异步是加法不是替换：一次 bash、一次最终答复，provider 只看到两次请求，第二次请求里
 * 就带着这次调用的结果。它也不该留下任何 deferred 记录——快速路径一行都没变。
 *
 * 真实守护进程 + 真工具（文件真的被写出来）；只有外部 provider 被脚本化。
 */

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

interface ContentBlock { type?: string; id?: string; tool_use_id?: string; content?: unknown }
interface ProviderMessage { role?: string; content?: unknown }
interface ProviderRequest { body: { messages?: ProviderMessage[]; tools?: { name?: string }[] } }

interface Message {
  id: string;
  role: string;
  kind: string;
  text: string;
  state: string;
  data: Record<string, unknown> | null;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

test('A6: 快速 bash 在同一轮返回，provider 恰好两次请求，第二次带着工具结果', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-tool-fast-path-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Fast path\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const marker = join(project, 'fast-path-marker.txt');
  const provider = await anthropicMessagesServer([
    { tool: { id: 'fast-call', name: 'bash', input: { command: `printf fast-path > ${marker} && printf fast-path` } } },
    { text: '命令已经跑完。' },
  ]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_FAST_PATH_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-anthropic', grade: 'high',
      api: 'anthropic-messages', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
      credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_FAST_PATH_KEY: 'synthetic-fast-path-key' }, extraArgs: ['--execute'],
  });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const messages = async (conversationId: string) => {
    const reply = await request(`/api/conversations/${conversationId}/history`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return ((reply.body as { messages?: Message[] }).messages ?? []);
  };

  const created = await request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: '写下那个标记文件。', requestId: 'fast-1' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;

  await expect.poll(async () => (await messages(conversationId))
    .some(entry => entry.role === 'assistant' && entry.text.includes('命令已经跑完。')), {
    timeout: 60_000, interval: 200,
  }).toBe(true);

  // 不多付往返：一次工具调用 + 一次最终答复。
  expect(provider.requests.length, `provider 收到了 ${provider.requests.length} 次请求`).toBe(2);
  const second = provider.requests[1] as ProviderRequest;
  const blocks = (second.body.messages ?? []).flatMap(message =>
    Array.isArray(message.content) ? message.content as ContentBlock[] : []);
  expect(blocks.some(block => block.type === 'tool_use' && block.id === 'fast-call'), '第二次请求里没有这次调用').toBe(true);
  const result = blocks.find(block => block.type === 'tool_result' && block.tool_use_id === 'fast-call');
  expect(result, '第二次请求里没有这次调用的结果').toBeTruthy();
  expect(JSON.stringify(result!.content ?? ''), '工具结果里没有命令输出').toContain('fast-path');

  // 同一个回合只有一条最终答复，工具行走的是同步路径。
  const history = await messages(conversationId);
  const answers = history.filter(entry => entry.role === 'assistant' && entry.text.includes('命令已经跑完。'));
  expect(answers.length, `最终答复出现了 ${answers.length} 条`).toBe(1);
  const toolRows = history.filter(entry => entry.role === 'tool' && (entry.data ?? {})['toolCallId'] === 'fast-call');
  expect(toolRows.length, '快速工具的会话行数不对').toBe(1);
  expect((toolRows[0]!.data ?? {})['error'] ?? false, '快速工具被记成了失败').toBe(false);

  // 同步工具没有 deferred 记录：后台调用视图是空的。
  const calls = await request(`/api/conversations/${conversationId}/tool-calls`);
  expect(calls.status, `GET tool-calls answered ${calls.status}`).toBe(200);
  expect((calls.body as { toolCalls?: unknown[] }).toolCalls ?? []).toEqual([]);
}, 180_000);
