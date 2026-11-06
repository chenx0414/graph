import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { launchCli } from '../helpers/cli-daemon.ts';
import { anthropicMessagesServer, type AnthropicMessagesPlan } from '../fixtures/anthropic-messages-server.ts';

/**
 * A4 — 同一个 requestId 不产生第二次副作用。
 *
 * 模型在同一个回合里把同一个逻辑作业重发了一次（不同的 toolCallId、相同的 requestId 与
 * 参数）：第二次必须是第一次的受理结果，而不是第二个作业。可证伪的证据不是计数器，而是
 * 文件——真命令往同一个文件 append 一行，作业只跑了一次，文件就只有一行；第二次受理带回来
 * 的 operationId 与第一次相同，说明它指向的是同一个作业。
 *
 * 同一个 requestId 配上不同参数是另一件事：必须明确报错，不能悄悄复用别人的副作用。
 *
 * 真实守护进程 + 真工具；只有外部 provider 被脚本化。
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

/** 一次 provider 请求里某个工具调用拿到的结果文本。 */
interface ToolResultBlock { type?: string; tool_use_id?: string; text?: string; content?: unknown }
interface ProviderMessage { role?: string; content?: unknown }

function toolResults(request: { body: { messages?: ProviderMessage[] } } | undefined) {
  const blocks = (request?.body.messages ?? []).flatMap(message =>
    Array.isArray(message.content) ? message.content as ToolResultBlock[] : []);
  return blocks
    .filter(block => block.type === 'tool_result')
    .map(block => ({ id: block.tool_use_id ?? '', text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '') }));
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
  await writeFile(join(project, 'README.md'), '# Deferred tool idempotency\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  return { root, project };
}

async function service(root: string, project: string, plans: AnthropicMessagesPlan[]) {
  const provider = await anthropicMessagesServer(plans);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_DEFERRED_IDEMPOTENT_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-anthropic', grade: 'high',
      api: 'anthropic-messages', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
      credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_DEFERRED_IDEMPOTENT_KEY: 'synthetic-deferred-idempotent-key' }, extraArgs: ['--execute'],
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

function toolRows(messages: Message[], toolCallId: string) {
  return messages.filter(entry => entry.role === 'tool' && (entry.data ?? {})['toolCallId'] === toolCallId);
}

function rowText(message: Message) {
  return `${message.text}\n${JSON.stringify(message.data ?? {})}`;
}

test('A4: 同 requestId 同参数重放只有一个作业、一行副作用；不同参数明确报错', async () => {
  const { root, project } = await workspace('graph-deferred-idempotent-');
  const effectFile = join(project, 'side-effect.txt');
  const gate = join(project, 'idempotent-gate');
  // 命令本身 append 一行：作业跑了几次，文件就有几行。
  const command = `while [ ! -f ${gate} ]; do sleep 0.2; done; echo once >> ${effectFile}`;
  const service_ = await service(root, project, [
    { tool: { id: 'job-call-a', name: 'bash', input: { command, async: true, requestId: 'job-1' } } },
    // 同一逻辑作业重发：不同 toolCallId、相同 requestId 与参数。
    { tool: { id: 'job-call-b', name: 'bash', input: { command, async: true, requestId: 'job-1' } } },
    { text: '两次调用都已受理。' },
    // 同一个 requestId 换了参数：必须报错，不能复用第一个作业的副作用。
    { tool: { id: 'job-call-c', name: 'bash', input: { command: `echo twice >> ${effectFile}`, async: true, requestId: 'job-1' } } },
    { text: '冲突的请求被拒绝了。' },
    { text: '后台作业已完成。' },
  ]);

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await writeFile(gate, 'released\n');
  };
  const failSafe = setTimeout(() => { void release(); }, 30_000);
  try {
    const created = await service_.request('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p', model: 'local', text: '把这条命令放到后台跑。', requestId: 'idempotent-conversation' }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    await expect.poll(async () => {
      const calls = await service_.toolCalls(conversationId);
      return calls.find(call => call.toolCallId === 'job-call-a')?.state;
    }, { timeout: 60_000, interval: 200 }).toBe('running');

    // 第一个回合结束：重发的调用已经被受理过。
    await expect.poll(async () => (await service_.messages(conversationId))
      .some(entry => entry.role === 'assistant' && entry.text.includes('两次调用都已受理。')), {
      timeout: 60_000, interval: 200,
    }).toBe(true);

    // 只有一行作业：重发的调用没有启动第二个作业。
    const calls = await service_.toolCalls(conversationId);
    expect(calls.length, `同 requestId 重放留下了 ${calls.length} 行`).toBe(1);
    expect(calls[0]).toMatchObject({ toolCallId: 'job-call-a', requestId: 'job-1', state: 'running' });
    expect((calls[0]!.operationId ?? '').trim(), '作业没有 operationId').not.toBe('');

    // 第二次受理带回的是同一个 operationId：它说的是「这就是同一个作业」。
    const results = toolResults(service_.provider.requests[2] as unknown as { body: { messages?: ProviderMessage[] } });
    const first = results.find(entry => entry.id === 'job-call-a');
    const second = results.find(entry => entry.id === 'job-call-b');
    expect(first, '第一个调用没有拿到受理结果').toBeTruthy();
    expect(second, '重发的调用没有拿到结果').toBeTruthy();
    for (const result of [first!, second!]) {
      expect(result.text, `受理结果里没有 operationId：${result.text}`).toContain(calls[0]!.operationId!);
    }

    // 同一个 requestId 换了参数：报错，不改写已有作业。
    const conflict = await service_.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: '再试一次同样的作业。', requestId: 'idempotent-second' }),
    });
    expect(conflict.status, JSON.stringify(conflict.body)).toBe(200);
    await expect.poll(async () => (await service_.messages(conversationId))
      .some(entry => entry.role === 'assistant' && entry.text.includes('冲突的请求被拒绝了。')), {
      timeout: 60_000, interval: 200,
    }).toBe(true);

    const afterConflict = await service_.toolCalls(conversationId);
    expect(afterConflict.length, `冲突请求留下了 ${afterConflict.length} 行`).toBe(1);
    expect(afterConflict[0]).toMatchObject({ toolCallId: 'job-call-a', requestId: 'job-1', state: 'running' });

    const conflictRows = toolRows(await service_.messages(conversationId), 'job-call-c');
    expect(conflictRows.length, '冲突的调用没有在会话里留下记录').toBe(1);
    expect((conflictRows[0]!.data ?? {})['error'], '冲突的调用没有被记成失败').toBe(true);
    expect(rowText(conflictRows[0]!), '冲突的报错没有说清是哪个 requestId')
      .toMatch(/job-1|request[-_ ]?id/i);

    // 放行：一个作业，一行副作用。
    await release();
    await expect.poll(async () => (await service_.toolCalls(conversationId))
      .find(call => call.toolCallId === 'job-call-a')?.state, { timeout: 60_000, interval: 200 }).toBe('settled');
    expect(await readFile(effectFile, 'utf8'), '作业跑了不止一次').toBe('once\n');
    expect(await service_.toolCalls(conversationId)).toHaveLength(1);

    await expect.poll(async () => (await service_.messages(conversationId))
      .filter(entry => entry.role === 'assistant' && entry.text.includes('后台作业已完成。')).length, {
      timeout: 60_000, interval: 200,
    }).toBe(1);
  } finally {
    clearTimeout(failSafe);
    await release();
  }
}, 240_000);
