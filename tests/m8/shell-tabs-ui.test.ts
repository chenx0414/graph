import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;

beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-shell-tabs-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);

afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'graph-shell-tabs-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
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
  return { server, page };
}

/** The tabs the user sees, as `kind` + title, read back out of the DOM. */
async function tabs(page: Awaited<ReturnType<typeof harness>>['page']) {
  return page.locator('.tab').evaluateAll(nodes => nodes.map(node => ({
    kind: node.getAttribute('data-kind'),
    key: node.getAttribute('data-tab-key'),
    title: node.querySelector('.tab-title')?.textContent ?? '',
    active: node.getAttribute('data-active') === 'true',
  })));
}

test('the shell opens one tab per destination, keeps the second visit on the first tab, and closes onto the neighbour', async () => {
  const { server, page } = await harness();
  const first = await server.runtime.conversations.create({ text: '第一段对话', requestId: 'first' });
  await server.runtime.conversations.create({ text: '第二段对话', requestId: 'second' });
  await page.goto(server.url);
  await page.getByTestId('new-conversation-input').waitFor();

  // An empty workspace says so, and the new-chat page is not a tab.
  expect(await page.getByTestId('tab-bar-empty').innerText()).toContain('没有打开的窗口');
  expect(await tabs(page)).toEqual([]);

  // Following a conversation from the list opens its tab and puts it in front.
  await page.getByTestId('conversation-list').getByText('第一段对话').click();
  // The tab is named after the conversation itself, not the generic placeholder.
  await expect.poll(() => tabs(page)).toEqual([{ kind: 'conversation', key: first.conversationId, title: '第一段对话', active: true }]);

  // A rail page is a tab too, and the conversation keeps its own.
  await page.getByTestId('rail-usage').click();
  await expect.poll(async () => (await tabs(page)).map(tab => tab.kind)).toEqual(['conversation', 'page']);
  expect((await tabs(page))[1]).toMatchObject({ key: 'usage', title: '用量', active: true });

  // Going back to a destination that already has a tab reuses it instead of opening a second.
  await page.getByTestId('tab-open-0').click();
  await expect.poll(async () => { const list = await tabs(page); return [list.length, list[0]!.active]; }).toEqual([2, true]);
  await page.getByTestId('rail-usage').click();
  await expect.poll(async () => (await tabs(page)).length).toBe(2);

  // Closing the tab in front hands the front to the neighbour on its right.
  await page.getByTestId('tab-close-0').click();
  await expect.poll(() => tabs(page)).toEqual([{ kind: 'page', key: 'usage', title: '用量', active: true }]);

  // Closing the last tab leaves an empty workspace and returns to the new-chat page.
  await page.getByTestId('tab-close-0').click();
  await page.getByTestId('tab-bar-empty').waitFor();
  expect(await tabs(page)).toEqual([]);
  await page.getByTestId('new-conversation-input').waitFor();

  // The + button starts a new conversation from wherever the user is.
  await page.getByTestId('rail-catalog').click();
  await expect.poll(async () => (await tabs(page)).length).toBe(1);
  await page.getByTestId('tab-new').click();
  await expect.poll(async () => (await tabs(page)).length).toBe(1);
  await page.getByTestId('new-conversation-input').waitFor();
});

test('one task can be open in several tabs: its graph and one of its nodes are separate tabs', async () => {
  const { server, page } = await harness();
  const { taskId } = await server.runtime.user.begin({ projectId: 'alpha', request: '外壳与标签栏', requestId: 'tabs-task' });
  await page.goto(server.url);
  await page.getByTestId('new-conversation-input').waitFor();

  await page.evaluate(id => { location.hash = `#/tasks/${id}/graph`; }, taskId);
  await expect.poll(() => tabs(page)).toEqual([{ kind: 'graph', key: taskId, title: '任务图 · 外壳与标签栏', active: true }]);

  await page.evaluate(id => { location.hash = `#/tasks/${id}/nodes/impl-shell`; }, taskId);
  await expect.poll(async () => (await tabs(page)).map(tab => [tab.kind, tab.key, tab.title])).toEqual([
    ['graph', taskId, '任务图 · 外壳与标签栏'],
    ['node', `${taskId}/impl-shell`, '节点 impl-shell'],
  ]);
  expect((await tabs(page))[1]).toMatchObject({ active: true });

  // The same graph again is still two tabs, not three: the node keeps its own address.
  await page.evaluate(id => { location.hash = `#/tasks/${id}/graph`; }, taskId);
  await expect.poll(async () => (await tabs(page)).map(tab => tab.active)).toEqual([true, false]);

  // Settings replaces the whole shell, so it is deliberately not a tab.
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.getByTestId('settings-shell').waitFor();
  expect(await page.getByTestId('tab-bar').count()).toBe(0);
});

test('the drawer toggle sits in the workspace bar on every window, and outside a conversation the drawer is only a launcher', async () => {
  const { server, page } = await harness();
  const { taskId } = await server.runtime.user.begin({ projectId: 'alpha', request: '外壳目录', requestId: 'tabs-drawer' });
  await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();

  const toggle = page.getByTestId('workspace-drawer-toggle');
  await toggle.waitFor();
  expect(await toggle.getAttribute('data-open')).toBe('false');
  // The desktop window makes the workspace bar a drag region: a control in it that does not opt
  // out is draggable and never receives a click (it looked fine in a plain browser).
  expect(await toggle.evaluate(element => getComputedStyle(element.parentElement!).getPropertyValue('-webkit-app-region').trim())).toBe('no-drag');
  await toggle.click();
  const drawer = page.getByTestId('detail-drawer');
  await drawer.waitFor();
  expect(await drawer.getAttribute('data-section')).toBe('workspace');
  // The launcher offers the shared-artifact index and the task list, and renders neither itself.
  expect(await page.getByTestId('drawer-workspace-artifacts').getAttribute('href')).toBe('#/artifacts?project=alpha');
  await page.getByTestId('drawer-workspace-tasks').waitFor();
  expect(await drawer.locator('[data-testid="graph"], [data-testid="drawer-artifacts"]').count()).toBe(0);

  // It stays available on the next window too, and that window is a tab of its own.
  await page.getByTestId('drawer-workspace-artifacts').click();
  await page.getByTestId('artifact-index').waitFor();
  expect(await page.getByTestId('workspace-drawer-toggle').isVisible()).toBe(true);
  await expect.poll(async () => (await tabs(page)).map(tab => tab.kind)).toEqual(['graph', 'page']);

  // Navigating closed the launcher again; the toggle is still there, opens it, and closes it.
  const laterToggle = page.getByTestId('workspace-drawer-toggle');
  await expect.poll(() => laterToggle.getAttribute('data-open')).toBe('false');
  await laterToggle.click();
  await drawer.waitFor();
  expect(await laterToggle.getAttribute('data-open')).toBe('true');
  // An open panel covers the right end of the bar, so its own close button is the same corner.
  await drawer.getByRole('button', { name: '关闭详情' }).click();
  await drawer.waitFor({ state: 'hidden' });
  expect(await laterToggle.getAttribute('data-open')).toBe('false');
  // With the panel away the bar toggle is clickable again.
  await laterToggle.click();
  await drawer.waitFor();
  expect(await laterToggle.getAttribute('data-open')).toBe('true');
}, 60_000);

test('switching into a conversation does not replay a page entrance animation or duplicate context loading', async () => {
  const { server, page } = await harness();
  const conversation = await server.runtime.conversations.create({ text: '即时切换', requestId: 'fast-tabs' });
  let contextRequests = 0;
  page.on('request', request => { if (request.url().includes('/api/agent-context?')) contextRequests++; });
  await page.goto(`${server.url}/#/conversations/${conversation.conversationId}`);
  await page.getByTestId('chat-input').waitFor();
  const duration = await page.getByTestId('conversation').evaluate(element => getComputedStyle(element).animationDuration);
  expect(duration).toBe('0s');
  expect(contextRequests).toBe(1);
});

test('workspace shortcuts retain conversation DOM and drafts, open context in a tab, and close the last tab', async () => {
  const { server, page } = await harness();
  const conversation = await server.runtime.conversations.create({ text: '快捷键测试', requestId: 'keyboard-tabs' });
  await page.goto(`${server.url}/#/conversations/${conversation.conversationId}`);
  const input = page.getByTestId('chat-input');
  await input.fill('保留这份草稿');
  await page.getByTestId('conversation').evaluate(element => { element.setAttribute('data-retained', 'yes'); });
  expect(await page.locator('.conversation-header, .agent-context-bar').count()).toBe(0);
  expect(await page.getByTestId('rail-new').count()).toBe(0);
  expect(await page.locator('.sidebar-label').filter({ hasText: '最近' }).getByTestId('new-conversation-recent').count()).toBe(1);
  await page.getByTestId('agent-context-open').click();
  await page.getByTestId('agent-context-drawer').waitFor();
  await expect.poll(async () => (await tabs(page)).map(tab => tab.kind)).toEqual(['conversation', 'context']);
  await page.keyboard.press('Meta+1');
  await input.waitFor();
  expect(await input.innerText()).toBe('保留这份草稿');
  expect(await page.getByTestId('conversation').getAttribute('data-retained')).toBe('yes');
  await input.focus();
  await page.keyboard.press('Meta+9');
  await expect.poll(async () => (await tabs(page))[1]?.active).toBe(true);
  await page.keyboard.press('Meta+w');
  await expect.poll(async () => (await tabs(page)).map(tab => tab.kind)).toEqual(['conversation']);
  await input.waitFor();
  await input.focus();
  await page.keyboard.press('Meta+w');
  await page.getByTestId('new-conversation-input').waitFor();
  expect(await tabs(page)).toEqual([]);
  await page.screenshot({ path: '/tmp/graph-tabs-new.png' });
});
