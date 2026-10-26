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
import { cleanup, webDir, temp, git, gitProject, consoleServer, type ScriptedStep, type ScriptedToolCall, type ScriptedMessage, type ScriptedBody, scriptedProvider, libraryPrompt, libraryDisabledTools, workerProposal, createConversation, conversationView, type Daemon, type ConversationView, taskView, catalogView } from "./app-shell-ux.fixture.ts";




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
