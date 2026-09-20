import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { appendNodeEntry } from '../../src/core/node-run.ts';
import { TaskStore } from '../../src/core/store.ts';
import { openGraphServer } from '../../src/server/host.ts';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';

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

  const mainDetailToggle = page.getByTestId('detail-toggle');
  await mainDetailToggle.waitFor();
  await mainDetailToggle.click();
  await page.getByTestId('detail-drawer').waitFor();
  expect(await page.getByTestId('detail-empty').innerText()).toContain('暂无详情');
  await mainDetailToggle.click();
  await page.getByTestId('detail-drawer').waitFor({ state: 'detached' });
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
  await page.locator('.settings-nav-item').filter({ hasText: '归档对话' }).click();
  await page.getByTestId(`archived-conversation-${created.conversationId}`).waitFor();
  expect(await page.getByTestId(`archived-conversation-${created.conversationId}`).innerText()).toContain('alpha');
  await page.getByTestId(`archived-conversation-${created.conversationId}`).getByRole('button', { name: '取消归档' }).click();
  await page.getByTestId('archived-empty').waitFor();

  await page.goto(server.url);
  await expect.poll(() => page.getByTestId('conversation-list').innerText()).toContain('需要归档的对话');
});

test('chat and graph tabs keep proposal details and node inspection independent', async () => {
  const root = await temp('drawer');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'app-shell-agent-detail');
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '先讨论一下', requestId: 'conversation' });
  const view = await server.runtime.conversations.view(created.conversationId);
  const firstProposal = {
    requirementVersion: 1,
    summary: '先做一个最小版本',
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program' as const, action: 'check', dependsOn: ['work'] },
    ],
  };
  await server.runtime.supervisor(view.anchorTaskId).propose(firstProposal, 'draft-1');
  await server.runtime.supervisor(view.anchorTaskId).propose({
    requirementVersion: 1,
    summary: '第二版增加审查',
    acceptance: [{ id: 'reviewed', description: '独立审查通过', checkNode: 'review' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'review', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
      { id: 'human', kind: 'program', action: 'graph.human_check', dependsOn: ['review'] },
    ],
  }, 'draft-2');

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
  expect(await page.getByTestId('conversation-tab-chat').getAttribute('data-active')).toBe('true');
  expect(await page.getByTestId('conversation-tab-graph').getAttribute('data-active')).toBe('false');
  const beforeMain = await page.locator('.conversation-main').boundingBox();
  const beforeComposer = await page.locator('.conversation-composer-wrap').boundingBox();
  expect(beforeMain).not.toBeNull();
  expect(beforeComposer).not.toBeNull();

  await page.getByTestId('draft-acceptance').click();
  await page.getByTestId('detail-drawer').waitFor();
  expect(await page.getByTestId('detail-toggle').getAttribute('data-open')).toBe('true');
  await page.waitForTimeout(260);
  await expect.poll(async () => (await page.locator('.conversation-main').boundingBox())!.width)
    .toBeLessThan(beforeMain!.width - 240);
  const afterMain = await page.locator('.conversation-main').boundingBox();
  const afterComposer = await page.locator('.conversation-composer-wrap').boundingBox();
  const drawerBox = await page.getByTestId('detail-drawer').boundingBox();
  expect(afterMain).not.toBeNull();
  expect(afterComposer).not.toBeNull();
  expect(drawerBox).not.toBeNull();
  expect(afterMain!.width).toBeGreaterThan(0);
  expect(drawerBox!.width).toBeGreaterThan(300);
  await expect.poll(async () => {
    const main = await page.locator('.conversation-main').boundingBox();
    const drawer = await page.getByTestId('detail-drawer').boundingBox();
    return Boolean(main && drawer && main.x + main.width <= drawer.x + 1);
  }).toBe(true);
  const settledMain = await page.locator('.conversation-main').boundingBox();
  const settledComposer = await page.locator('.conversation-composer-wrap').boundingBox();
  const settledDrawer = await page.getByTestId('detail-drawer').boundingBox();
  expect(settledMain).not.toBeNull();
  expect(settledComposer).not.toBeNull();
  expect(settledDrawer).not.toBeNull();
  expect(settledComposer!.x + settledComposer!.width).toBeLessThanOrEqual(settledDrawer!.x + 1);
  expect(afterComposer!.y + afterComposer!.height).toBeLessThanOrEqual(720);
  expect(await page.locator('[data-testid="detail-toggle-close"]').count()).toBe(0);

  await page.getByTestId('draft-page-acceptance').waitFor();
  expect(await page.getByTestId('draft-page-acceptance').innerText()).toContain('独立审查通过');
  await page.getByTestId('drawer-draft-version-1').click();
  await expect.poll(() => page.getByTestId('drawer-draft-version-1').getAttribute('data-active')).toBe('true');
  await expect.poll(() => page.getByTestId('draft-page-acceptance').innerText()).toContain('检查通过');

  await page.getByTestId('draft-tab-nodes').click();
  const nodes = await page.getByTestId('draft-page-nodes').innerText();
  expect(nodes).toContain('work');
  expect(nodes).toContain('check');

  await page.getByTestId('draft-tab-decisions').click();
  await page.getByTestId('draft-decisions-empty').waitFor();

  await page.getByTestId('detail-toggle').click();
  await expect.poll(() => page.getByTestId('detail-toggle').getAttribute('data-open')).toBe('false');
  await page.getByTestId('detail-drawer').waitFor({ state: 'hidden' });

  await page.getByTestId('draft-graph').click();
  await page.getByTestId('conversation-graph').waitFor();
  expect(await page.getByTestId('conversation-tab-graph').getAttribute('data-active')).toBe('true');
  expect(await page.getByTestId('conversation-tab-chat').getAttribute('data-active')).toBe('false');
  expect(await page.getByTestId('detail-toggle').getAttribute('data-open')).toBe('false');
  expect(await page.getByTestId('chat-input').count()).toBe(0);
  await page.getByTestId('draft-graph-detail').waitFor();
  expect(await page.getByTestId('graph-state-summary').innerText()).toContain('任务状态');
  expect(await page.locator('.node-card[data-node-id="human"]').innerText()).toContain('human check');
  expect(await page.locator('.node-card[data-node-id="human"]').getAttribute('data-node-type')).toBe('human');
  await expect.poll(async () => {
    const body = await page.locator('.conversation-body').boundingBox();
    const graph = await page.locator('.conversation-graph-main').boundingBox();
    return Boolean(body && graph && Math.abs(body.width - graph.width) <= 1);
  }).toBe(true);

  await page.getByTestId('draft-version-1').click();
  await expect.poll(() => page.getByTestId('conversation-graph-title').innerText()).toContain('先做一个最小版本');
  await page.locator('.react-flow__node').filter({ hasText: 'work' }).first().click();
  const nodeDetail = page.getByTestId('conversation-node-detail');
  await nodeDetail.waitFor();
  expect(await nodeDetail.innerText()).toContain('work');
  expect(await nodeDetail.innerText()).toContain('coder@1');
  expect(await nodeDetail.innerText()).toContain('Fresh');
  expect(await nodeDetail.innerText()).toContain('工作经历');
  expect(await nodeDetail.innerText()).toContain('灌输的指令');
  expect(await nodeDetail.innerText()).toMatch(/传递的 handoff/i);

  await page.getByTestId('conversation-tab-chat').click();
  await page.locator('.conversation-composer-wrap').waitFor();
  expect(await page.getByTestId('conversation-tab-chat').getAttribute('data-active')).toBe('true');
});

test('a graph agent node opens the same chat transcript used by the main agent', async () => {
  const root = await temp('agent-node-chat');
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root: project }],
    webDir,
    autoDrive: false,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'agent-node-chat-definition');
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '启动节点', requestId: 'agent-node-chat-create' });
  const view = await server.runtime.conversations.view(created.conversationId);
  await server.runtime.supervisor(view.anchorTaskId).propose({
    requirementVersion: 1,
    summary: '节点聊天',
    acceptance: [{ id: 'ok', description: '完成', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'graph.human_check', dependsOn: ['work'] },
    ],
  }, 'agent-node-chat-proposal');
  await server.runtime.projects.prepare({ projectId: 'alpha', requestId: 'agent-node-chat-prepare', initialize: true, createBaseline: true });
  const confirmed = await server.runtime.conversations.confirm(created.conversationId, {
    proposalVersion: 1,
    targetBranch: 'main',
    requestId: 'agent-node-chat-confirm',
  });
  const projection = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(async () => projection.close());
  appendNodeEntry(projection, { taskId: confirmed.taskId, nodeId: 'work', role: 'user', kind: 'briefing', text: '实现 README 功能' });
  appendNodeEntry(projection, {
    taskId: confirmed.taskId,
    nodeId: 'work',
    role: 'tool',
    kind: 'call',
    text: 'README.md',
    data: { toolCallId: 'read-readme', toolName: 'read' },
  });
  appendNodeEntry(projection, {
    taskId: confirmed.taskId,
    nodeId: 'work',
    role: 'tool',
    kind: 'result',
    text: '工具执行完成',
    data: { toolCallId: 'read-readme', toolName: 'read', isError: false },
  });
  appendNodeEntry(projection, {
    taskId: confirmed.taskId,
    nodeId: 'work',
    role: 'assistant',
    kind: 'message',
    text: '实现完成。',
  });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('draft-graph').click();
  await page.locator('.react-flow__node').filter({ hasText: 'work' }).first().click();
  await page.getByTestId('open-agent-chat').click();
  const chat = page.getByTestId('graph-agent-chat');
  await chat.waitFor();
  expect(await chat.innerText()).toContain('AGENT 节点对话');
  await expect.poll(() => chat.innerText()).toContain('任务说明');
  expect(await chat.innerText()).toContain('实现 README 功能');
  expect(await chat.innerText()).toContain('读取 1 项');
  expect(await chat.innerText()).toContain('coder · 回复');
  expect(await chat.innerText()).toContain('实现完成。');
  expect(await chat.getByRole('button', { name: '发送' }).count()).toBe(0);
  await chat.getByRole('button', { name: '展开工具活动' }).click();
  expect(await chat.innerText()).toContain('README.md');
  await chat.getByRole('button', { name: '关闭节点对话' }).click();
  await chat.waitFor({ state: 'detached' });
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

  await page.getByTestId('conversation-tab-graph').click();
  await page.getByTestId('conversation-graph-empty').waitFor();
  expect(await page.getByTestId('conversation-tab-graph').getAttribute('data-active')).toBe('true');
  await page.getByTestId('conversation-tab-chat').click();
  await page.locator('.conversation-main').waitFor();

  await toggle.click();
  await page.getByTestId('detail-drawer').waitFor();
  expect(await page.getByTestId('detail-empty').innerText()).toContain('暂无详情');
  expect(await toggle.getAttribute('data-open')).toBe('true');

  await toggle.click();
  await expect.poll(() => toggle.getAttribute('data-open')).toBe('false');
  await page.getByTestId('detail-drawer').waitFor({ state: 'hidden' });
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
  expect(await page.getByTestId('tool-activity-group').getAttribute('data-open')).toBe('false');
  expect(await page.getByTestId('telemetry-cache').innerText()).toContain('75%');
  expect(await page.getByTestId('telemetry-context').innerText()).toContain('8,000 / 32,000');
  expect(await page.getByTestId('telemetry-model').innerText()).toContain('local');
  expect(await page.getByTestId('telemetry-thinking').innerText()).toContain('关闭');
});

test('live tool activity groups and streamed markdown follow the transcript tail', async () => {
  const root = await temp('stream');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());

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
  expect(await tools.getAttribute('data-open')).toBe('true');
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
  await answer.waitFor();
  expect(await answer.innerText()).toContain('最终回答');
  expect(await page.getByTestId('streaming').count()).toBe(0);
  expect(await page.getByTestId('tool-activity-group').count()).toBe(0);
  expect(await page.getByTestId('message-assistant').count()).toBe(1);
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
  const slider = page.getByTestId('thinking-slider');
  await slider.evaluate(element => {
    const input = element as HTMLInputElement;
    input.value = '3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await expect.poll(() => selections.length).toBe(1);
  expect(selections[0]).toMatchObject({ model: 'local', thinkingLevel: 'high' });
  expect(await page.getByTestId('toasts').innerText()).not.toContain('已切换为');
  await page.getByTestId('model-menu').waitFor();

  await page.getByTestId('model-option-fast').click();
  await expect.poll(() => selections.length).toBe(2);
  expect(selections[1]).toMatchObject({ model: 'fast', thinkingLevel: 'off' });
  await page.getByTestId('model-menu').waitFor();
  await page.getByTestId('conversation-title').click();
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
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
    catalog: { capabilityRoot, recipesPath: join(root, 'graph', 'agent-combinations.json') },
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
  expect(await page.getByTestId('resource-nav-skills').getAttribute('data-active')).toBe('true');
  expect(await page.getByTestId('resource-section-skills').innerText()).toContain('Preserving Productive Tensions');
  await page.getByTestId('resource-catalog-search').fill('not-a-real-resource');
  expect(await page.getByTestId('resource-section-skills').innerText()).toContain('没有匹配的能力');
  await page.getByTestId('resource-catalog-search').fill('');
  expect(await page.getByTestId('resource-section-skills').innerText()).toContain('Preserving Productive Tensions');
  await page.getByTestId('resource-open-skills').click();
  expect(await page.evaluate(() => (window as Window & { __openedResourceKinds?: string[] }).__openedResourceKinds)).toEqual(['skills']);

  await page.getByTestId('resource-nav-mcp').click();
  await page.getByTestId('resource-section-mcp').waitFor();
  expect(await page.getByTestId('resource-section-mcp').innerText()).toContain('Jira');
  await page.getByTestId('resource-open-mcp').click();

  await page.getByTestId('resource-nav-agent-md').click();
  await page.getByTestId('resource-section-agent-md').waitFor();
  expect(await page.getByTestId('resource-section-agent-md').innerText()).toContain('架构师');
  await page.getByTestId('resource-open-agent-md').click();
  expect(await page.evaluate(() => (window as Window & { __openedResourceKinds?: string[] }).__openedResourceKinds)).toEqual(['skills', 'mcp', 'agent-md']);

  await page.getByTestId('resource-nav-pi-extensions').click();
  await page.getByTestId('resource-section-pi-extensions').waitFor();
  expect(await page.getByTestId('resource-section-pi-extensions').innerText()).toContain('Pi MCP Extension');

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
  expect(await page.getByTestId('agent-combination-code').innerText()).toContain('Bob_coder');
  expect(await page.getByTestId('resource-section-agents').innerText()).toContain('Bob_coder');
  expect(await page.getByTestId('resource-section-agents').innerText()).toContain('可编译');
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
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
    catalog: { capabilityRoot, recipesPath },
  });
  cleanup.push(() => server.close());

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/catalog/agents`);
  await page.getByTestId('agent-combination-worker').waitFor();
  await page.getByTestId('agent-combination-worker').getByRole('button', { name: '编辑' }).click();
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
});

test('the resource config page saves capability credentials and verifies the selected MCP', async () => {
  const root = await temp('resource-config');
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const mcp = join(capabilityRoot, 'exa-web-search');
  await mkdir(mcp, { recursive: true });
  await writeFile(join(mcp, 'capability.json'), JSON.stringify({
    id: 'exa-web-search',
    kind: 'mcp',
    version: '3.4.1',
    name: 'Exa Web Search',
    description: 'Web search through Exa.',
    url: 'https://mcp.exa.ai/mcp',
    headersEnv: { authorization: 'EXA_API_KEY' },
  }, null, 2));
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
    catalog: { capabilityRoot, recipesPath: join(root, 'graph', 'agent-combinations.json') },
  });
  cleanup.push(() => server.close());
  const verified: { values?: Record<string, string> }[] = [];

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.graph = {
      isDesktop: true,
      pickDirectory: async () => null,
      openResource: async () => ({ opened: true }),
      saveSecret: async (ref, value) => {
        (window as Window & { __savedCapabilitySecrets?: { ref: string; value: string }[] }).__savedCapabilitySecrets!.push({ ref, value: value ?? '' });
        return { stored: true, applied: true };
      },
      secretStatus: async () => ({}),
      relaunch: async () => ({ url: location.origin }),
    };
    (window as Window & { __savedCapabilitySecrets?: { ref: string; value: string }[] }).__savedCapabilitySecrets = [];
  });
  await page.route('**/api/capabilities/exa-web-search/3.4.1/test', async route => {
    verified.push(JSON.parse(route.request().postData() ?? '{}') as { values?: Record<string, string> });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, tools: ['search'], message: '连接成功，发现 1 个工具' }),
    });
  });
  await page.goto(`${server.url}/#/catalog/config`);
  await page.getByTestId('resource-nav-config').click();
  await page.getByTestId('resource-section-config').waitFor();
  expect(await page.getByTestId('resource-section-config').innerText()).toContain('Exa Web Search');
  expect(await page.getByTestId('capability-config-exa-web-search').innerText()).toContain('EXA_API_KEY');
  expect(await page.getByTestId('resource-open-config').count()).toBe(0);
  await page.getByTestId('capability-config-exa-web-search-EXA_API_KEY').fill('exa-secret');
  await page.getByRole('button', { name: '保存并验证' }).click();
  await expect.poll(() => verified.length).toBe(1);
  expect(verified[0]?.values).toEqual({ EXA_API_KEY: 'exa-secret' });
  expect(await page.evaluate(() => (window as Window & { __savedCapabilitySecrets?: { ref: string; value: string }[] }).__savedCapabilitySecrets)).toEqual([
    { ref: 'EXA_API_KEY', value: 'exa-secret' },
  ]);
  expect(await page.getByTestId('capability-config-result-exa-web-search').innerText()).toContain('连接成功');
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
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
    catalog: { capabilityRoot, recipesPath },
  });
  cleanup.push(() => server.close());

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

test('the new-chat composer switches model and thinking before the conversation starts', async () => {
  const root = await temp('new-chat-model');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 2, enabledModelCount: 2 },
  });
  cleanup.push(() => server.close());
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
  // The pre-creation composer shows the daemon default and its thinking level.
  expect(await page.getByTestId('telemetry-model').innerText()).toContain('local');
  expect(await page.getByTestId('telemetry-thinking').innerText()).toContain('低');
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
  // A non-reasoning model clamps thinking to off before the conversation exists.
  expect(creates[0]).toMatchObject({ text: '用选中的模型开始', model: 'fast', thinkingLevel: 'off' });
}, 60_000);

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
  const nav = page.locator('.settings-nav');
  expect(await nav.innerText()).toContain('Git 准备');
  expect(await nav.innerText()).toContain('模型');
  expect(await nav.innerText()).toContain('归档对话');
  expect(await nav.innerText()).not.toContain('项目');
  expect(await nav.innerText()).not.toContain('并发限制');
  expect(await nav.innerText()).not.toContain('连接与配置向导');
  expect(await nav.innerText()).not.toContain('凭据');
  expect(await nav.innerText()).not.toContain('模型偏好');
  expect(await page.locator('.app-shell').count()).toBe(0);

  await nav.getByRole('button', { name: '模型' }).click();
  expect(await page.getByTestId('settings-page').getAttribute('data-page')).toBe('settings-models');
  expect(await nav.getByRole('button', { name: '模型' }).getAttribute('data-active')).toBe('true');
  expect(await page.locator('#settings-overview').count()).toBe(0);
  await nav.getByRole('button', { name: 'Git 准备' }).click();
  expect(await page.getByTestId('settings-page').getAttribute('data-page')).toBe('settings-git');
  expect(await nav.getByRole('button', { name: 'Git 准备' }).getAttribute('data-active')).toBe('true');
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

test('the chat header exposes editable Agent prompts and Main Agent tools', async () => {
  const root = await temp('agent-context');
  const agentContext = openAgentContextLibrary(join(root, 'graph', 'prompts'), { identity: 'Default Main' });
  await agentContext.ensure();
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
    agentContext,
  });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ text: '检查 Agent 上下文', requestId: 'agent-context-ui' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('agent-context-bar').waitFor();
  expect(await page.getByTestId('agent-context-bar').innerText()).toContain('Agent 上下文');

  await page.getByTestId('agent-context-open').click();
  await page.getByTestId('agent-context-drawer').waitFor();
  await page.getByTestId('agent-context-preview').waitFor();
  const preview = await page.getByTestId('agent-context-preview').innerText();
  expect(preview).toContain('<identity>');
  expect(preview).toContain('<tools>');
  expect(preview).toContain('<rules>');
  expect(preview).toContain('<docs>');
  expect(preview).toContain('<project_context>');
  expect(preview).toContain('<capabilities>');
  expect(preview).toContain('<cwd>');
  expect(preview).toContain('Pi 自动追加');
  await page.getByTestId('agent-context-tab-prompts').click();
  await page.getByTestId('agent-prompt-runtime/main-conversation.md').click();
  await page.getByTestId('agent-prompt-editor').fill('CUSTOM CONVERSATION {{fullAccessInstruction}}');
  await page.getByRole('button', { name: '保存 Prompt' }).click();
  await expect.poll(() => agentContext.override('runtime/main-conversation.md')).toContain('CUSTOM CONVERSATION');
  await page.getByRole('button', { name: '恢复默认' }).click();
  await expect.poll(() => agentContext.override('runtime/main-conversation.md')).not.toContain('CUSTOM CONVERSATION');

  await page.getByTestId('agent-context-tab-tools').click();
  await page.getByTestId('agent-tool-write_file').uncheck();
  await page.getByRole('button', { name: '保存工具选择' }).click();
  await expect.poll(() => agentContext.disabledTools()).toContain('write_file');
}, 60_000);
