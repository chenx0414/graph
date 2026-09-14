import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openGraphServer } from '../../src/server/host.ts';
import { git } from '../../src/git/git.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-conversation-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-conversation-ui-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Deterministic master: each new user prompt selects investigation, a draft,
 * an overturn draft, or a status answer from the prompt text it received. */
async function browserProvider() {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { tools?: { function?: { name?: string } }[]; messages?: { role?: string; content?: unknown }[] } : {};
    const tools = (body.tools ?? []).map(tool => tool.function?.name ?? '');
    const messages = body.messages ?? [];
    const isMaster = tools.includes('propose_graph');
    const isNewPrompt = messages.at(-1)?.role === 'user';
    const lastUser = [...messages].reverse().find(message => message.role === 'user')?.content;
    const prompt = typeof lastUser === 'string' ? lastUser : Array.isArray(lastUser) ? lastUser.map(part => (part as { text?: string })?.text ?? '').join(' ') : '';
    const requirementVersion = Number(/Requirement version: (\d+)/.exec(prompt)?.[1] ?? 1);
    const draft = (summary: string) => ({
      requirementVersion, summary,
      acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
      nodes: [
        { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
        { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
      ],
    });
    const usage = { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish: string | null) => response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const end = (finish: string) => {
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
      response.end('data: [DONE]\n\n');
    };
    if (!isMaster) {
      chunk({ role: 'assistant', content: 'worker finished' }, null);
      end('stop');
      return;
    }
    if (!isNewPrompt) {
      chunk({ role: 'assistant', content: '本轮处理完成。' }, null);
      end('stop');
      return;
    }
    const toolCall = (id: string, name: string, args: unknown) => {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null);
      end('tool_calls');
    };
    if (prompt.includes('先不要')) {
      toolCall('call-draft-2', 'propose_graph', { proposalJson: JSON.stringify(draft('先验证性能瓶颈：只做基准与瓶颈定位')), requestId: 'ui-draft-2' });
      return;
    }
    if (prompt.includes('最小可用版')) {
      toolCall('call-draft-1', 'propose_graph', { proposalJson: JSON.stringify(draft('最小可用版：先打通登录调整之外的核心流程')), requestId: 'ui-draft-1' });
      return;
    }
    if (prompt.includes('卡在哪里')) {
      chunk({ role: 'assistant', content: '执行记录显示：work 进行中，check 等待 work；当前没有未处理问题。' }, null);
      end('stop');
      return;
    }
    if (prompt.includes('第一句')) {
      await new Promise(resolve => setTimeout(resolve, 900));
      chunk({ role: 'assistant', content: '收到第一条。' }, null);
      end('stop');
      return;
    }
    if (prompt.includes('第二句')) {
      chunk({ role: 'assistant', content: '两条都收到。' }, null);
      end('stop');
      return;
    }
    if (prompt.includes('重启后')) {
      chunk({ role: 'assistant', content: '重启后也收到了这条消息。' }, null);
      end('stop');
      return;
    }
    if (prompt.includes('还没决定')) {
      chunk({ role: 'assistant', content: '你更在意稳定性还是新功能？也可以先在左侧选一个项目，我先读一遍代码。' }, null);
      end('stop');
      return;
    }
    chunk({ role: 'assistant', content: '我在，继续。' }, null);
    end('stop');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const model: Model<'openai-completions'> = {
    id: 'local', name: 'Local', provider: 'local', api: 'openai-completions', baseUrl,
    reasoning: false, input: ['text'], contextWindow: 32_000, maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('local', { baseUrl, api: 'openai-completions', apiKey: 'local-key', models: [model] });
  return { baseUrl, modelRuntime };
}

function start(root: string, baseUrl: string, modelRuntime: ModelRuntime) {
  return openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'project', root: join(root, 'project') }],
    models: {
      entries: [{ id: 'local', provider: 'local', grade: 'high', api: 'openai-completions', baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'c' }],
      apiKey: 'local-key', modelRuntime,
      credentialFor: () => ({ credentialId: 'c', apiKey: 'local-key' }),
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    autoDrive: true,
    webDir,
    startup: { mode: 'execute', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
}

const includes = (page: import('playwright').Page, needle: string, timeout = 30_000) =>
  page.waitForFunction(text => document.body.innerText.includes(text), needle, { timeout });

test('a first-time user chats, drafts, confirms, keeps talking, and recovers after restart', async () => {
  const root = await temp('flow');
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'check.js'), 'console.log("check passed");\n');
  await writeFile(join(project, 'README.md'), '# Conversation project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'init']);

  const provider = await browserProvider();
  const stateDir = join(root, 'state');
  let server = await start(root, provider.baseUrl, provider.modelRuntime);
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const evidence = join(process.cwd(), 'docs', 'planning', 'acceptance-evidence', 'master-agent-entry');
  await mkdir(evidence, { recursive: true });

  // 1. Vague goal without a project or a feature task.
  await page.goto(server.url);
  await page.getByTestId('new-conversation-input').waitFor();
  await page.getByTestId('new-conversation-input').fill('我想改善这个项目，但还没决定做什么。');
  await page.getByTestId('new-conversation-start').click();
  await page.getByTestId('conversation').waitFor();
  await includes(page, '更在意稳定性');
  await page.screenshot({ path: join(evidence, '01-vague-goal.png'), fullPage: true });
  expect(await page.getByTestId('conversation-project').innerText()).toContain('未绑定项目');
  expect(await page.getByTestId('no-conversation-tasks').innerText()).toContain('尚无功能任务');

  // 2. Bind the project and let the master draft.
  await page.getByTestId('bind-select').selectOption('project');
  await page.getByTestId('bind-submit').click();
  await includes(page, '项目 project');
  await page.getByTestId('chat-input').fill('先做最小可用版，预算有限，登录先不改。');
  await page.getByTestId('chat-send').click();
  await page.getByTestId('proposal-draft').waitFor();
  expect(await page.getByTestId('proposal-draft').innerText()).toContain('最小可用版');
  // The draft graph renders from the same versioned proposal.
  await page.getByTestId('draft-graph').waitFor();
  await page.screenshot({ path: join(evidence, '02-first-draft.png'), fullPage: true });

  // 3. Overturn the draft before confirming; the new draft replaces it.
  await page.getByTestId('chat-input').fill('刚才那个方案先不要，改成先验证性能瓶颈。');
  await page.getByTestId('chat-send').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="proposal-draft"]')?.textContent?.includes('草稿 v2'));
  expect(await page.getByTestId('proposal-draft').innerText()).toContain('先验证性能瓶颈');

  // 4. Confirm the current draft: a feature task appears and starts.
  await page.getByTestId('accept-branch').fill('main');
  await page.getByTestId('confirm-draft').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="conversation-task-"]').length === 1);
  await includes(page, '已确认草稿 v2');
  await page.screenshot({ path: join(evidence, '03-confirmed.png'), fullPage: true });

  // 5. Keep asking while the task executes; the answer comes from the ledger.
  await page.getByTestId('chat-input').fill('现在卡在哪里？');
  await page.getByTestId('chat-send').click();
  await includes(page, '执行记录显示');
  expect(await page.locator('[data-testid^="conversation-task-"]').first().innerText()).toContain('work');

  // 6. Two messages in a row while the master is busy: both are kept.
  await page.getByTestId('chat-input').fill('第一句说明。');
  await page.getByTestId('chat-send').click();
  await page.getByTestId('chat-input').fill('第二句说明。');
  await page.getByTestId('chat-send').click();
  await includes(page, '两条都收到。');
  expect(await page.getByTestId('message-user').filter({ hasText: '第一句说明' }).count()).toBe(1);
  expect(await page.getByTestId('message-user').filter({ hasText: '第二句说明' }).count()).toBe(1);

  // 7. Reload restores the same conversation from the record.
  await page.reload();
  await page.getByTestId('conversation').waitFor();
  await includes(page, '两条都收到。');
  expect(await page.getByTestId('proposal-draft').innerText()).toContain('先验证性能瓶颈');
  await page.screenshot({ path: join(evidence, '04-reloaded.png'), fullPage: true });

  // 8. Pause, queue a message, restart the daemon on the same state, resume.
  await page.getByTestId('conversation-pause').click();
  await includes(page, '已暂停');
  await page.getByTestId('chat-input').fill('重启后处理的消息。');
  await page.getByTestId('chat-send').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="message-user"][data-state="pending"]')?.textContent?.includes('重启后处理的消息'));
  await server.close();
  server = await start(root, provider.baseUrl, provider.modelRuntime);
  cleanup.push(() => server.close());
  const conversationId = await page.evaluate(() => location.hash.replace('#/conversations/', ''));
  await page.goto(`${server.url}/#/conversations/${conversationId}`);
  await page.getByTestId('conversation').waitFor();
  await includes(page, '重启后处理的消息');
  await page.getByTestId('conversation-resume').click();
  await includes(page, '重启后也收到了这条消息。', 40_000);
  await page.screenshot({ path: join(evidence, '05-restart-resume.png'), fullPage: true });
}, 240_000);
