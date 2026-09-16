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
  await page.getByTestId('draft-graph').click();
  await page.getByTestId('detail-drawer').waitFor();
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
