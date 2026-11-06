import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { chromium, type Page } from 'playwright';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { anthropicMessagesServer } from '../fixtures/anthropic-messages-server.ts';

/**
 * A5 — 控制台里：运行中的后台工具显示「进行中」、输入框可用、新消息能发出去并看到答复，
 * 后台工具失败时把原因显示出来。
 *
 * 这是浏览器 E2E：真的构建控制台、真的 Chromium、真的守护进程、真的 sh 命令。慢工具卡在
 * 测试自己把守的闸门上，所以「输入框可用、第二条消息已经被答复、而工具仍显示进行中」不是
 * 时序竞猜——闸门没开，工具就不可能完成。失败一例用一次会超时的后台调用，原因文本从冻结
 * 契约里读出来，再断言同一段文字出现在会话记录里（措辞不写死在测试里）。
 *
 * 这个文件在 tests/env-layers.json 里登记为 window-services 层：没有窗口服务的机器会如实
 * 跳过，而不是把环境缺失报成回归。
 */

interface ToolCall {
  toolCallId: string;
  state: string;
  reason?: string;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

/** 会话记录区域的可见文本（同一页面可能有多个列表，取可见的那个）。 */
function transcript(page: Page) {
  return page.getByTestId('message-list').locator('visible=true');
}

async function textOf(locator: ReturnType<Page['locator']>) {
  return locator.innerText().catch(() => '');
}

/** 把折叠起来的回合与工具组展开：原因文字要真的能被读到，而不只是躺在 DOM 里。 */
async function reveal(page: Page) {
  for (const testId of ['collapsed-turn', 'tool-activity-group']) {
    const nodes = page.getByTestId(testId);
    for (let index = 0; index < await nodes.count(); index += 1) {
      const node = nodes.nth(index);
      if (await node.getAttribute('data-open') === 'true') continue;
      const toggle = node.locator('button').first();
      if (await toggle.count() === 0) continue;
      await toggle.click();
      await expect.poll(async () => node.getAttribute('data-open')).toBe('true');
    }
  }
}

test('A5: 浏览器里后台工具显示进行中，输入可用并能继续对话，失败时显示原因', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-deferred-console-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Deferred tool console\n');
  const webDir = join(root, 'web');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });

  // 两道闸门把守两条后台命令：一条由测试放行（成功），一条永不放行（超时）。
  const releaseFile = join(project, 'console-release');
  const neverFile = join(project, 'console-never');
  const slowCommand = `while [ ! -f ${releaseFile} ]; do sleep 0.2; done; echo release-token`;
  const timeoutCommand = `while [ ! -f ${neverFile} ]; do sleep 0.2; done; echo never-marker`;
  const provider = await anthropicMessagesServer([
    { tool: { id: 'console-slow', name: 'bash', input: { command: slowCommand, async: true } } },
    { text: '后台命令已被受理。' },
    { text: '第二条消息的答复。' },
    { text: '后台命令已完成。' },
    { tool: { id: 'console-timeout', name: 'bash', input: { command: timeoutCommand, async: true, timeout: 3000 } } },
    { text: '后台命令超时了。' },
    { text: '后台超时已被记录。' },
  ]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_DEFERRED_CONSOLE_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-anthropic', grade: 'high',
      api: 'anthropic-messages', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
      credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath, webDir, env: { GRAPH_DEFERRED_CONSOLE_KEY: 'synthetic-deferred-console-key' }, extraArgs: ['--execute'],
  });
  cleanup.push(() => daemon.close());
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();

  const toolCalls = async (conversationId: string) => {
    const response = await daemon.request(`/api/conversations/${conversationId}/tool-calls`);
    expect(response.status, `GET tool-calls answered ${response.status}`).toBe(200);
    const body = await response.json() as { toolCalls?: ToolCall[] };
    return body.toolCalls ?? [];
  };

  await page.goto(daemon.url);
  await page.getByTestId('open-project-p').click();
  const conversation = page.locator('[data-testid="conversation"]:visible');
  const input = conversation.getByTestId('chat-input');
  const send = conversation.getByTestId('chat-send');
  await input.waitFor();
  await input.fill('把这条慢命令放到后台跑。');
  await send.click();

  // 受理之后：工具组显示「进行中」。
  const groups = conversation.getByTestId('tool-activity-group');
  await expect.poll(async () => groups.count(), { timeout: 90_000, interval: 250 }).toBeGreaterThan(0);
  await expect.poll(async () => (await groups.first().textContent()) ?? '', { timeout: 90_000, interval: 250 }).toContain('进行中');

  // 受理答复到了、后台命令还在跑：这一轮已经结束，界面不该再显示忙碌。
  await expect.poll(() => textOf(transcript(page)), { timeout: 90_000, interval: 250 }).toContain('后台命令已被受理。');
  // 忙碌时这个按钮会变成「暂停」，空闲时才是「发送」：后台工具不能让界面停在忙碌。
  await expect.poll(() => send.getAttribute('data-mode'), { timeout: 90_000, interval: 250 }).toBe('send');
  expect(await input.isEditable()).toBe(true);

  // 后台命令仍在跑的时候发第二条消息，并看见它被答复。
  await input.fill('再问一句。');
  await send.click();
  await expect.poll(() => textOf(transcript(page)), { timeout: 90_000, interval: 250 }).toContain('第二条消息的答复。');
  // 因果顺序：第二条消息已经被答复，而闸门没开，工具组仍然显示进行中。
  expect(await groups.first().textContent(), '第二条消息答复时工具已经不是进行中').toContain('进行中');

  // 放行：工具完成，界面换成完成态。按调用定位，不靠「第一个组」的位置。
  const slowGroup = conversation.locator('[data-testid="tool-activity-group"][data-tool-calls~="console-slow"]');
  await writeFile(releaseFile, 'released\n');
  await expect.poll(() => textOf(transcript(page)), { timeout: 90_000, interval: 250 }).toContain('后台命令已完成。');
  await expect.poll(async () => (await slowGroup.textContent()) ?? '', { timeout: 90_000, interval: 250 }).not.toContain('进行中');
  // 成功结算的调用是终态：行上 data-done 为 true，状态格是「完成」。
  const slowRow = page.locator('[data-testid="tool-activity-group"] li[data-tool-call="console-slow"]');
  await expect.poll(() => slowRow.getAttribute('data-done'), { timeout: 90_000, interval: 250 }).toBe('true');
  expect(await slowRow.getByTestId('tool-state').textContent()).toBe('完成');

  // 失败一例：后台命令超时，界面显示原因。用 Enter 提交，忙碌与否都能送达。
  await input.fill('这次让它超时。');
  await input.press('Enter');
  await expect.poll(() => textOf(transcript(page)), { timeout: 90_000, interval: 250 }).toContain('后台命令超时了。');
  const conversationId = page.url().split('/').at(-1) ?? '';
  let reason = '';
  await expect.poll(async () => {
    const timedOut = (await toolCalls(conversationId)).find(call => call.state === 'timed_out');
    reason = (timedOut?.reason ?? '').trim();
    return reason;
  }, { timeout: 90_000, interval: 250 }).not.toBe('');

  await expect.poll(() => page.locator('[data-testid="tool-activity-group"][data-error="true"]').count(), {
    timeout: 90_000, interval: 250,
  }).toBeGreaterThan(0);
  // 超时同样是终态：这条调用不能再显示「进行中」，组上带 data-error，原因就在组里可见。
  const timeoutRow = page.locator('[data-testid="tool-activity-group"] li[data-tool-call="console-timeout"]');
  await expect.poll(() => timeoutRow.getAttribute('data-done'), { timeout: 90_000, interval: 250 }).toBe('true');
  await expect.poll(() => timeoutRow.getAttribute('data-state'), { timeout: 90_000, interval: 250 }).toBe('timed_out');
  expect(await timeoutRow.getByTestId('tool-state').textContent()).toBe('已超时');
  const timeoutGroup = page.locator('[data-testid="tool-activity-group"][data-tool-calls~="console-timeout"]');
  await expect.poll(() => timeoutGroup.getAttribute('data-error'), { timeout: 90_000, interval: 250 }).toBe('true');
  expect(await timeoutGroup.textContent(), '超时的调用仍显示进行中').not.toContain('进行中');
  await expect.poll(async () => (await timeoutGroup.getByTestId('tool-error-reason').first().textContent()) ?? '', {
    timeout: 90_000, interval: 250,
  }).toContain(reason);
  // 每一轮都重新展开折算：回合在收尾时还会折叠一次，理由文字必须真的能被读到。
  await expect.poll(async () => {
    await reveal(page);
    return textOf(transcript(page));
  }, { timeout: 90_000, interval: 500 }).toContain(reason);
}, 240_000);

/**
 * A5 的后半段：失败与取消之后，界面必须把「还在跑」清掉，并给出原因。
 *
 * 两例都在同一条会话里、按顺序发生，脚本 provider 的计划因此不会被并发调度打乱：
 * 后台调用先被取消（真 sh 循环还在等闸门），再跑一条必然失败的调用（空命令，工具立刻报错，
 * 不依赖墙钟）。断言只读三样东西：冻结契约给的状态与原因、工具行的状态属性、
 * 以及读者能看见的文字。
 */
test('A5: 失败与取消之后工具行不再显示进行中，并在界面给出原因', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-deferred-console-terminal-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Deferred terminal console\n');
  const webDir = join(root, 'web');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });

  const gateFile = join(project, 'cancel-gate');
  const looping = `while [ ! -f ${gateFile} ]; do sleep 0.2; done; echo never`;
  const provider = await anthropicMessagesServer([
    { tool: { id: 'terminal-cancel', name: 'bash', input: { command: looping, async: true } } },
    { text: '取消用例已受理。' },
    { text: '取消已记录。' },
    { tool: { id: 'terminal-fail', name: 'bash', input: { command: '', async: true } } },
    { text: '失败用例已受理。' },
    { text: '失败已记录。' },
  ]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_DEFERRED_TERMINAL_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-anthropic', grade: 'high',
      api: 'anthropic-messages', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
      credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath, webDir, env: { GRAPH_DEFERRED_TERMINAL_KEY: 'synthetic-deferred-terminal-key' }, extraArgs: ['--execute'],
  });
  cleanup.push(() => daemon.close());
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();

  const toolCalls = async (conversationId: string) => {
    const response = await daemon.request(`/api/conversations/${conversationId}/tool-calls`);
    expect(response.status, `GET tool-calls answered ${response.status}`).toBe(200);
    return ((await response.json()) as { toolCalls?: ToolCall[] }).toolCalls ?? [];
  };
  const call = async (conversationId: string, toolCallId: string) =>
    (await toolCalls(conversationId)).find(item => item.toolCallId === toolCallId);
  const groupOf = (toolCallId: string) =>
    page.locator(`[data-testid="tool-activity-group"][data-tool-calls~="${toolCallId}"]`);
  const rowOf = (toolCallId: string) =>
    page.locator(`[data-testid="tool-activity-group"] li[data-tool-call="${toolCallId}"]`);

  await page.goto(daemon.url);
  await page.getByTestId('open-project-p').click();
  const conversation = page.locator('[data-testid="conversation"]:visible');
  const input = conversation.getByTestId('chat-input');
  const send = conversation.getByTestId('chat-send');
  await input.waitFor();

  // —— 取消：命令还在等闸门时被用户收回 ——
  await input.fill('这条命令我要收回。');
  await send.click();
  await expect.poll(() => textOf(transcript(page)), { timeout: 90_000, interval: 250 }).toContain('取消用例已受理。');
  const conversationId = page.url().split('/').at(-1) ?? '';
  await expect.poll(async () => (await call(conversationId, 'terminal-cancel'))?.state, {
    timeout: 90_000, interval: 250,
  }).toBe('running');
  const cancelled = await daemon.request(`/api/conversations/${conversationId}/tool-calls/terminal-cancel/cancel`, {
    method: 'POST', body: JSON.stringify({ requestId: 'a5-terminal-cancel-1' }),
  });
  expect(cancelled.status, await cancelled.text()).toBe(200);
  let cancelReason = '';
  await expect.poll(async () => {
    const terminal = await call(conversationId, 'terminal-cancel');
    cancelReason = (terminal?.reason ?? '').trim();
    return terminal?.state;
  }, { timeout: 90_000, interval: 250 }).toBe('cancelled');

  // 终态：行是 done、状态格是「已取消」，组不再是「进行中」，原因在组里可见，
  // 而且「用户自己收回」不该被画成一次失败（data-error=false）。
  await expect.poll(() => rowOf('terminal-cancel').getAttribute('data-done'), { timeout: 90_000, interval: 250 }).toBe('true');
  await expect.poll(() => rowOf('terminal-cancel').getAttribute('data-state'), { timeout: 90_000, interval: 250 }).toBe('cancelled');
  expect(await rowOf('terminal-cancel').getByTestId('tool-state').textContent()).toBe('已取消');
  const cancelGroup = groupOf('terminal-cancel');
  await expect.poll(async () => (await cancelGroup.textContent()) ?? '', { timeout: 90_000, interval: 250 }).not.toContain('进行中');
  await expect.poll(() => cancelGroup.getAttribute('data-error'), { timeout: 90_000, interval: 250 }).toBe('false');
  await expect.poll(async () => (await cancelGroup.getByTestId('tool-error-reason').first().textContent()) ?? '', {
    timeout: 90_000, interval: 250,
  }).toContain(cancelReason);
  await expect.poll(() => textOf(transcript(page)), { timeout: 90_000, interval: 250 }).toContain('取消已记录。');

  // —— 失败：后台调用必然失败（空命令），状态格是「失败」，组带 data-error ——
  await input.fill('再跑一条失败的。');
  await send.click();
  await expect.poll(() => textOf(transcript(page)), { timeout: 90_000, interval: 250 }).toContain('失败用例已受理。');
  let failReason = '';
  await expect.poll(async () => {
    const terminal = await call(conversationId, 'terminal-fail');
    failReason = (terminal?.reason ?? '').trim();
    return terminal?.state;
  }, { timeout: 90_000, interval: 250 }).toBe('failed');

  await expect.poll(() => rowOf('terminal-fail').getAttribute('data-done'), { timeout: 90_000, interval: 250 }).toBe('true');
  await expect.poll(() => rowOf('terminal-fail').getAttribute('data-state'), { timeout: 90_000, interval: 250 }).toBe('failed');
  await expect.poll(() => rowOf('terminal-fail').getAttribute('data-error'), { timeout: 90_000, interval: 250 }).toBe('true');
  expect(await rowOf('terminal-fail').getByTestId('tool-state').textContent()).toBe('失败');
  const failGroup = groupOf('terminal-fail');
  await expect.poll(async () => (await failGroup.textContent()) ?? '', { timeout: 90_000, interval: 250 }).not.toContain('进行中');
  await expect.poll(async () => (await failGroup.textContent()) ?? '', { timeout: 90_000, interval: 250 }).not.toContain('后台执行中');
  await expect.poll(() => page.locator('[data-testid="tool-activity-group"][data-error="true"]').count(), {
    timeout: 90_000, interval: 250,
  }).toBeGreaterThan(0);
  await expect.poll(async () => {
    await reveal(page);
    return (await failGroup.getByTestId('tool-error-reason').first().textContent()) ?? '';
  }, { timeout: 90_000, interval: 500 }).toContain(failReason);
}, 240_000);
