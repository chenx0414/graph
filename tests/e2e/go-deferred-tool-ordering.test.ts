import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { launchCli } from '../helpers/cli-daemon.ts';
import { anthropicMessagesServer, type AnthropicMessagesPlan } from '../fixtures/anthropic-messages-server.ts';

/**
 * A2 — 后台工具不占住回合：第二条消息的答复早于慢工具完成，慢工具的结果之后只出现一次。
 *
 * 这次证明的是因果顺序，不是墙钟快慢：慢工具在一个被测试自己把守的闸门上等待（它只
 * 在测试写了 release 文件之后才继续），所以「第二条消息已经答复、而工具仍在运行」这件
 * 事不可能是机器快慢造成的巧合。旧行为（工具在回合内同步执行）下第二条消息的答复根本
 * 不可能出现——工具没返回，回合就没结束。
 *
 * 真实守护进程 + 真实 HTTP + 真工具（sh 真的跑，文件真的写）；只有外部 provider 被脚本化。
 * 读的是冻结契约里的 GET /api/conversations/{id}/tool-calls 与 /history，不读 sqlite 内部表。
 */

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** 一条 deferred 工具调用在冻结契约里的公开视图。 */
interface ToolCall {
  toolCallId: string;
  name: string;
  summary?: string;
  state: string;
  requestId?: string;
  operationId?: string;
  startedAt?: number;
  finishedAt?: number | null;
  reason?: string;
  result?: string;
}

/** 会话记录里的一条消息（/history）。 */
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

/** 一个带 git 仓库的项目目录：真工具真的在里面跑。 */
async function workspace(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Deferred tool ordering\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  return { root, project };
}

/** 真守护进程 + 脚本化的外部 provider，其余全部是真的。 */
async function service(root: string, project: string, plans: AnthropicMessagesPlan[]) {
  const provider = await anthropicMessagesServer(plans);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_DEFERRED_ORDERING_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-anthropic', grade: 'high',
      api: 'anthropic-messages', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
      credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_DEFERRED_ORDERING_KEY: 'synthetic-deferred-ordering-key' }, extraArgs: ['--execute'],
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

/** 一次工具调用的公开视图；调用不存在时返回 undefined。 */
async function toolCall(service: Service, conversationId: string, toolCallId: string) {
  const calls = await service.toolCalls(conversationId);
  return calls.find(call => call.toolCallId === toolCallId);
}

/** 契约没有规定 startedAt/finishedAt 的单位：按秒或毫秒都归一成毫秒，只断言先后。 */
function instantOf(value: number) {
  return value < 1e11 ? value * 1000 : value;
}

/** 工具行（conversation 里那条角色为 tool 的记录）携带的全部文本。 */
function toolRowText(message: Message) {
  return `${message.text}\n${JSON.stringify(message.data ?? {})}`;
}

test('A2: 第二条消息在慢工具完成之前就被答复，慢工具的结果之后只出现一次', async () => {
  const { root, project } = await workspace('graph-deferred-ordering-');
  // 闸门由测试把守：工具只有在 release 文件出现后才继续，所以「工具还在跑」是事实而不是时序竞猜。
  const releaseFile = join(project, 'release-ordering');
  const command = `while [ ! -f ${releaseFile} ]; do sleep 0.2; done; echo completed-marker`;
  const service_ = await service(root, project, [
    { tool: { id: 'slow-call', name: 'bash', input: { command, async: true } } },
    { text: '后台命令已被受理。' },
    { text: '第二条消息的答复。' },
    { text: '后台命令已完成。' },
  ]);

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await writeFile(releaseFile, 'released\n');
  };
  // 兜底：实现坏掉时（工具在回合内同步执行）测试不能吊死在工具的 120s 上限上，
  // 让慢工具在 20s 后自行完成；那时断言已经失败，红的原因仍然是顺序而不是超时。
  const failSafe = setTimeout(() => { void release(); }, 20_000);
  try {
    const created = await service_.request('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p', model: 'local', text: '把这条慢命令放到后台跑。', requestId: 'ordering-1' }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    // 派发时受理：工具已经在后台跑，会话看得见它（端点不存在时这里给出 404 而不是超时）。
    await expect.poll(async () => (await toolCall(service_, conversationId, 'slow-call'))?.state, {
      timeout: 60_000, interval: 200,
    }).toBe('running');
    const started = await toolCall(service_, conversationId, 'slow-call');
    expect(started, '受理之后没有这条工具调用的记录').toBeTruthy();
    expect(started!.startedAt ?? 0, '受理的调用没有开始时间').toBeGreaterThan(0);
    expect(started!.finishedAt ?? 0, '还没完成的调用不该有结束时间').toBe(0);

    // 第二条消息：慢工具还在跑，它必须现在就被答复。
    const second = await service_.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: '再问一句。', requestId: 'ordering-2' }),
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    let answer: Message | undefined;
    await expect.poll(async () => {
      answer = (await service_.messages(conversationId)).find(entry =>
        entry.role === 'assistant' && entry.text.includes('第二条消息的答复。'));
      return answer !== undefined;
    }, { timeout: 60_000, interval: 200 }).toBe(true);

    // 顺序的证明：答复已经在会话里，而同一个 toolCallId 的调用仍在运行。
    const stillRunning = await toolCall(service_, conversationId, 'slow-call');
    expect(stillRunning?.state, `第二条消息答复时，慢工具已经是 ${stillRunning?.state}`).toBe('running');
    expect(stillRunning!.finishedAt ?? 0, '慢工具在第二条消息答复之前就结束了').toBe(0);
    // 回合结束时没有把仍然活着的调用刷成完成：会话记录里它还是 running（F6）。
    const liveRows = (await service_.messages(conversationId))
      .filter(entry => entry.role === 'tool' && (entry.data ?? {})['toolCallId'] === 'slow-call');
    expect(liveRows.length, `仍在运行的调用留下了 ${liveRows.length} 条会话行`).toBe(1);
    expect(liveRows[0]!.state, '回合收尾把仍在后台跑的调用显示成了完成').toBe('running');

    // 放行工具，等它真正完成。
    await release();
    await expect.poll(async () => (await toolCall(service_, conversationId, 'slow-call'))?.state, {
      timeout: 90_000, interval: 200,
    }).toBe('settled');
    const settled = await toolCall(service_, conversationId, 'slow-call');
    expect(settled!.finishedAt ?? 0, '完成的调用没有结束时间').toBeGreaterThan(0);
    expect(settled!.result ?? '', '完成的调用没有带回命令输出').toContain('completed-marker');
    // 两个时间都来自守护进程的同一个时钟：答复先于工具完成，是因果顺序而不是客户端计时。
    expect(instantOf(answer!.createdAt), `答复时间 ${answer!.createdAt} 不早于工具完成时间 ${settled!.finishedAt}`)
      .toBeLessThan(instantOf(settled!.finishedAt!));

    // 延迟结果回到会话：同一个 toolCallId 的一行，文本带着工具输出。
    await expect.poll(async () => {
      const rows = (await service_.messages(conversationId)).filter(entry => entry.role === 'assistant'
        && entry.text.includes('后台命令已完成。'));
      return rows.length;
    }, { timeout: 60_000, interval: 200 }).toBe(1);

    const toolRows = (await service_.messages(conversationId))
      .filter(entry => entry.role === 'tool' && (entry.data ?? {})['toolCallId'] === 'slow-call');
    expect(toolRows.length, `同一 toolCallId 的工具行出现了 ${toolRows.length} 条`).toBe(1);
    expect(toolRowText(toolRows[0]!), '工具行没有带回命令输出').toContain('completed-marker');
    expect(toolRows[0]!.state, '完成的调用在会话记录里不是终态').toBe('done');
    // 结果只投递一次：数据行一条、唤醒一次（唤醒各自会带一轮模型请求）。
    expect(await service_.toolCalls(conversationId)).toHaveLength(1);
    expect(service_.provider.requests.length, '延迟结果被投递了不止一次').toBe(4);
  } finally {
    clearTimeout(failSafe);
    await release();
  }
}, 240_000);
