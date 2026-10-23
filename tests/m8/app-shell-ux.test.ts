import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { launchCli } from '../helpers/cli-daemon.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;

beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-app-shell-ux-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);

afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-app-shell-ux-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A real Git project: confirming a draft requires the target branch to exist. */
function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

async function gitProject(dir: string) {
  await writeFile(join(dir, 'check.js'), 'console.log("check passed");\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'graph@example.invalid']);
  git(dir, ['config', 'user.name', 'Graph Test']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

/**
 * The console, served by the real Go daemon.
 *
 * The console is a client: the daemon only has to serve the shell and answer
 * the API. The models exist so the daemon starts; nothing here dispatches.
 */
async function consoleServer(root: string, options: { projects?: { id: string; root: string }[]; models?: number; model?: string; execute?: boolean } = {}) {
  const configPath = join(root, 'graph.config.json');
  // Without a model behind it the daemon only serves the console. A test that
  // needs the main Agent to act points it at a real provider.
  const entries = Array.from({ length: options.models ?? 1 }, (_, index) => ({
    id: index === 0 ? 'local' : `model-${index + 1}`, provider: options.model ? 'graph-master' : 'stub', grade: 'medium', api: 'openai-completions',
    baseUrl: options.model ?? 'http://127.0.0.1:1/v1', contextWindow: 2048, maxTokens: 128, credentialId: 'local',
  }));
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: options.projects ?? [{ id: 'alpha', root }],
    credentials: { local: { secretRef: 'GRAPH_SYNTH_KEY' } },
    models: { entries },
  }, null, 2));
  const daemon = await launchCli(root, {
    configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir,
    env: { HOME: root, GRAPH_SYNTH_KEY: 'synthetic-shell-key' },
    extraArgs: options.execute ? ['--execute'] : [],
  });
  cleanup.push(() => daemon.close());
  return daemon;
}

interface ScriptedStep { id: string; name: string; args: unknown }
interface ScriptedToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ScriptedMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ScriptedToolCall[] }
interface ScriptedBody { tools?: { function?: { name?: string } }[]; messages?: ScriptedMessage[] }

/**
 * A scripted model. It plays the plan in order, so the main Agent really
 * proposes what the test needs it to propose.
 */
async function scriptedProvider(plan: (body: ScriptedBody) => ScriptedStep[] | Promise<ScriptedStep[]>) {
  const results = new Map<string, string>();
  const requests: ScriptedBody[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ScriptedBody;
    requests.push(body);
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const next = (await plan(body)).find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** The prompt the library holds for one key: the override, else the default. */
async function libraryPrompt(promptRoot: string, key: string) {
  const override = await readFile(join(promptRoot, key), 'utf8').catch(() => null);
  if (override !== null) return override.trimEnd();
  const fallback = await readFile(join(promptRoot, 'defaults', key), 'utf8').catch(() => '');
  return fallback.trimEnd();
}

/** The tools the user turned off in the prompt library. */
async function libraryDisabledTools(promptRoot: string) {
  const raw = await readFile(join(promptRoot, 'tools.json'), 'utf8').catch(() => '{}');
  const parsed = JSON.parse(raw) as { disabled?: string[] };
  return parsed.disabled ?? [];
}

/** The proposal the main Agent offers: one node, one check, one acceptance. */
function workerProposal(summary: string, check = 'check', criterion = 'ok') {
  return {
    requirementVersion: 1,
    summary,
    acceptance: [{ id: criterion, description: '检查通过', checkNode: check }],
    definition: {
      schemaVersion: 2, name: summary, protocols: { data: { type: 'object' } },
      nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Implement the requested work', inputs: { job: { protocol: 'data' } },
        outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } },
      modules: { [check]: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.js'], output: 'result' } } },
      edges: { checkWork: { from: 'work.result', to: `${check}.job`, enabled: true } },
      acceptance: [{ id: criterion, description: '检查通过', kind: 'check', module: check }],
    },
  };
}

/** One conversation, created through the daemon's own door. */
async function createConversation(server: Daemon, body: Record<string, unknown>) {
  const response = await server.request('/api/conversations', { method: 'POST', body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ conversationId: string; taskId: string }>;
}

/** One conversation, read through the daemon's own door. */
async function conversationView(server: Daemon, conversationId: string) {
  const response = await server.request(`/api/conversations/${conversationId}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<ConversationView>;
}

interface Daemon {
  url: string;
  request(path: string, init?: RequestInit): Promise<Response>;
}

interface ConversationView {
  conversationId: string;
  anchorTaskId: string;
  master?: { status?: string };
  messages: { role: string; kind?: string; text?: string; data?: unknown }[];
  proposal?: { version: number; summary: string } | null;
  proposalHistory: { version: number }[];
  archivedProposals: { version: number }[];
  accepted: { taskId: string }[];
}

/** One task, read through the daemon's own door. */
async function taskView(server: Daemon, taskId: string) {
  const response = await server.request(`/api/tasks/${taskId}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ operations: { id: string; state: string }[]; master?: { status?: string } }>;
}

/** The catalog, read through the daemon's own door. */
async function catalogView(server: Daemon) {
  const response = await server.request('/api/catalog');
  expect(response.status).toBe(200);
  return response.json() as Promise<{ agentCombinations: { id: string; description: string }[] }>;
}


test('the shell groups conversations by project and keeps an unbound recent section', async () => {
  const root = await temp('sidebar');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });
  await createConversation(server, { text: '未绑定讨论', requestId: 'unbound' });
  await createConversation(server, { projectId: 'alpha', text: '项目内讨论', requestId: 'bound' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.getByTestId('new-conversation-input').waitFor();

  const sidebar = page.getByTestId('conversation-list');
  await expect.poll(() => sidebar.innerText()).toContain('未绑定讨论');
  await expect.poll(() => sidebar.innerText()).toContain('项目内讨论');
  for (const [heading, title] of [['项目', '项目内讨论'], ['最近', '未绑定讨论']] as const) {
    const toggle = sidebar.getByRole('button', { name: heading, exact: true });
    await toggle.click();
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    expect(await sidebar.getByText(title, { exact: true }).isVisible()).toBe(false);
    await toggle.click();
    expect(await sidebar.getByText(title, { exact: true }).isVisible()).toBe(true);
  }
  await page.getByTestId('new-conversation-input').focus();
  await page.mouse.move(700, 500);
  const add = page.getByTestId('new-conversation-recent');
  // Starting a conversation stays discoverable without hover, including keyboard and touch.
  await expect.poll(() => add.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
  await add.focus();
  expect(await add.evaluate(element => element === document.activeElement)).toBe(true);
  // The labelled rail keeps explicit names for assistive use.
  expect(await page.locator('a[href="#/inbox"]').getAttribute('aria-label')).toBe('问题');
  expect(await page.locator('a[href="#/catalog"]').getAttribute('aria-label')).toBe('资源库');
  expect(await page.locator('a[href="#/settings"]').getAttribute('aria-label')).toBe('设置');
  expect(await page.locator('a').filter({ hasText: '概览' }).count()).toBe(0);
  expect(await page.locator('a').filter({ hasText: '向导' }).count()).toBe(0);

  await page.getByTestId('new-conversation-project-alpha').click();
  await page.waitForFunction(() => location.hash.includes('project=alpha'));
  await page.waitForFunction(() => (document.querySelector('[data-testid="new-conversation-project"]') as HTMLSelectElement | null)?.value === 'alpha');
  expect(await page.getByTestId('new-conversation-project').evaluate((element: HTMLInputElement) => element.value)).toBe('alpha');

  await page.getByTestId('sidebar-toggle').click();
  await page.waitForFunction(() => document.querySelector('.sidebar')?.getAttribute('data-collapsed') === 'true');
  expect(await sidebar.isHidden()).toBe(true);
  await page.getByTestId('sidebar-toggle').click();
  await sidebar.waitFor({ state: 'visible' });

  // The new-chat page has nothing to detail, so the shell offers no drawer control for it:
  // the right drawer belongs to the conversation, which carries its own entry.
  expect(await page.getByTestId('workspace-drawer-toggle').count()).toBe(1);
  expect(await page.locator('[data-testid="detail-drawer"]').count()).toBe(0);
});

test('conversations archive from the sidebar and restore from settings', async () => {
  const root = await temp('archive-ui');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });
  const created = await createConversation(server, { projectId: 'alpha', text: '需要归档的对话', requestId: 'archive-ui' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url);
  const sidebar = page.getByTestId('conversation-list');
  await expect.poll(() => sidebar.innerText()).toContain('需要归档的对话');
  const row = page.locator('.sidebar-conversation-row').filter({ hasText: '需要归档的对话' });
  const archive = page.getByTestId(`archive-conversation-${created.conversationId}`);
  expect(await archive.evaluate(element => getComputedStyle(element).opacity)).toBe('0');
  await row.hover();
  await expect.poll(() => archive.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
  await archive.click();
  await expect.poll(() => sidebar.innerText()).not.toContain('需要归档的对话');

  await page.goto(`${server.url}/#/settings`);
  await page.locator('.settings-nav-item').filter({ hasText: '归档对话' }).click();
  await page.getByTestId(`archived-conversation-${created.conversationId}`).waitFor();
  expect(await page.getByTestId(`archived-conversation-${created.conversationId}`).innerText()).toContain('alpha');
  await page.getByTestId(`archived-conversation-${created.conversationId}`).getByRole('button', { name: '取消归档' }).click();
  await page.getByTestId('archived-empty').waitFor();

  await page.goto(server.url);
  await expect.poll(() => page.getByTestId('conversation-list').innerText()).toContain('需要归档的对话');
});

// The drawer opens on the task graph, so this test renders React Flow inside the drawer:
// that is slower than the old cheap first page and gets its own budget.
test('the task graph page keeps the permanent four-state legend', async () => {
  const root = await temp('task-graph-legend');
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await gitProject(project);
  const provider = await scriptedProvider(body => (body.tools ?? []).some(tool => tool.function?.name === 'propose_graph') ? [
    { id: 'proposal', name: 'propose_graph', args: { proposal: workerProposal('四态图例'), requestId: 'task-graph-legend-proposal' } },
  ] : []);
  cleanup.push(() => provider.close());
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root: project }], model: provider.baseUrl, execute: true });
  const created = await createConversation(server, { projectId: 'alpha', text: '图例任务', requestId: 'task-graph-legend-create' });
  await expect.poll(async () => (await conversationView(server, created.conversationId)).proposal?.version, { timeout: 60_000 }).toBe(1);
  const confirmed = await (await server.request(`/api/conversations/${created.conversationId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'task-graph-legend-confirm' }),
  })).json() as { taskId: string };

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/tasks/${confirmed.taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  await page.locator('.node-card[data-node-id="work"]').waitFor();
  await page.getByTestId('legend').waitFor();
  const legend = await page.getByTestId('legend').innerText();
  for (const label of ['待执行', '运行中', '已完成', '被阻塞']) expect(legend).toContain(label);
  // Exactly the four board-state items, and no legacy five-tier legend left.
  expect(await page.locator('[data-testid="legend"] [data-board-state]').count()).toBe(4);
  expect(await page.locator('.legend li').count()).toBe(0);
  expect(await page.getByTestId('legend').innerText()).not.toContain('待执行 / 就绪');
});

test('conversation pause and resume use one stateful action with visible feedback', async () => {
  const root = await temp('pause-feedback');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });
  const created = await createConversation(server, { projectId: 'alpha', text: '先讨论一下', requestId: 'pause-feedback' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);

  // The composer primary control is the single pause entry point, so the header
  // no longer repeats it. Reach the paused state through the same endpoint the
  // composer calls, then resume through the composer button itself.
  expect(await page.getByTestId('conversation-pause').count()).toBe(0);
  expect(await page.getByTestId('conversation-resume').count()).toBe(0);
  const paused = await server.request(`/api/conversations/${created.conversationId}/pause`, {
    method: 'POST', body: JSON.stringify({ requestId: 'pause-feedback-pause' }),
  });
  expect(paused.status).toBe(200);
  await page.reload();
  await page.getByTestId('conversation-paused-notice').waitFor();
  expect(await page.getByTestId('conversation-paused-notice').innerText()).toContain('当前工具调用收尾后停下');
  await expect.poll(() => page.getByTestId('master-status').innerText()).toContain('已暂停');

  // Empty composer while paused: the primary button is the resume action.
  await page.getByTestId('chat-send').click();
  await page.getByTestId('conversation-paused-notice').waitFor({ state: 'detached' });
  expect(await page.getByTestId('toasts').innerText()).toContain('主 Agent 对话已继续');
});

test('the right drawer toggle stays available and opens an empty state', async () => {
  const root = await temp('empty-drawer');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });
  const created = await createConversation(server, { projectId: 'alpha', text: '还没有执行信息', requestId: 'empty-drawer' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const toggle = page.getByTestId('drawer-entry');
  await toggle.waitFor();
  expect(await toggle.getAttribute('data-open')).toBe('false');

  // Without a proposal there is no draft entry point and the drawer stays shut.
  await page.locator('.conversation-main').waitFor();
  expect(await page.getByTestId('conversation-graph').count()).toBe(0);
  expect(await page.locator('.conversation-composer-wrap').isVisible()).toBe(true);

  await toggle.click();
  await page.getByTestId('detail-drawer').waitFor();
  expect(await page.getByTestId('detail-empty').innerText()).toContain('暂无详情');
  expect(await toggle.getAttribute('data-open')).toBe('true');

  await toggle.click();
  await expect.poll(() => toggle.getAttribute('data-open')).toBe('false');
  await page.getByTestId('detail-drawer').waitFor({ state: 'hidden' });
});

test('Escape closes the model menu before it interrupts the running Agent', async () => {
  const root = await temp('escape-interrupt');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const interrupted: string[] = [];
  // The model takes its time, so the turn is still running when the console
  // asks to interrupt it.
  const provider = await scriptedProvider(async () => { await new Promise(resolve => setTimeout(resolve, 15_000)); return []; });
  cleanup.push(() => provider.close());
  const server = await consoleServer(root, { model: provider.baseUrl, execute: true });
  const created = await createConversation(server, { text: '开始一个可打断的回合。', requestId: 'escape-interrupt' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await expect.poll(async () => (await conversationView(server, created.conversationId)).master?.status, { timeout: 60_000 }).toBe('running');
  // The interruption only lands while the model is really in flight.
  await expect.poll(() => provider.requests.length, { timeout: 60_000 }).toBeGreaterThan(0);

  await page.getByTestId('model-control').click();
  await page.getByTestId('model-menu').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('model-menu').waitFor({ state: 'detached' });
  // The menu closed; the turn it was opened over kept running.
  expect((await conversationView(server, created.conversationId)).master?.status).toBe('running');

  // The console knows the turn is running, so its own Escape is the interrupt.
  await expect.poll(() => page.getByTestId('chat-send').getAttribute('data-mode'), { timeout: 30_000 }).toBe('pause');
  await page.keyboard.press('Escape');
  // The turn really stopped: the conversation records the interruption.
  await expect.poll(async () => (await conversationView(server, created.conversationId)).messages
    .filter(message => message.kind === 'error' && (message.text ?? '').includes('已打断')).length,
    { timeout: 60_000 }).toBe(1);
  await expect.poll(async () => (await taskView(server, created.taskId)).operations.filter(operation => operation.state === 'interrupted').length,
    { timeout: 60_000 }).toBe(1);
}, 180_000);

test('the project picker adds a local project to the sidebar', async () => {
  const root = await temp('project-dialog');
  const initial = join(root, 'initial');
  const picked = join(root, 'picked');
  await mkdir(initial, { recursive: true });
  await mkdir(picked, { recursive: true });
  const daemon = await consoleServer(root, { projects: [{ id: 'initial', root: initial }] });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(path => {
    window.graph = {
      isDesktop: true,
      pickDirectory: async () => path,
      openResource: async () => ({ opened: true }),
      saveSecret: async () => ({ stored: true, applied: true }),
      secretStatus: async () => ({}),
      relaunch: async () => ({ url: location.origin }),
    };
  }, picked);
  await page.goto(daemon.url);
  await page.getByTestId('project-create-open').click();
  const dialog = page.getByTestId('create-project-dialog');
  await dialog.waitFor();
  await page.getByTestId('project-pick').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="project-name"]') as HTMLInputElement | null)?.value === 'picked');
  const createButton = page.getByTestId('project-create');
  await createButton.click();
  await page.getByTestId('create-project-dialog').waitFor({ state: 'detached' });
  await page.getByTestId('new-conversation-project-picked').waitFor();
}, 30_000);

test('agent markdown renders and tool activity appears before the final answer', async () => {
  const root = await temp('markdown');
  const server = await consoleServer(root);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/api/conversations/synthetic', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'synthetic',
      title: 'Markdown',
      projectId: 'alpha',
      projectRoot: root,
      workspaceProjectId: 'alpha',
      anchorTaskId: 'anchor',
      createdAt: Date.now(),
      requirementVersion: 1,
      paused: false,
      messages: [
        { id: 'answer', seq: 2, role: 'assistant', kind: 'chat', text: '## 结果\n\n- **完成**\n\n`code`\n\n| Agent | 作用 |\n| :--- | ---: |\n| coder | 实现 |\n| reviewer | 审查 |', data: null, state: 'done', operationId: 'op', turn: 1, createdAt: Date.now(), updatedAt: Date.now() },
        { id: 'tool', seq: 3, role: 'tool', kind: 'tool', text: 'read README.md', data: { toolCallId: 'tool-1' }, state: 'done', operationId: 'op', turn: 1, createdAt: Date.now(), updatedAt: Date.now() },
      ],
      messageCount: 2,
      questions: [],
      proposal: null,
      accepted: [],
      master: null,
      cost: { unknown: false, amount: 0 },
      usage: { used: 0, budget: null, unlimited: true },
      telemetry: {
        model: 'local',
        thinkingLevel: 'off',
        cacheHitRate: 0.75,
        cachedInput: 75,
        cacheInput: 100,
        contextTokens: 8_000,
        contextLimit: 32_000,
        contextPercent: 25,
      },
      tasks: [],
      cursor: 1,
    }),
  }));
  await page.goto(`${server.url}/#/conversations/synthetic`);
  await page.getByTestId('conversation').waitFor();
  await page.locator('.markdown-body h2').waitFor();
  expect(await page.getByTestId('message-assistant').innerText()).toContain('最终回答');
  expect(await page.locator('.markdown-body strong').innerText()).toBe('完成');
  expect(await page.locator('.markdown-body code').innerText()).toBe('code');
  expect(await page.locator('.markdown-body table').count()).toBe(1);
  expect(await page.locator('.markdown-body th').nth(0).innerText()).toBe('Agent');
  expect(await page.locator('.markdown-body th').nth(1).getAttribute('data-align')).toBe('right');
  expect(await page.locator('.markdown-body td').nth(2).innerText()).toBe('reviewer');
  const order = await page.locator('.conversation-thread').innerText();
  expect(order.indexOf('读取 1 项')).toBeLessThan(order.indexOf('主 Agent'));
  // A finished turn folds its thinking and tool calls behind one muted line, so the
  // answer is what the reader sees.
  const folded = page.getByTestId('collapsed-turn');
  await folded.waitFor();
  expect(await folded.getAttribute('data-open')).toBe('false');
  expect(await page.getByTestId('tool-activity-group').count()).toBe(0);
  expect(await page.getByTestId('message-assistant').innerText()).toContain('最终回答');
  expect(await page.getByTestId('telemetry-cache').innerText()).toContain('75%');
  expect(await page.getByTestId('telemetry-context').innerText()).toContain('8,000 / 32,000');
  await expect.poll(() => page.getByTestId('telemetry-model').innerText()).toContain('local');
  expect(await page.getByTestId('telemetry-thinking').innerText()).toContain('思考 off');
});

test('live tool activity groups and streamed markdown follow the transcript tail', async () => {
  const root = await temp('stream');
  const server = await consoleServer(root);

  const messages = Array.from({ length: 24 }, (_, index) => ({
    id: `history-${index}`,
    seq: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    kind: 'chat',
    text: `历史消息 ${index + 1}`,
    data: null,
    state: 'done',
    operationId: null,
    turn: 1,
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/api/conversations/streaming', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'streaming',
      title: '实时流',
      projectId: 'alpha',
      projectRoot: root,
      workspaceProjectId: 'alpha',
      anchorTaskId: 'anchor',
      createdAt: Date.now(),
      requirementVersion: 1,
      paused: false,
      messages,
      messageCount: messages.length,
      questions: [],
      proposal: null,
      proposalHistory: [],
      accepted: [],
      master: {
        nodeId: 'master',
        status: 'running',
        model: 'local',
        used: 42,
        budget: null,
        unlimited: true,
        definitionVersion: 'main@1',
        cost: { unknown: false, amount: 0 },
      },
      cost: { unknown: false, amount: 0 },
      usage: { used: 42, budget: null, unlimited: true },
      telemetry: {
        model: 'local',
        thinkingLevel: 'off',
        cacheHitRate: null,
        cachedInput: 0,
        cacheInput: 0,
        contextTokens: null,
        contextLimit: null,
        contextPercent: null,
      },
      tasks: [],
      cursor: 0,
    }),
  }));
  await page.route('**/api/conversations/streaming/events/stream*', route => {
    const events = [
      { cursor: 1, type: 'message.tool', data: { operationId: 'op-live', phase: 'start', toolCallId: 'tool-live', toolName: 'read', summary: 'src/web/Conversation.tsx' } },
      { cursor: 2, type: 'message.delta', data: { operationId: 'op-live', text: '## 实时输出\n\n' } },
      { cursor: 3, type: 'message.delta', data: { operationId: 'op-live', text: '正在平滑追加内容。' } },
    ];
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    });
  });

  await page.goto(`${server.url}/#/conversations/streaming`);
  await page.getByTestId('streaming').waitFor();
  expect(await page.getByTestId('streaming').innerText()).toContain('思考与过程 · 生成中');
  const tools = page.getByTestId('tool-activity-group');
  await tools.waitFor();
  expect(await tools.getAttribute('data-active')).toBe('true');
  // Tool calls stay folded away by default, even while they are running.
  expect(await tools.getAttribute('data-open')).toBe('false');
  expect(await tools.innerText()).toContain('正在读取 src/web/Conversation.tsx');
  await expect.poll(() => page.locator('.markdown-body h2').last().innerText()).toBe('实时输出');
  expect(await page.getByTestId('message-list').getAttribute('data-pinned')).toBe('true');
  await expect.poll(async () => page.getByTestId('message-list').evaluate(element => {
    const thread = element as HTMLElement;
    return thread.scrollHeight - thread.scrollTop - thread.clientHeight;
  })).toBeLessThanOrEqual(4);

  await page.waitForTimeout(160);
  await page.getByTestId('message-list').evaluate(element => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.getByTestId('jump-to-latest').waitFor();
  expect(await page.getByTestId('message-list').getAttribute('data-pinned')).toBe('false');
  await page.getByTestId('jump-to-latest').click();
  await expect.poll(() => page.getByTestId('message-list').getAttribute('data-pinned')).toBe('true');
});

test('a coarse streamed delta is revealed progressively instead of landing as one block', async () => {
  const root = await temp('coarse-stream');
  const server = await consoleServer(root);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/api/conversations/coarse-stream', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'coarse-stream',
      title: '粗粒度流',
      projectId: 'alpha',
      projectRoot: root,
      workspaceProjectId: 'alpha',
      anchorTaskId: 'anchor',
      createdAt: Date.now(),
      requirementVersion: 1,
      paused: false,
      messages: [],
      messageCount: 0,
      streams: [],
      questions: [],
      proposal: null,
      proposalHistory: [],
      accepted: [],
      master: {
        nodeId: 'master',
        status: 'running',
        model: 'local',
        used: 42,
        budget: null,
        unlimited: true,
        definitionVersion: 'main@1',
        cost: { unknown: false, amount: 0 },
      },
      cost: { unknown: false, amount: 0 },
      usage: { used: 42, budget: null, unlimited: true },
      telemetry: {
        model: 'local',
        thinkingLevel: 'off',
        cacheHitRate: null,
        cachedInput: 0,
        cacheInput: 0,
        contextTokens: null,
        contextLimit: null,
        contextPercent: null,
      },
      tasks: [],
      cursor: 0,
    }),
  }));
  const fullText = '这是一段由供应商一次返回的完整长文本。客户端仍应按稳定节奏逐段揭示，而不是让它瞬间整块出现。'.repeat(4);
  await page.route('**/api/conversations/coarse-stream/events/stream*', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({
      cursor: 1,
      type: 'message.delta',
      data: {
        operationId: 'op-coarse',
        entryId: 'op-coarse',
        partId: 'text',
        len: fullText.length,
        reset: true,
        text: fullText,
      },
    })}\n\n`,
  }));

  await page.goto(`${server.url}/#/conversations/coarse-stream`);
  const streaming = page.getByTestId('streaming');
  await streaming.waitFor();
  await expect.poll(async () => Number(await streaming.getAttribute('data-reveal-length'))).toBeGreaterThan(0);
  const firstLength = Number(await streaming.getAttribute('data-reveal-length'));
  expect(firstLength).toBeLessThan(fullText.length);
  await expect.poll(
    () => streaming.getAttribute('data-reveal-length').then(Number),
    { timeout: 5_000 },
  ).toBe(fullText.length);
});

test('interrupted retry streams are removed before the durable final answer', async () => {
  const root = await temp('retry-stream');
  const server = await consoleServer(root);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const view = {
    id: 'retry-stream',
    title: '重试流',
    projectId: 'alpha',
    projectRoot: root,
    workspaceProjectId: 'alpha',
    anchorTaskId: 'anchor',
    createdAt: Date.now(),
    requirementVersion: 1,
    paused: false,
    messages: [{
      id: 'user', seq: 1, role: 'user', kind: 'chat', text: '你好', data: null,
      state: 'delivered', operationId: 'op-old', turn: 1, createdAt: Date.now(), updatedAt: Date.now(),
    }],
    messageCount: 1,
    questions: [],
    proposal: null,
    proposalHistory: [],
    accepted: [],
    master: { nodeId: 'master', status: 'succeeded', model: 'local', used: 0, budget: null, unlimited: true, definitionVersion: 'main@1', cost: { unknown: false, amount: 0 } },
    cost: { unknown: false, amount: 0 },
    usage: { used: 0, budget: null, unlimited: true },
    telemetry: { model: 'local', thinkingLevel: 'off', cacheHitRate: null, cachedInput: 0, cacheInput: 0, contextTokens: null, contextLimit: null, contextPercent: null },
    tasks: [],
    cursor: 0,
  };
  await page.route('**/api/conversations/retry-stream', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(view),
  }));
  await page.route('**/api/conversations/retry-stream/events/stream*', route => {
    const events = [
      { cursor: 1, type: 'message.delta', data: { operationId: 'op-old', text: '旧的流式回答' } },
      { cursor: 2, type: 'message.tool', data: { operationId: 'op-old', phase: 'start', toolCallId: 'old-tool', toolName: 'read', summary: 'old.md' } },
      { cursor: 3, type: 'operation.interrupted', data: { operationId: 'op-old' } },
      { cursor: 4, type: 'message.delta', data: { operationId: 'op-final', text: '最终回答' } },
      { cursor: 5, type: 'message.created', data: { message: { id: 'final', seq: 2, role: 'assistant', kind: 'chat', text: '最终回答', data: null, state: 'done', operationId: 'op-final', turn: 2, createdAt: Date.now(), updatedAt: Date.now() } } },
      { cursor: 6, type: 'operation.result', data: { operationId: 'op-final' } },
    ];
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    });
  });

  await page.goto(`${server.url}/#/conversations/retry-stream`);
  const answer = page.getByTestId('message-assistant');
  // The bubble exists before its final text is applied (the same stream carries both), so reading it the
  // moment the element appears is a race — and under the full parallel gate it lost: `expected '' to
  // contain '最终回答'`. Wait for the content the test is actually about.
  await expect.poll(() => answer.innerText()).toContain('最终回答');
  expect(await page.getByTestId('streaming').count()).toBe(0);
  expect(await page.getByTestId('tool-activity-group').count()).toBe(0);
  expect(await page.getByTestId('message-assistant').count()).toBe(1);
});

test('the composer model control switches model and thinking as one persisted selection', async () => {
  const root = await temp('model-control');
  const server = await consoleServer(root, { models: 2 });
  const selections: { model?: string; thinkingLevel?: string }[] = [];

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      projects: [{ id: 'alpha', root }],
      models: [
        // Each model carries the strengths it accepts: an xai-style model tops
        // out at xhigh, so the slider must not offer a level it cannot take.
        {
          id: 'local', grade: 'high', credentialId: 'local', contextWindow: 32_000, reasoning: true,
          thinkingOptions: [
            { level: 'off', label: '关闭' }, { level: 'low', label: 'low' },
            { level: 'medium', label: 'medium' }, { level: 'xhigh', label: 'xhigh' },
          ],
        },
        { id: 'fast', grade: 'medium', credentialId: 'local', contextWindow: 16_000, reasoning: false, thinkingOptions: [] },
      ],
      definitions: [],
      capabilities: [],
    }),
  }));
  await page.route('**/api/conversations/synthetic/model', async route => {
    selections.push(JSON.parse(route.request().postData() ?? '{}') as { model?: string; thinkingLevel?: string });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ changed: true }) });
  });
  await page.route('**/api/conversations/synthetic', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'synthetic', title: 'Model control', projectId: 'alpha', projectRoot: root,
      workspaceProjectId: 'alpha', anchorTaskId: 'anchor', createdAt: Date.now(), requirementVersion: 1, paused: false,
      messages: [], messageCount: 0, questions: [], proposal: null, accepted: [], master: null,
      cost: { unknown: false, amount: 0 }, usage: { used: 0, budget: null, unlimited: true },
      telemetry: {
        model: 'local', thinkingLevel: 'off', cacheHitRate: null, cachedInput: 0, cacheInput: 0,
        contextTokens: null, contextLimit: 32_000, contextPercent: null,
      },
      tasks: [], cursor: 1,
    }),
  }));
  await page.goto(`${server.url}/#/conversations/synthetic`);
  const control = page.getByTestId('model-control');
  await control.waitFor();
  expect(await control.evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('1px');
  expect(await page.getByTestId('telemetry-model').evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('0px');
  expect(await page.getByTestId('telemetry-thinking').evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('0px');
  await control.click();
  await page.getByTestId('model-menu').waitFor();
  const slider = page.getByTestId('thinking-slider');
  await slider.evaluate(element => {
    const input = element as HTMLInputElement;
    input.value = '3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await expect.poll(() => selections.length).toBe(1);
  expect(selections[0]).toMatchObject({ model: 'local', thinkingLevel: 'xhigh' });
  expect(await page.getByTestId('toasts').innerText()).not.toContain('已切换为');
  await page.getByTestId('model-menu').waitFor();

  await page.getByTestId('model-option-fast').click();
  await expect.poll(() => selections.length).toBe(2);
  expect(selections[1]).toMatchObject({ model: 'fast', thinkingLevel: 'off' });
  await page.getByTestId('model-menu').waitFor();
  await page.getByTestId('tab-open-0').click();
  await page.getByTestId('model-menu').waitFor({ state: 'detached' });
});

test('the resource library groups reusable assets and includes graph architectures', async () => {
  const root = await temp('resources');
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const skill = join(capabilityRoot, 'research');
  const mcp = join(capabilityRoot, 'jira');
  const extension = join(capabilityRoot, 'pi-mcp-extension');
  const prompt = join(capabilityRoot, 'architect');
  await Promise.all([mkdir(skill, { recursive: true }), mkdir(mcp, { recursive: true }), mkdir(extension, { recursive: true }), mkdir(prompt, { recursive: true })]);
  await writeFile(join(skill, 'SKILL.md'), '# Research\n');
  await writeFile(join(skill, 'capability.json'), JSON.stringify({ id: 'research', kind: 'skill', version: '1.0.0', name: 'Preserving Productive Tensions', description: '保留多个有效方案，避免过早收敛。' }));
  await writeFile(join(mcp, 'capability.json'), JSON.stringify({ id: 'jira', kind: 'mcp', version: '1.0.0', name: 'Jira', description: 'Jira 工单管理。', command: 'node', args: ['./server.mjs'] }));
  await writeFile(join(mcp, 'server.mjs'), 'export {};\n');
  await writeFile(join(extension, 'capability.json'), JSON.stringify({ id: 'pi-mcp-extension', kind: 'pi-extension', version: '1.0.0', name: 'Pi MCP Extension', description: '帮助 Pi 加载并调用 MCP server。', entry: './index.mjs' }));
  await writeFile(join(extension, 'index.mjs'), 'export default function () {}\n');
  await writeFile(join(prompt, 'capability.json'), JSON.stringify({ id: 'architect', kind: 'prompt', role: 'agent', version: '1.0.0', name: '架构师', description: '系统设计与技术权衡。' }));
  await writeFile(join(prompt, 'agent.md'), 'You are an architect.\n');
  await writeFile(join(root, 'graph', 'agent-combinations.json'), JSON.stringify({
    version: 1,
    combinations: [{
      id: 'code', name: 'Bob_coder', description: '组合架构身份与研究 Skill。', recommendedGrade: 'medium', review: false, tags: ['编码'],
      resources: [{ resourceId: 'architect', version: '1.0.0', role: 'identity', required: true }, { resourceId: 'research', version: '1.0.0', role: 'skill', required: true }],
    }],
  }));
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    (window as Window & { __openedResourceKinds?: string[] }).__openedResourceKinds = [];
    window.graph = {
      isDesktop: true,
      pickDirectory: async () => null,
      openResource: async kind => {
        (window as Window & { __openedResourceKinds?: string[] }).__openedResourceKinds!.push(kind);
        return { opened: true, path: `/tmp/${kind}` };
      },
      saveSecret: async () => ({ stored: true, applied: true }),
      secretStatus: async () => ({}),
      relaunch: async () => ({ url: location.origin }),
    };
  });
  await page.goto(`${server.url}/#/catalog`);
  await page.getByTestId('catalog').waitFor();
  expect(await page.getByTestId('resource-nav-skills').getAttribute('data-active')).toBe('true');
  await expect.poll(() => page.getByTestId('resource-section-skills').innerText()).toContain('Preserving Productive Tensions');
  await page.getByTestId('resource-catalog-search').fill('not-a-real-resource');
  expect(await page.getByTestId('resource-section-skills').innerText()).toContain('没有匹配的能力');
  await page.getByTestId('resource-catalog-search').fill('');
  expect(await page.getByTestId('resource-section-skills').innerText()).toContain('Preserving Productive Tensions');
  await page.getByTestId('resource-open-skills').click();
  expect(await page.evaluate(() => (window as Window & { __openedResourceKinds?: string[] }).__openedResourceKinds)).toEqual(['skills']);

  await page.getByTestId('resource-nav-mcp').click();
  await page.getByTestId('resource-section-mcp').waitFor();
  await expect.poll(() => page.getByTestId('resource-section-mcp').innerText()).toContain('Jira');
  await page.getByTestId('resource-open-mcp').click();

  await page.getByTestId('resource-nav-agent-md').click();
  await page.getByTestId('resource-section-agent-md').waitFor();
  await expect.poll(() => page.getByTestId('resource-section-agent-md').innerText()).toContain('架构师');
  await page.getByTestId('resource-open-agent-md').click();
  expect(await page.evaluate(() => (window as Window & { __openedResourceKinds?: string[] }).__openedResourceKinds)).toEqual(['skills', 'mcp', 'agent-md']);

  await page.getByTestId('resource-nav-pi-extensions').click();
  await page.getByTestId('resource-section-pi-extensions').waitFor();
  await expect.poll(() => page.getByTestId('resource-section-pi-extensions').innerText()).toContain('Pi MCP Extension');

  await page.getByTestId('resource-nav-skills').click();
  await page.getByTestId('resource-section-skills').waitFor();
  await page.getByTestId('resource-entry-research').click();
  await page.getByTestId('capability-detail-research').waitFor();
  const detail = await page.getByTestId('capability-detail-research').innerText();
  expect(detail).toContain('可用');
  expect(detail).toContain(skill);
  expect(detail).toContain('能力本身不会授予任务权限');
  await page.getByTestId('resource-detail-close').click();
  await page.getByTestId('resource-detail-drawer').waitFor({ state: 'detached' });

  await page.getByTestId('resource-nav-agents').click();
  await page.getByTestId('resource-section-agents').waitFor();
  await expect.poll(() => page.getByTestId('agent-combination-code').innerText()).toContain('Bob_coder');
  await expect.poll(() => page.getByTestId('resource-section-agents').innerText()).toContain('Bob_coder');
  await expect.poll(() => page.getByTestId('agent-combination-code').innerText()).toContain('组合架构身份与研究 Skill。');
  await expect.poll(() => page.getByTestId('agent-combination-code').innerText()).toContain('Agent 配方 · medium · 编码');
  await expect.poll(() => page.getByTestId('resource-section-agents').innerText()).toContain('可编译');
  expect(await page.getByTestId('resource-section-agents').innerText()).not.toContain('coder@1');

  await page.getByTestId('resource-nav-architectures').click();
  await page.getByTestId('resource-section-architectures').waitFor();
  const architectures = await page.getByTestId('architecture-library').innerText();
  expect(architectures).toContain('主管与工人');
  expect(architectures).toContain('评估与优化');
  expect(architectures).toContain('对抗式验证');
});

test('the recipe editor searches and sorts Skills, MCP and Pi extensions by name, enabled state and recipe usage', async () => {
  const root = await temp('recipe-picker');
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const skills = ['alpha-skill', 'beta-skill', 'gamma-skill'];
  await Promise.all(skills.map(async id => {
    const directory = join(capabilityRoot, 'skills', id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `# ${id}\n`);
    await writeFile(join(directory, 'capability.json'), JSON.stringify({
      id,
      kind: 'skill',
      version: '1.0.0',
      name: `${id.replace('-skill', '').replace(/^./, letter => letter.toUpperCase())} Skill`,
    }));
  }));
  const mcp = join(capabilityRoot, 'mcp', 'jira');
  await mkdir(mcp, { recursive: true });
  await writeFile(join(mcp, 'capability.json'), JSON.stringify({
    id: 'jira',
    kind: 'mcp',
    version: '1.0.0',
    name: 'Jira MCP',
    command: 'node',
    args: ['./server.mjs'],
  }));
  const extension = join(capabilityRoot, 'pi-extensions', 'browser');
  await mkdir(extension, { recursive: true });
  await writeFile(join(extension, 'capability.json'), JSON.stringify({
    id: 'browser',
    kind: 'pi-extension',
    version: '1.0.0',
    name: 'Browser Extension',
    entry: './index.mjs',
  }));
  await writeFile(join(extension, 'index.mjs'), 'export default function () {}\n');
  const recipesPath = join(root, 'graph', 'agent-combinations.json');
  const resource = (resourceId: string) => ({ resourceId, version: '1.0.0', role: 'skill', required: true });
  await writeFile(recipesPath, JSON.stringify({
    version: 1,
    combinations: [
      {
        id: 'worker',
        name: 'Worker',
        description: 'Current recipe.',
        recommendedGrade: 'medium',
        review: false,
        tags: ['worker'],
        resources: [resource('beta-skill')],
      },
      {
        id: 'gamma-a',
        name: 'Gamma A',
        description: 'Uses gamma.',
        recommendedGrade: 'medium',
        review: false,
        tags: [],
        resources: [resource('gamma-skill')],
      },
      {
        id: 'gamma-b',
        name: 'Gamma B',
        description: 'Uses gamma too.',
        recommendedGrade: 'medium',
        review: false,
        tags: [],
        resources: [resource('gamma-skill')],
      },
    ],
  }));
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/catalog/agents`);
  await page.getByTestId('agent-combination-worker').waitFor();
  await page.getByTestId('agent-combination-worker').getByRole('button', { name: '编辑' }).click();
  expect(await page.getByTestId('agent-recipe-description').evaluate((element: HTMLInputElement) => element.value)).toBe('Current recipe.');
  const picker = page.getByTestId('recipe-picker-skills');
  const optionLabels = () => picker.locator('[data-testid^="recipe-option-skill-"]').allTextContents();

  await expect.poll(optionLabels).toEqual([
    'Alpha Skillalpha-skill@1.0.0 · 0 个配方',
    'Beta Skillbeta-skill@1.0.0 · 1 个配方',
    'Gamma Skillgamma-skill@1.0.0 · 2 个配方',
  ]);

  await page.getByTestId('recipe-capability-sort').selectOption('enabled');
  await expect.poll(optionLabels).toEqual([
    'Beta Skillbeta-skill@1.0.0 · 1 个配方',
    'Alpha Skillalpha-skill@1.0.0 · 0 个配方',
    'Gamma Skillgamma-skill@1.0.0 · 2 个配方',
  ]);

  await page.getByTestId('recipe-capability-sort').selectOption('popular');
  await expect.poll(optionLabels).toEqual([
    'Gamma Skillgamma-skill@1.0.0 · 2 个配方',
    'Beta Skillbeta-skill@1.0.0 · 1 个配方',
    'Alpha Skillalpha-skill@1.0.0 · 0 个配方',
  ]);

  await page.getByTestId('recipe-capability-search').fill('jira');
  expect(await page.getByTestId('recipe-picker-skills').innerText()).toContain('没有匹配的能力');
  expect(await page.getByTestId('recipe-picker-mcp').innerText()).toContain('Jira MCP');
  expect(await page.getByTestId('recipe-picker-extensions').innerText()).toContain('没有匹配的能力');

  await page.getByTestId('agent-recipe-description').fill('负责实现与维护代码，并在授权范围内补充基础测试。');
  await expect.poll(async () => (await catalogView(server)).agentCombinations.find(item => item.id === 'worker')?.description)
    .toBe('负责实现与维护代码，并在授权范围内补充基础测试。');
  await expect.poll(() => page.getByTestId('agent-recipe-description-save-state').innerText())
    .toContain('已自动保存');
  await page.locator('.recipe-editor .resource-detail-head').getByRole('button', { name: '关闭' }).click();
  await page.getByTestId('resource-detail-drawer').waitFor({ state: 'detached' });
});

test('the Main Agent recipe is visible with fixed system capabilities and an editable capability recipe', async () => {
  const root = await temp('main-agent-recipe');
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const skill = join(capabilityRoot, 'main-research');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '# Main research\n');
  await writeFile(join(skill, 'capability.json'), JSON.stringify({
    id: 'main-research',
    kind: 'skill',
    version: '1.0.0',
    name: 'Main Agent Research',
  }));
  const recipesPath = join(root, 'graph', 'agent-combinations.json');
  await writeFile(recipesPath, JSON.stringify({
    version: 1,
    combinations: [{
      id: 'main',
      name: 'Main Agent',
      description: '主 Agent 配方。',
      mode: 'main',
      recommendedGrade: 'high',
      review: false,
      tags: ['main'],
      resources: [],
    }],
  }));
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/catalog/agents`);
  await page.getByTestId('agent-combination-main').waitFor();
  expect(await page.getByTestId('main-agent-system-capabilities').innerText()).toContain('任务规划');
  expect(await page.getByTestId('main-agent-system-capabilities').innerText()).toContain('监控 Graph 全程');
  await page.getByTestId('agent-combination-main').getByRole('button', { name: '编辑' }).click();
  await page.getByTestId('main-agent-recipe-note').waitFor();
  expect(await page.getByTestId('agent-recipe-id').isDisabled()).toBe(true);
  expect(await page.getByTestId('main-agent-recipe-note').innerText()).toContain('不能从配方移除');
  await page.getByRole('button', { name: '取消' }).click();
  expect(await page.getByTestId('agent-combination-main').getByRole('button', { name: '删除' }).isDisabled()).toBe(true);
});

test('the inbox keeps resolved questions in history', async () => {
  const root = await temp('inbox-history');
  const server = await consoleServer(root);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/api/inbox', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      history: [{
        id: 'question-1', taskId: 'task-1', nodeId: 'work', kind: 'permission', status: 'resolved',
        data: { prompt: '允许读取项目目录' }, answer: { type: 'grant' },
        request: '检查项目结构', projectId: 'alpha', conversationId: 'conversation-1',
      }],
    }),
  }));
  await page.goto(`${server.url}/#/inbox`);
  await page.getByTestId('inbox-history').waitFor();
  expect(await page.getByTestId('inbox-empty').isVisible()).toBe(true);
  const history = await page.getByTestId('inbox-history').innerText();
  expect(history).toContain('检查项目结构');
  expect(history).toContain('允许读取项目目录');
  expect(history).toContain('处理结果');
});

test('the composer inserts project file mentions and carries text attachments into the message ledger', async () => {
  const root = await temp('composer-context');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });
  const created = await createConversation(server, { projectId: 'alpha', text: '先讨论', requestId: 'composer-context' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const input = page.getByTestId('chat-input');
  await input.waitFor();
  await input.fill('请看 @src');
  await page.getByTestId('mention-popover').waitFor();
  await page.getByTestId('mention-file-src/index.ts').waitFor();
  await input.press('ArrowDown');
  await input.press('Enter');
  expect(await input.evaluate((element: HTMLInputElement) => element.value)).toBe('请看 @src/index.ts ');

  await page.getByTestId('chat-attachment-input').setInputFiles({
    name: 'notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Notes\n\nAttachment body.\n'),
  });
  await page.getByTestId('composer-attachments').waitFor();
  expect(await page.getByTestId('composer-attachments').innerText()).toContain('notes.md');
  await page.getByTestId('chat-send').click();
  await expect.poll(async () => {
    const view = await conversationView(server, created.conversationId);
    return ((view.messages.at(-1)?.data as { attachments?: unknown } | null)?.attachments) instanceof Array;
  }).toBe(true);
  const view = await conversationView(server, created.conversationId);
  const message = view.messages.at(-1)!;
  expect(message.text).toContain('@src/index.ts');
  expect((message.data as { attachments?: unknown } | null)?.attachments).toEqual([
    { name: 'notes.md', type: 'text/markdown', size: 26, text: '# Notes\n\nAttachment body.\n' },
  ]);
  await expect.poll(() => page.getByTestId('message-user').last().innerText()).toContain('notes.md');
});

test('the composer slash menu selects tools, switches model and queues compaction', async () => {
  const root = await temp('composer-slash');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }], models: 2 });
  // The conversation starts at the lowest strength, so the console has to
  // carry a real level for a model that offers no list of its own.
  const created = await createConversation(server, { projectId: 'alpha', text: '先讨论', requestId: 'composer-slash', thinkingLevel: 'minimal' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const modelRequests: unknown[] = [];
  let compactRequests = 0;
  let sent: { text?: string } | null = null;
  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      projects: [{ id: 'alpha', root }],
      defaultModel: 'local',
      models: [
        { id: 'local', grade: 'high', credentialId: 'local', contextWindow: 32_000, reasoning: true, defaultThinkingLevel: 'low' },
        { id: 'fast', grade: 'medium', credentialId: 'local', contextWindow: 16_000, reasoning: false },
      ],
      definitions: [],
      capabilities: [],
    }),
  }));
  await page.route(`**/api/conversations/${created.conversationId}/model`, async route => {
    modelRequests.push(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ changed: true }) });
  });
  await page.route(`**/api/conversations/${created.conversationId}/compact`, async route => {
    compactRequests += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'pending' }) });
  });
  await page.route(`**/api/conversations/${created.conversationId}/messages`, async route => {
    sent = JSON.parse(route.request().postData() ?? '{}') as { text?: string };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conversationId: created.conversationId, messageId: 'message', state: 'pending', cursor: 2, pending: false }),
    });
  });

  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const input = page.getByTestId('chat-input');
  await input.waitFor();

  await input.fill('/model');
  const slashPopover = page.getByTestId('slash-popover');
  await slashPopover.waitFor();
  const popoverBox = await slashPopover.boundingBox();
  const viewport = page.viewportSize();
  expect(popoverBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(popoverBox!.y).toBeGreaterThanOrEqual(0);
  expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(viewport!.height);
  await page.getByTestId('slash-system-model').click();
  await page.getByTestId('slash-model-fast').click();
  await expect.poll(() => modelRequests.length).toBe(1);
  // Thinking is always on, so a model without a level list gets its lowest one.
  expect(modelRequests[0]).toMatchObject({ model: 'fast', thinkingLevel: 'minimal' });

  await input.fill('/compact');
  await page.getByTestId('slash-system-compact').click();
  await expect.poll(() => compactRequests).toBe(1);

  await input.fill('/');
  await page.getByTestId('slash-tool-read').click();
  await expect.poll(() => input.evaluate((element: HTMLInputElement) => element.value)).toBe('/read ');
  expect(await page.getByTestId('composer-command-chips').count()).toBe(0);
  await input.fill(`${await input.evaluate((element: HTMLInputElement) => element.value)}请分析这个项目`);
  await page.getByTestId('chat-send').click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent!.text).toContain('/read ');
  expect(sent!.text).toContain('请分析这个项目');
  expect(sent!.text).toContain('The user explicitly requested the following tools and capabilities');
  expect(sent!.text).toContain('`read`');
});

test('the new-chat slash menu stays inside the viewport and inserts an inline tool token', async () => {
  const root = await temp('new-chat-slash');
  const server = await consoleServer(root);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url);
  const input = page.getByTestId('new-conversation-input');
  await input.waitFor();
  await input.fill('/');
  await page.getByTestId('slash-tool-read').waitFor();
  const popover = page.getByTestId('slash-popover');
  const box = await popover.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  await page.getByTestId('slash-tool-read').click();
  await expect.poll(() => input.evaluate((element: HTMLInputElement) => element.value)).toBe('/read ');
});

test('the new-chat composer supports project mentions and attachments before submitting', async () => {
  const root = await temp('new-chat-composer');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/?project=alpha`);
  const input = page.getByTestId('new-conversation-input');
  await input.waitFor();
  await input.fill('先看 @src');
  await page.getByTestId('mention-popover').waitFor();
  await page.getByTestId('mention-file-src/index.ts').waitFor();
  await page.getByTestId('mention-file-src/index.ts').click();
  expect(await input.evaluate((element: HTMLInputElement) => element.value)).toBe('先看 @src/index.ts ');

  await page.getByTestId('new-conversation-attachment-input').setInputFiles({
    name: 'brief.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Brief\n\nNew chat attachment.\n'),
  });
  await page.getByTestId('composer-attachments').waitFor();
  await page.getByTestId('new-conversation-start').click();
  await page.waitForFunction(() => location.hash.startsWith('#/conversations/'));

  const conversationId = await page.evaluate(() => location.hash.split('/').at(-1)!);
  const view = await conversationView(server, conversationId);
  const message = view.messages.find(item => item.role === 'user')!;
  expect(message.text).toContain('@src/index.ts');
  expect((message.data as { attachments?: unknown } | null)?.attachments).toEqual([
    { name: 'brief.md', type: 'text/markdown', size: 30, text: '# Brief\n\nNew chat attachment.\n' },
  ]);
});

test('the new-chat composer switches model and thinking before the conversation starts', async () => {
  const root = await temp('new-chat-model');
  const server = await consoleServer(root, { models: 2 });
  const creates: { text?: string; model?: string; thinkingLevel?: string }[] = [];
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      projects: [],
      defaultModel: 'local',
      models: [
        { id: 'local', grade: 'high', credentialId: 'local', contextWindow: 32_000, reasoning: true, defaultThinkingLevel: 'low' },
        { id: 'fast', grade: 'medium', credentialId: 'local', contextWindow: 16_000, reasoning: false },
      ],
      definitions: [],
      capabilities: [],
    }),
  }));
  await page.route('**/api/conversations', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    creates.push(JSON.parse(route.request().postData() ?? '{}') as { text?: string; model?: string; thinkingLevel?: string });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversationId: 'created' }) });
  });

  await page.goto(`${server.url}/#/`);
  await page.getByTestId('new-conversation-input').waitFor();
  const control = page.getByTestId('model-control');
  await control.waitFor();
  // The pre-creation composer shows the daemon default and its thinking level,
  // written in the model's own vocabulary (no translation).
  await expect.poll(() => page.getByTestId('telemetry-model').innerText()).toContain('local');
  expect(await page.getByTestId('telemetry-thinking').innerText()).toContain('思考 low');
  await control.click();
  const fastOption = page.getByTestId('model-option-fast');
  await fastOption.waitFor();
  expect(await fastOption.innerText()).not.toContain('可思考');
  expect(await fastOption.innerText()).not.toContain('标准');
  await fastOption.click();
  expect(await page.getByTestId('telemetry-model').innerText()).toContain('fast');
  await page.keyboard.press('Escape');
  await page.getByTestId('model-menu').waitFor({ state: 'detached' });
  await page.getByTestId('new-conversation-input').fill('用选中的模型开始');
  await page.getByTestId('new-conversation-start').click();

  await expect.poll(() => creates.length).toBe(1);
  // Thinking is always on: the level carried over from the default model is
  // clamped into the target model's levels (the lowest real one here).
  expect(creates[0]).toMatchObject({ text: '用选中的模型开始', model: 'fast', thinkingLevel: 'low' });
}, 60_000);

test('settings opens as a second page with its own navigation and return control', async () => {
  const root = await temp('settings-shell');
  const server = await consoleServer(root);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/settings`);
  await page.getByTestId('settings-shell').waitFor();
  expect(await page.locator('.settings-back').getAttribute('href')).toBe('#/');
  const nav = page.locator('.settings-nav');
  expect(await nav.innerText()).toContain('常规');
  expect(await nav.innerText()).toContain('归档对话');
  expect(await nav.innerText()).not.toContain('通用/偏好');
  expect(await nav.innerText()).not.toContain('高级设置');
  expect(await nav.innerText()).not.toContain('Git 准备');
  expect(await nav.innerText()).not.toContain('模型');
  expect(await nav.innerText()).not.toContain('项目');
  expect(await nav.innerText()).not.toContain('并发限制');
  expect(await nav.innerText()).not.toContain('连接与配置向导');
  expect(await nav.innerText()).not.toContain('凭据');
  expect(await nav.innerText()).not.toContain('模型偏好');
  expect(await page.locator('.app-shell').count()).toBe(0);

  expect(await page.getByTestId('settings-preferences').isVisible()).toBe(true);
  expect(await page.locator('.settings-project-status').count()).toBe(1);
  await page.locator('.settings-back').click();
  await page.getByTestId('app-rail').waitFor();
  expect(await page.getByTestId('rail-models').getAttribute('href')).toBe('#/models');
  await page.getByTestId('rail-models').click();
  await page.getByTestId('models-page').waitFor();
  expect(await page.locator('.tab[data-active="true"] .tab-title').innerText()).toBe('模型');
});

test('the compact shell keeps the new-chat composer inside the viewport', async () => {
  const root = await temp('compact');
  const server = await consoleServer(root);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(server.url);
  await page.getByTestId('new-conversation-input').waitFor();
  const composer = await page.locator('.new-chat-composer').boundingBox();
  expect(composer).not.toBeNull();
  expect(composer!.x).toBeGreaterThanOrEqual(0);
  expect(composer!.x + composer!.width).toBeLessThanOrEqual(390);
  expect(await page.getByTestId('conversation-list').isHidden()).toBe(true);
});

test('the chat header exposes editable Agent prompts and Main Agent tools', async () => {
  const root = await temp('agent-context');
  const promptRoot = join(root, 'graph', 'prompts');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });
  const created = await createConversation(server, { text: '检查 Agent 上下文', requestId: 'agent-context-ui' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('agent-context-open').waitFor();
  expect(await page.getByTestId('agent-context-bar').count()).toBe(0);

  await page.getByTestId('agent-context-open').click();
  await page.getByTestId('agent-context-drawer').waitFor();
  // 面板只展示真正发出去的那一份；没发过请求的会话没有可展示的 prompt。
  await page.getByTestId('agent-context-sent').waitFor();
  const sentPanel = await page.getByTestId('agent-context-sent').innerText();
  expect(sentPanel).toContain('实际发出');
  expect(sentPanel).toContain('本次会话尚未记录到已发出的请求');
  await expect.poll(() => page.getByTestId('agent-context-sent').innerText()).toContain(`源码 Docs ${join(process.cwd(), 'docs', 'agent')}`);
  expect(await page.locator('[data-testid="agent-context-preview"]').count()).toBe(0);
  expect(await page.locator('[data-testid="agent-context-preview-markdown"]').count()).toBe(0);
  expect(await page.locator('[data-testid="agent-preview-section-map"]').count()).toBe(0);
  expect(
    (await page.locator('.agent-context-tabs [role="tab"]').allInnerTexts()).map(label => label.split('\n')[0]!.trim()),
  ).toEqual(['实际发出的 Prompt', '可编辑来源', '工具与能力']);

  // 组装正确性属于产生它的那一层（provider 请求）；接口只给事实：工具、能力、可编辑来源。
  const payload = await page.evaluate(async (conversationId: string) => {
    const response = await fetch(`/api/agent-context?conversationId=${conversationId}`, { credentials: 'include' });
    return await response.json() as { preview?: unknown; sent: unknown; tools: unknown[]; prompts: unknown[] };
  }, created.conversationId);
  expect(payload.sent).toBeNull();
  expect(payload.preview).toBeUndefined();
  expect(payload.tools.length).toBeGreaterThan(0);
  expect(payload.prompts.length).toBeGreaterThan(0);
  await page.getByTestId('agent-context-tab-prompts').click();
  expect(await page.getByTestId('agent-prompt-docs/INDEX.md').count()).toBe(0);
  await page.getByTestId('agent-prompt-runtime/worker.md').click();
  await page.getByTestId('agent-prompt-editor').fill('CUSTOM CONVERSATION {{fullAccessInstruction}}');
  await page.getByRole('button', { name: '保存 Prompt' }).click();
  await expect.poll(() => libraryPrompt(promptRoot, 'runtime/worker.md')).toContain('CUSTOM CONVERSATION');
  await page.getByRole('button', { name: '恢复默认' }).click();
  await page.getByTestId('toasts').getByText(/已恢复 Worker 运行规则/).waitFor();
  await expect.poll(() => libraryPrompt(promptRoot, 'runtime/worker.md')).not.toContain('CUSTOM CONVERSATION');
  await page.getByTestId('agent-prompt-editor').fill('');
  await expect.poll(() => page.getByTestId('agent-prompt-editor').evaluate((element: HTMLInputElement) => element.value)).toBe('');
  await page.getByRole('button', { name: '设为默认' }).click();
  await page.getByTestId('toasts').getByText(/已将 Worker 运行规则 设为默认/).waitFor();
  await expect.poll(() => libraryPrompt(promptRoot, 'runtime/worker.md')).toBe('');
  expect(await readFile(join(root, 'graph', 'prompts', 'defaults', 'runtime', 'worker.md'), 'utf8')).toBe('\n');
  await page.getByTestId('agent-prompt-editor').fill('Temporary after default');
  await expect.poll(() => page.getByTestId('agent-prompt-editor').evaluate((element: HTMLInputElement) => element.value)).toBe('Temporary after default');
  await page.getByRole('button', { name: '保存 Prompt' }).click();
  await page.getByTestId('toasts').getByText(/已保存 Worker 运行规则/).waitFor();
  await expect.poll(() => libraryPrompt(promptRoot, 'runtime/worker.md')).toContain('Temporary after default');
  await page.getByRole('button', { name: '恢复默认' }).click();
  await page.getByTestId('toasts').getByText(/已恢复 Worker 运行规则/).last().waitFor();
  await expect.poll(() => libraryPrompt(promptRoot, 'runtime/worker.md')).toBe('');
  await page.getByRole('button', { name: '恢复内置' }).click();
  await page.getByTestId('toasts').getByText(/已恢复 Worker 运行规则 的内置默认/).waitFor();
  await expect.poll(() => libraryPrompt(promptRoot, 'runtime/worker.md')).toContain('Use the native Pi tools');

  await page.getByTestId('agent-context-tab-tools').click();
  await page.getByTestId('agent-tool-write').uncheck();
  await page.getByRole('button', { name: '保存工具选择' }).click();
  await expect.poll(async () => await libraryDisabledTools(promptRoot)).toContain('write');
}, 60_000);

test('the sent tab shows the tool declarations one request carried, with their count and size', async () => {
  const root = await temp('agent-context-tools-ui');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });
  const created = await createConversation(server, { text: '看声明', requestId: 'sent-tools-ui' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const declarations = [{
    name: 'propose_graph', description: 'Draft a graph',
    parameters: { type: 'object', properties: { proposalJson: { type: 'string' } }, required: ['proposalJson'] },
  }];
  const recorded = JSON.stringify(declarations);
  // The page renders the fact the API reports for one real request; the check that this
  // fact equals what went over the wire lives in the runtime test.
  await page.route('**/api/agent-context*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      docsRoot: join(process.cwd(), 'docs', 'agent'),
      definitionVersion: 'main@1', latestDefinitionVersion: 'main@1',
      prompts: [], disabledTools: [], tools: [], capabilities: [],
      sent: { operationId: 'op-1', at: 1, text: '<identity>demo</identity>', tools: recorded },
    }),
  }));

  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('agent-context-open').waitFor();
  await page.getByTestId('agent-context-open').click();
  await page.getByTestId('agent-context-sent-tools').waitFor();
  const block = await page.getByTestId('agent-context-sent-tools').innerText();
  expect(block).toContain('1 个工具');
  expect(block).toContain(`${recorded.length.toLocaleString()} 字符`);
  // The same request's prompt still sits above it, unchanged.
  expect(await page.getByTestId('agent-context-sent-text').innerText()).toBe('<identity>demo</identity>');
  expect(await page.getByTestId('agent-context-sent-tools-text').innerText()).toContain('propose_graph');
}, 60_000);

test('draft markdown follows preferences and image attachments survive sending and reload', async () => {
  const root = await temp('draft-image');
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }] });
  const created = await createConversation(server, { projectId: 'alpha', text: '图片测试', requestId: 'draft-image' });
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  let refreshes = 0;
  await page.route('**/api/usage/refresh', async route => { refreshes++; await route.fulfill({ json: {} }); });
  await page.clock.install();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await expect.poll(() => refreshes).toBe(1);
  const input = page.getByTestId('chat-input');
  await input.fill('**实时草稿**');
  await page.locator('.markdown-input .md-strong').waitFor();
  expect(await page.getByTestId('composer-markdown-preview').count()).toBe(0);
  await page.evaluate(() => { localStorage.setItem('graph-pref-markdown-rendering', 'false'); window.dispatchEvent(new Event('graph:preferences-changed')); });
  await page.locator('.markdown-input .md-strong').waitFor({ state: 'detached' });
  expect(await input.evaluate((element: HTMLInputElement) => element.value)).toBe('**实时草稿**');
  await page.clock.fastForward(5 * 60_000);
  await expect.poll(() => refreshes).toBe(2);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nT8AAAAASUVORK5CYII=', 'base64');
  await page.getByTestId('chat-attachment-input').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: bytes });
  await expect.poll(() => page.locator('.composer-attachment-preview').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await page.getByTestId('chat-send').click();
  const image = page.locator('.message-attachment-image').last();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await page.reload();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  const src = await image.getAttribute('src');
  expect(src).toMatch(/^\/api\/messages\//);
  const response = await page.request.get(`${server.url}${src}`);
  expect(response.headers()['content-type']).toContain('image/png');
  expect(await response.body()).toEqual(bytes);
  expect((await page.request.get(`${server.url}${src?.replace(/0$/, '99')}`)).status()).toBe(400);
});

test('live Markdown edits one source, reveals syntax at the caret and preserves undo and composition', async () => {
  const root = await temp('live-markdown');
  const server = await consoleServer(root);
  const created=await createConversation(server, {text:'Live editor',requestId:'live'});
  const browser=await chromium.launch({headless:true}); cleanup.push(()=>browser.close());
  const page=await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const input=page.getByTestId('chat-input');
  await input.fill('# 标题\n\n**粗体**与 `代码`\n\n最后一行');
  await input.press('End');
  await page.locator('.md-heading').waitFor();
  await expect.poll(()=>page.locator('.md-heading').innerText()).toBe('标题');
  await page.locator('.md-strong').click();
  await expect.poll(()=>page.locator('.md-strong').innerText()).toBe('**粗体**');
  await input.fill('草稿');
  await input.press('End');
  await input.press('Shift+Enter');
  await input.pressSequentially('next');
  await expect.poll(()=>input.evaluate((e:HTMLTextAreaElement)=>e.value)).toContain('\nnext');
  await input.press('ControlOrMeta+z');
  await expect.poll(()=>input.evaluate((e:HTMLTextAreaElement)=>e.value)).not.toContain('\nnext');
  await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});
  expect((await conversationView(server, created.conversationId)).messages.filter(m=>m.role==='user').length).toBe(1);
  await page.screenshot({path:'/tmp/graph-live-editor.png'});
  await page.goto(`${server.url}/#/catalog/architectures`);
  await page.getByTestId('architecture-canvas').waitFor();
  await page.getByRole('button',{name:/主管与工人/}).click();
  await expect.poll(()=>page.locator('.architecture-canvas .react-flow__node').count()).toBe(3);
  await page.locator('.architecture-canvas .react-flow__node').filter({hasText:'工人 A'}).click();
  await expect.poll(()=>page.locator('.architecture-stage footer').innerText()).toContain('工作副本');
  await page.screenshot({path:'/tmp/graph-architecture-board.png'});
});
