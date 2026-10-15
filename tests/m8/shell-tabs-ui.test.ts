import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

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
  await page.getByTestId('task-graph-title').waitFor();
  expect(await page.getByTestId('task-graph-title').evaluate(element => getComputedStyle(element).whiteSpace)).toBe('normal');
  expect(await page.getByTestId('flow').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(640);

  const toggle = page.getByTestId('workspace-drawer-toggle');
  await toggle.waitFor();
  expect(await toggle.getAttribute('data-open')).toBe('false');
  // The desktop window makes the workspace bar a drag region: a control in it that does not opt
  // out is draggable and never receives a click (it looked fine in a plain browser).
  expect(await toggle.evaluate(element => getComputedStyle(element.parentElement!).getPropertyValue('-webkit-app-region').trim())).toBe('no-drag');
  await toggle.click();
  const drawer = page.getByTestId('detail-drawer');
  await drawer.waitFor();
  expect(await drawer.getAttribute('data-section')).toBe('task');
  expect(await drawer.getByRole('button', { name: '关闭详情' }).count()).toBe(0);
  expect(await page.getByTestId('drawer-task-artifacts').getAttribute('href')).toBe('#/artifacts?project=alpha');
  await page.getByTestId('drawer-workspace-tasks').waitFor();
  await page.screenshot({ path: '/tmp/graph-unified-drawer.png' });
  expect(await drawer.locator('[data-testid="graph"], [data-testid="drawer-artifacts"]').count()).toBe(0);

  // It stays available on the next window too, and that window is a tab of its own.
  await page.getByTestId('drawer-task-artifacts').click();
  await page.getByTestId('artifact-index').waitFor();
  expect(await page.getByTestId('workspace-drawer-toggle').isVisible()).toBe(true);
  await expect.poll(async () => (await tabs(page)).map(tab => tab.kind)).toEqual(['graph', 'page']);

  // Navigating closed the launcher again; the toggle is still there, opens it, and closes it.
  const laterToggle = page.getByTestId('workspace-drawer-toggle');
  await expect.poll(() => laterToggle.getAttribute('data-open')).toBe('false');
  await laterToggle.click();
  await drawer.waitFor();
  expect(await laterToggle.getAttribute('data-open')).toBe('true');
  // The toolbar button remains the only drawer toggle.
  await laterToggle.click();
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

test('three real conversations close onto their right or left neighbour while closing a background tab preserves the visible conversation', async () => {
  const { server, page } = await harness();
  const created: Awaited<ReturnType<typeof server.runtime.conversations.create>>[] = [];
  for (const [index, text] of ['左侧会话', '中间会话', '右侧会话'].entries()) {
    created.push(await server.runtime.conversations.create({ text, requestId: `neighbour-${index}` }));
  }
  const tab = (id: string) => page.locator(`.tab[data-kind="conversation"][data-tab-key="${id}"]`);
  const visit = async (index: number) => {
    await page.evaluate(id => { location.hash = `#/conversations/${id}`; }, created[index]!.conversationId);
    await expect.poll(() => tab(created[index]!.conversationId).getAttribute('data-active')).toBe('true');
  };
  const active = async () => (await tabs(page)).filter(item => item.active).map(item => item.key);
  await page.goto(server.url);
  await page.getByTestId('new-conversation-input').waitFor();
  for (const index of [0, 1, 2, 0, 2]) await visit(index);
  await expect.poll(async () => (await tabs(page)).map(item => item.key)).toEqual(created.map(item => item.conversationId));
  // Background close must not move the front or navigate its document.
  await tab(created[0]!.conversationId).locator('.tab-close').click();
  await expect.poll(() => active()).toEqual([created[2]!.conversationId]);
  expect(new URL(page.url()).hash).toBe(`#/conversations/${created[2]!.conversationId}`);
  await expect.poll(async () => (await tabs(page)).map(item => item.key)).toEqual([created[1]!.conversationId, created[2]!.conversationId]);
  // Rightmost active closes left, because it has no right neighbour.
  await tab(created[2]!.conversationId).locator('.tab-close').click();
  await expect.poll(() => active()).toEqual([created[1]!.conversationId]);
  expect(new URL(page.url()).hash).toBe(`#/conversations/${created[1]!.conversationId}`);
  // Reopen left and right; close the middle while both neighbours exist.
  await visit(0); await visit(2); await visit(0);
  await expect.poll(async () => (await tabs(page)).map(item => item.key)).toEqual([created[1]!.conversationId, created[0]!.conversationId, created[2]!.conversationId]);
  await tab(created[0]!.conversationId).locator('.tab-close').click();
  await expect.poll(() => active()).toEqual([created[2]!.conversationId]);
  expect(new URL(page.url()).hash).toBe(`#/conversations/${created[2]!.conversationId}`);
  await tab(created[2]!.conversationId).locator('.tab-close').click();
  await expect.poll(() => active()).toEqual([created[1]!.conversationId]);
  await tab(created[1]!.conversationId).locator('.tab-close').click();
  await page.getByTestId('tab-bar-empty').waitFor();
  expect(await tabs(page)).toEqual([]);
  expect(new URL(page.url()).hash).toBe('#/');
  await page.getByTestId('new-conversation-input').waitFor();
}, 60_000);

test('real navigation keeps page titles and the latest catalog address while task aliases share one graph and settings take over the shell', async () => {
  const { server, page } = await harness();
  server.runtime.catalog.publishDefinition('tab-worker', { recommendedGrade: 'medium' }, 'A worker to inspect without dispatch.');
  const owner = await server.runtime.user.begin({ projectId: 'alpha', request: '真实标签目的地', requestId: 'route-owner' });
  const graph = await server.runtime.supervisor(owner.taskId).graphCreate({ definition: {
    schemaVersion: 2, name: '真实图标题', protocols: {},
    nodes: { work: { recipe: 'tab-worker@1', task: 'Wait for input', inputs: {}, outputs: {}, submission: {} } },
    modules: {}, edges: {}, inputs: {}, outputs: {},
  } }) as { graphId: string };
  await page.goto(server.url);
  await page.getByTestId('new-conversation-input').waitFor();
  const cases = [
    { rail: 'rail-inbox', key: 'inbox', title: '问题', hash: '#/inbox' },
    { rail: 'rail-usage', key: 'usage', title: '用量', hash: '#/usage' },
    { rail: 'rail-tools', key: 'tools', title: '工具', hash: '#/tools' },
    { rail: 'rail-models', key: 'models', title: '模型', hash: '#/models' },
    { rail: 'rail-catalog', key: 'catalog', title: '资源库', hash: '#/catalog' },
  ];
  for (const row of cases) {
    await page.getByTestId(row.rail).click();
    await expect.poll(async () => (await tabs(page)).filter(item => item.active)).toEqual([{ kind: 'page', key: row.key, title: row.title, active: true }]);
    expect(new URL(page.url()).hash).toBe(row.hash);
  }
  await page.getByTestId('resource-nav-skills').click();
  await expect.poll(() => page.getByTestId('resource-nav-skills').getAttribute('data-active')).toBe('true');
  await page.getByTestId('resource-nav-mcp').click();
  await expect.poll(() => page.getByTestId('resource-nav-mcp').getAttribute('data-active')).toBe('true');
  expect(new URL(page.url()).hash).toBe('#/catalog/mcp');
  await page.getByTestId('rail-usage').click();
  await page.locator('.tab[data-kind="page"][data-tab-key="catalog"] .tab-open').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/catalog/mcp');
  expect((await tabs(page)).filter(item => item.key === 'catalog')).toHaveLength(1);
  // Both actual graph URLs address the same graph and keep its loaded title.
  for (const path of [`#/tasks/${graph.graphId}`, `#/tasks/${graph.graphId}/graph`]) {
    await page.evaluate(hash => { location.hash = hash; }, path);
    await page.getByTestId('graph').waitFor();
    await expect.poll(async () => (await tabs(page)).filter(item => item.kind === 'graph')).toEqual([{ kind: 'graph', key: graph.graphId, title: '任务图 · 真实图标题', active: true }]);
  }
  await page.evaluate(id => { location.hash = `#/tasks/${id}/nodes/work`; }, graph.graphId);
  await page.getByTestId('node-overview').waitFor();
  await expect.poll(async () => (await tabs(page)).filter(item => item.kind === 'node')).toEqual([{ kind: 'node', key: `${graph.graphId}/work`, title: '节点 work', active: true }]);
  for (const hash of ['#/settings', '#/setup']) {
    await page.evaluate(value => { location.hash = value; }, hash);
    await page.getByTestId('settings-shell').waitFor();
    expect(await page.getByTestId('tab-bar').count()).toBe(0);
  }
  await page.getByRole('link', { name: '返回应用', exact: true }).click();
  await page.getByTestId('new-conversation-input').waitFor();
  // Takeovers never become tabs; home keeps the set and clears active selection.
  expect((await tabs(page)).some(item => item.active)).toBe(false);
  expect((await tabs(page)).map(item => item.kind)).toEqual(['page', 'page', 'page', 'page', 'page', 'graph', 'node']);
}, 60_000);

test('a real delayed conversation list leaves a usable generic title and resolves a background title without changing the front tab', async () => {
  const { server, page } = await harness();
  const conversation = await server.runtime.conversations.create({ text: '由真实数据加载的名称', requestId: 'title-loading' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const arrived = new Promise<void>(resolve => { captured = resolve; });
  cleanup.push(() => { release(); });
  await page.route('**/api/conversations', async route => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    captured();
    await gate;
    await route.fulfill({ response });
  });
  await page.goto(`${server.url}/#/conversations/${conversation.conversationId}`);
  await arrived;
  await expect.poll(() => tabs(page)).toEqual([{ kind: 'conversation', key: conversation.conversationId, title: '对话', active: true }]);
  await page.getByTestId('rail-usage').click();
  await expect.poll(() => tabs(page)).toEqual([
    { kind: 'conversation', key: conversation.conversationId, title: '对话', active: false },
    { kind: 'page', key: 'usage', title: '用量', active: true },
  ]);
  release();
  await expect.poll(() => tabs(page)).toEqual([
    { kind: 'conversation', key: conversation.conversationId, title: '由真实数据加载的名称', active: false },
    { kind: 'page', key: 'usage', title: '用量', active: true },
  ]);
  expect(new URL(page.url()).hash).toBe('#/usage');
}, 60_000);

test('a genuine two-version artifact keeps its selected immutable version and project address when its tab is reactivated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-tab-artifact-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const vendor = await openaiServer([
    { tools: [{ id: 'publish-one', name: 'artifact_publish', arguments: JSON.stringify({ namespace: 'plans', name: 'tab-note', title: '真实产物标题', content: 'IMMUTABLE_TAB_VERSION_ONE', requestId: 'tab-artifact-one' }) }] },
    { tools: [{ id: 'publish-two', name: 'artifact_publish', arguments: JSON.stringify({ namespace: 'plans', name: 'tab-note', title: '真实产物标题', content: 'LATEST_TAB_VERSION_TWO', expectedVersion: 1, requestId: 'tab-artifact-two' }) }] },
    { text: 'Both immutable versions were published.' },
  ]);
  cleanup.push(() => vendor.close());
  const server = await openGraphServer({ stateDir: join(root, 'state'), projects: [{ id: 'alpha', root }], webDir, autoDrive: false,
    catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
    models: { apiKey: 'fixture-local-key', modelRuntime: vendor.runtime, entries: [{ id: 'local', provider: vendor.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: vendor.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] } });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('tab-writer', { recommendedGrade: 'medium' }, 'Publish the requested artifact versions.');
  const owner = await server.runtime.user.begin({ projectId: 'alpha', request: '标签产物任务', requestId: 'tab-artifact-owner' });
  const main = server.runtime.supervisor(owner.taskId);
  const { graphId } = await main.graphCreate({ definition: { schemaVersion: 2, name: '标签产物任务', protocols: { job: { type: 'object' } },
    nodes: { writer: { recipe: 'tab-writer@1', model: 'local', task: 'Publish both versions', inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {} } },
    modules: {}, edges: {}, inputs: {}, outputs: {} } }) as { graphId: string };
  await main.graphSend({ graphId, nodeId: 'writer', input: 'job', value: {} });
  await server.runtime.host.drive();
  expect(vendor.requests).toHaveLength(3);
  expect(server.runtime.nodeRun(graphId, 'writer').node.status).toBe('succeeded');
  const head = server.runtime.artifacts.list(graphId, { namespace: 'plans', prefix: 'tab-note' }).artifacts;
  expect(head).toHaveLength(1); expect(head[0]!.version).toBe(2);
  const artifactId = head[0]!.artifactId;
  const browser = await chromium.launch({ headless: true }); cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/tasks/${graphId}/graph`);
  await page.getByTestId('graph').waitFor();
  await page.getByTestId('workspace-drawer-toggle').click();
  await expect.poll(() => page.getByTestId('drawer-task-artifacts').getAttribute('href')).toBe('#/artifacts?project=alpha');
  await page.getByTestId('drawer-task-artifacts').click();
  await page.getByTestId('artifact-index').waitFor();
  expect(await page.getByTestId('artifact-index-project').inputValue()).toBe('alpha');
  await page.getByTestId(`drawer-artifact-detail-${artifactId}-2`).click();
  await expect.poll(() => page.getByTestId('artifact-tab').innerText()).toContain('LATEST_TAB_VERSION_TWO');
  await expect.poll(() => page.locator('.tab[data-kind="artifact"] .tab-title').innerText()).toBe('真实产物标题');
  // The artifact's title callback must leave the other two loaded titles intact.
  expect((await tabs(page)).map(item => [item.kind, item.title, item.active])).toEqual([
    ['graph', '任务图 · 标签产物任务', false], ['page', '共享产物', false], ['artifact', '真实产物标题', true],
  ]);
  await page.locator('.artifact-version-history summary').click();
  await page.getByTestId('artifact-history-1').click();
  await expect.poll(() => page.getByTestId('artifact-tab').innerText()).toContain('IMMUTABLE_TAB_VERSION_ONE');
  const versionHash = `#/tasks/${graphId}/artifacts/${artifactId}?v=1`;
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(versionHash);
  await page.getByTestId('rail-usage').click();
  await page.locator('.tab[data-kind="artifact"] .tab-open').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(versionHash);
  await expect.poll(() => page.getByTestId('artifact-tab').innerText()).toContain('IMMUTABLE_TAB_VERSION_ONE');
  expect((await tabs(page)).filter(item => item.kind === 'artifact')).toHaveLength(1);
  await page.locator('.tab[data-kind="page"][data-tab-key="artifacts"] .tab-open').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/artifacts?project=alpha');
  expect(await page.getByTestId('artifact-index-project').inputValue()).toBe('alpha');
}, 90_000);
