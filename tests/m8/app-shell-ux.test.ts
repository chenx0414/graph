import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { startGraphDaemon } from '../../src/server/start.ts';

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

test('the shell groups conversations by project and keeps an unbound recent section', async () => {
  const root = await temp('sidebar');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  await server.runtime.conversations.create({ text: '未绑定讨论', requestId: 'unbound' });
  await server.runtime.conversations.create({ projectId: 'alpha', text: '项目内讨论', requestId: 'bound' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.getByTestId('new-conversation-input').waitFor();

  const sidebar = page.getByTestId('conversation-list');
  await expect.poll(() => sidebar.innerText()).toContain('未绑定讨论');
  expect(await sidebar.innerText()).toContain('项目内讨论');
  expect(await page.locator('a[href="#/inbox"]').innerText()).toContain('问题');
  expect(await page.locator('a[href="#/catalog"]').innerText()).toContain('资源库');
  expect(await page.locator('a[href="#/settings"]').innerText()).toContain('设置');
  expect(await page.locator('a').filter({ hasText: '概览' }).count()).toBe(0);
  expect(await page.locator('a').filter({ hasText: '向导' }).count()).toBe(0);

  await page.getByTestId('new-conversation-project-alpha').click();
  await page.waitForFunction(() => location.hash.includes('project=alpha'));
  await page.waitForFunction(() => (document.querySelector('[data-testid="new-conversation-project"]') as HTMLSelectElement | null)?.value === 'alpha');
  expect(await page.getByTestId('new-conversation-project').inputValue()).toBe('alpha');

  await page.getByTestId('sidebar-toggle').click();
  await page.waitForFunction(() => document.querySelector('.sidebar')?.getAttribute('data-collapsed') === 'true');
  expect(await sidebar.isHidden()).toBe(true);
  await page.getByTestId('sidebar-toggle').click();
  await sidebar.waitFor({ state: 'visible' });
});

test('conversations archive from the sidebar and restore from settings', async () => {
  const root = await temp('archive-ui');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '需要归档的对话', requestId: 'archive-ui' });

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
  await page.getByTestId(`archived-conversation-${created.conversationId}`).waitFor();
  expect(await page.getByTestId(`archived-conversation-${created.conversationId}`).innerText()).toContain('alpha');
  await page.getByTestId(`archived-conversation-${created.conversationId}`).getByRole('button', { name: '取消归档' }).click();
  await page.getByTestId('archived-empty').waitFor();

  await page.goto(server.url);
  await expect.poll(() => page.getByTestId('conversation-list').innerText()).toContain('需要归档的对话');
});

test('proposal and graph summaries stay in the thread while details open in the drawer', async () => {
  const root = await temp('drawer');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '先讨论一下', requestId: 'conversation' });
  const view = await server.runtime.conversations.view(created.conversationId);
  await server.runtime.supervisor(view.anchorTaskId).propose({
    requirementVersion: 1,
    summary: '先做一个最小版本',
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'draft');

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('proposal-draft').waitFor();
  const pauseBox = await page.getByTestId('conversation-pause').boundingBox();
  const detailBox = await page.getByTestId('detail-toggle').boundingBox();
  expect(pauseBox).not.toBeNull();
  expect(detailBox).not.toBeNull();
  expect(detailBox!.x).toBeGreaterThanOrEqual(pauseBox!.x + pauseBox!.width);
  expect(await page.getByTestId('detail-toggle').getAttribute('data-open')).toBe('false');
  await page.getByTestId('draft-graph').click();
  await page.getByTestId('detail-drawer').waitFor();
  expect(await page.getByTestId('detail-toggle').getAttribute('data-open')).toBe('true');
  await page.getByTestId('draft-graph-detail').waitFor();
  const drawer = await page.getByTestId('detail-drawer').innerText();
  expect(drawer).toContain('检查通过');
  expect(drawer).toContain('work');
  expect(drawer).toContain('check');
  await page.getByTestId('detail-toggle-close').click();
  await page.getByTestId('detail-drawer').waitFor({ state: 'detached' });
  await page.getByTestId('detail-toggle').click();
  await page.getByTestId('detail-drawer').waitFor();
});

test('conversation pause and resume use one stateful action with visible feedback', async () => {
  const root = await temp('pause-feedback');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '先讨论一下', requestId: 'pause-feedback' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);

  await page.getByTestId('conversation-pause').click();
  await page.getByTestId('conversation-resume').waitFor();
  await page.getByTestId('conversation-paused-notice').waitFor();
  expect(await page.getByTestId('conversation-pause').count()).toBe(0);
  expect(await page.getByTestId('toasts').innerText()).toContain('主 Agent 对话已暂停');
  expect(await page.getByTestId('conversation-paused-notice').innerText()).toContain('正在执行的功能任务仍按自身状态继续');

  await page.getByTestId('conversation-resume').click();
  await page.getByTestId('conversation-pause').waitFor();
  await page.getByTestId('conversation-paused-notice').waitFor({ state: 'detached' });
  expect(await page.getByTestId('toasts').innerText()).toContain('主 Agent 对话已继续');
});

test('the right drawer toggle stays available and opens an empty state', async () => {
  const root = await temp('empty-drawer');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '还没有执行信息', requestId: 'empty-drawer' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const toggle = page.getByTestId('detail-toggle');
  await toggle.waitFor();
  expect(await toggle.getAttribute('data-open')).toBe('false');

  await toggle.click();
  await page.getByTestId('detail-drawer').waitFor();
  expect(await page.getByTestId('detail-empty').innerText()).toContain('暂无详情');
  expect(await toggle.getAttribute('data-open')).toBe('true');

  await toggle.click();
  await page.getByTestId('detail-drawer').waitFor({ state: 'detached' });
});

test('the composer suggestion and queue steering follow the three Enter states', async () => {
  const root = await temp('composer-enter-states');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const steered: string[] = [];
  let runs = 0;
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    actions: {
      master: {
        kind: 'agent',
        reserveTokens: 100,
        prepare: async () => async () => {
          runs += 1;
          if (runs === 1) await gate;
          return {
            outcome: 'completed',
            output: runs === 1
              ? { text: '第一轮检查完成。', suggestedPrompt: '继续检查测试覆盖和失败分支。' }
              : { text: '已按候选提示继续。' },
            usage,
          };
        },
        steer: async (_operation, text) => { steered.push(text); },
      },
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
    autoDrive: true,
    webDir,
    startup: { mode: 'execute', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ text: '开始检查。', requestId: 'enter-states' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const input = page.getByTestId('chat-input');
  await input.waitFor();
  await expect.poll(async () => (await server.runtime.conversations.view(created.conversationId)).master?.status).toBe('running');

  // State 2: a nonempty prompt sent during output is queued.
  await input.fill('优先检查失败分支。');
  await input.press('Enter');
  await page.getByTestId('queued-message').filter({ hasText: '优先检查失败分支。' }).waitFor();

  // State 3: an empty composer with a queued message sends that queue as steering.
  await input.press('Enter');
  await expect.poll(() => steered.length).toBe(1);
  expect(steered[0]).toContain('优先检查失败分支。');
  await expect.poll(async () => {
    const messages = (await server.runtime.conversations.view(created.conversationId)).messages;
    return messages.find(message => message.text === '优先检查失败分支。')?.state;
  }).toBe('delivered');

  release();
  await expect.poll(async () => (await server.runtime.conversations.view(created.conversationId)).master?.status).toBe('succeeded');
  await expect.poll(() => input.getAttribute('data-suggestion')).toBe('继续检查测试覆盖和失败分支。');

  // Tab fills the grey suggestion.
  await input.press('Tab');
  expect(await input.inputValue()).toBe('继续检查测试覆盖和失败分支。');

  // State 1: with the composer empty again, Enter sends the suggestion directly.
  await input.fill('');
  await input.press('Enter');
  await expect.poll(async () => {
    const messages = (await server.runtime.conversations.view(created.conversationId)).messages;
    return messages.some(message => message.role === 'user' && message.text === '继续检查测试覆盖和失败分支。');
  }).toBe(true);
});

test('the project picker adds a local project to the sidebar', async () => {
  const root = await temp('project-dialog');
  const initial = join(root, 'initial');
  const picked = join(root, 'picked');
  await mkdir(initial, { recursive: true });
  await mkdir(picked, { recursive: true });
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'initial', root: initial }] }, null, 2));
  const daemon = await startGraphDaemon({
    configPath,
    stateDir: join(root, 'state'),
    webDir,
    port: 0,
    mode: 'view',
    env: {},
    log: () => undefined,
  });
  cleanup.push(() => daemon.close());

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
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());

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
        { id: 'answer', seq: 2, role: 'assistant', kind: 'chat', text: '## 结果\n\n- **完成**\n\n`code`', data: null, state: 'done', operationId: 'op', turn: 1, createdAt: Date.now(), updatedAt: Date.now() },
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
  expect(await page.locator('.markdown-body strong').innerText()).toBe('完成');
  expect(await page.locator('.markdown-body code').innerText()).toBe('code');
  const order = await page.locator('.conversation-thread').innerText();
  expect(order.indexOf('工具 · read README.md')).toBeLessThan(order.indexOf('主 Agent'));
  expect(await page.getByTestId('telemetry-cache').innerText()).toContain('75%');
  expect(await page.getByTestId('telemetry-context').innerText()).toContain('8,000 / 32,000');
  expect(await page.getByTestId('telemetry-model').innerText()).toContain('local');
  expect(await page.getByTestId('telemetry-thinking').innerText()).toContain('关闭');
});

test('the composer model control switches model and thinking as one persisted selection', async () => {
  const root = await temp('model-control');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 2, enabledModelCount: 2 },
  });
  cleanup.push(() => server.close());
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
        { id: 'local', grade: 'high', credentialId: 'local', contextWindow: 32_000, reasoning: true },
        { id: 'fast', grade: 'medium', credentialId: 'local', contextWindow: 16_000, reasoning: false },
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
  await page.getByTestId('thinking-high').click();
  await expect.poll(() => selections.length).toBe(1);
  expect(selections[0]).toMatchObject({ model: 'local', thinkingLevel: 'high' });
  expect(await page.getByTestId('toasts').innerText()).not.toContain('已切换为');

  await control.click();
  await page.getByTestId('model-option-fast').click();
  await expect.poll(() => selections.length).toBe(2);
  expect(selections[1]).toMatchObject({ model: 'fast', thinkingLevel: 'off' });
});

test('the resource library groups reusable assets and includes graph architectures', async () => {
  const root = await temp('resources');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'resource-coder');

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
  expect(await page.getByTestId('resource-skills').innerText()).toContain('Skills 库');
  expect(await page.getByTestId('resource-mcp').innerText()).toContain('MCP 库');
  expect(await page.getByTestId('resource-agent-md').innerText()).toContain('Agent.md 库');
  expect(await page.getByTestId('resource-agents').innerText()).toContain('Agent 组合库');
  await page.getByTestId('resource-open-skills').click();
  await page.getByTestId('resource-open-mcp').click();
  await page.getByTestId('resource-open-agent-md').click();
  expect(await page.evaluate(() => (window as Window & { __openedResourceKinds?: string[] }).__openedResourceKinds)).toEqual(['skills', 'mcp', 'agent-md']);
  await page.getByTestId('definition-coder').click();
  await page.getByTestId('resource-detail-drawer').waitFor();
  expect(await page.getByTestId('resource-detail-drawer').innerText()).toContain('coder');
  await page.getByTestId('talent-coder').waitFor();
  await page.getByTestId('resource-detail-close').click();
  await page.getByTestId('resource-detail-drawer').waitFor({ state: 'detached' });
  const architectures = await page.getByTestId('architecture-library').innerText();
  expect(architectures).toContain('主管与工人');
  expect(architectures).toContain('评估与优化');
  expect(architectures).toContain('对抗式验证');
});

test('the inbox keeps resolved questions in history', async () => {
  const root = await temp('inbox-history');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());

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
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '先讨论', requestId: 'composer-context' });

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
  expect(await input.inputValue()).toBe('请看 @src/index.ts ');

  await page.getByTestId('chat-attachment-input').setInputFiles({
    name: 'notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Notes\n\nAttachment body.\n'),
  });
  await page.getByTestId('composer-attachments').waitFor();
  expect(await page.getByTestId('composer-attachments').innerText()).toContain('notes.md');
  await page.getByTestId('chat-send').click();
  await expect.poll(async () => {
    const view = await server.runtime.conversations.view(created.conversationId);
    return ((view.messages.at(-1)?.data as { attachments?: unknown } | null)?.attachments) instanceof Array;
  }).toBe(true);
  const view = await server.runtime.conversations.view(created.conversationId);
  const message = view.messages.at(-1)!;
  expect(message.text).toContain('@src/index.ts');
  expect((message.data as { attachments?: unknown } | null)?.attachments).toEqual([
    { name: 'notes.md', type: 'text/markdown', size: 26, text: '# Notes\n\nAttachment body.\n' },
  ]);
  await expect.poll(() => page.getByTestId('message-user').last().innerText()).toContain('notes.md');
});

test('the new-chat composer supports project mentions and attachments before submitting', async () => {
  const root = await temp('new-chat-composer');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());

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
  expect(await input.inputValue()).toBe('先看 @src/index.ts ');

  await page.getByTestId('new-conversation-attachment-input').setInputFiles({
    name: 'brief.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Brief\n\nNew chat attachment.\n'),
  });
  await page.getByTestId('composer-attachments').waitFor();
  await page.getByTestId('new-conversation-start').click();
  await page.waitForFunction(() => location.hash.startsWith('#/conversations/'));

  const conversationId = await page.evaluate(() => location.hash.split('/').at(-1)!);
  const view = await server.runtime.conversations.view(conversationId);
  const message = view.messages.find(item => item.role === 'user')!;
  expect(message.text).toContain('@src/index.ts');
  expect((message.data as { attachments?: unknown } | null)?.attachments).toEqual([
    { name: 'brief.md', type: 'text/markdown', size: 30, text: '# Brief\n\nNew chat attachment.\n' },
  ]);
});

test('settings opens as a second page with its own navigation and return control', async () => {
  const root = await temp('settings-shell');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/settings`);
  await page.getByTestId('settings-shell').waitFor();
  expect(await page.locator('.settings-back').getAttribute('href')).toBe('#/');
  expect(await page.locator('.settings-nav').innerText()).toContain('项目');
  expect(await page.locator('.settings-nav').innerText()).toContain('模型');
  expect(await page.locator('.app-shell').count()).toBe(0);
});

test('the compact shell keeps the new-chat composer inside the viewport', async () => {
  const root = await temp('compact');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());

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
