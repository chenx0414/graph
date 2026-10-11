import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { appendNodeEntry } from '../../src/core/node-run.ts';
import { appendMessage } from '../../src/core/conversation.ts';
import { TaskStore } from '../../src/core/store.ts';
import { openGraphServer } from '../../src/server/host.ts';
import { startGraphDaemon } from '../../src/server/start.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { graphDocumentationPaths } from '../../src/runtime/agent-docs.ts';
import { DEFAULT_MAIN_FULL_ACCESS_IDENTITY, openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import type { NativeProposal } from '../../src/core/types.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

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

function workerCheckProposal(summary: string, check = 'check', criterion = 'ok'): NativeProposal {
  return { requirementVersion: 1, summary, acceptance: [{ id: criterion, description: '检查通过', checkNode: check }],
    definition: parseGraphDefinition({ schemaVersion: 2, name: summary, protocols: { data: { type: 'object' } },
      nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Implement the requested work', inputs: { job: { protocol: 'data' } },
        outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } },
      modules: { [check]: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.js'], output: 'result' } } },
      edges: { checkWork: { from: 'work.result', to: `${check}.job`, enabled: true } },
      acceptance: [{ id: criterion, description: '检查通过', kind: 'check', module: check }] }),
  };
}

test('a draft window refreshes in place and the only archived card remains manageable', async () => {
  const root = await temp('draft-card-lifecycle');
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'alpha', root }], webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'draft-card-coder');
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '整理当前方案', requestId: 'create' });
  const anchor = (await server.runtime.conversations.view(created.conversationId)).anchorTaskId;
  await server.runtime.supervisor(anchor).propose(workerCheckProposal('原方案'), 'draft');
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('drawer-entry-graph').click();
  await page.locator('.node-card[data-node-id="check"]').waitFor();

  // This tab still names v1: the changed module proves the diagram, not just
  // the conversation summary, refreshes when that version is edited in place.
  await server.runtime.supervisor(anchor).propose(workerCheckProposal('修订方案', 'review', 'reviewed'), 'edit');
  await page.locator('.node-card[data-node-id="review"]').waitFor();
  expect(await page.locator('.node-card[data-node-id="check"]').count()).toBe(0);
  expect((await server.runtime.conversations.view(created.conversationId)).proposalHistory.map(item => item.version)).toEqual([1]);
  await page.getByTestId('window-archive-draft').click();
  await page.getByTestId('window-restore-draft').waitFor();
  await page.getByTestId('window-restore-draft').click();
  await page.getByTestId('window-archive-draft').waitFor();
  await page.getByTestId('window-archive-draft').click();
  await page.getByTestId('window-restore-draft').waitFor();

  // Reopening the conversation drawer after its sole card was archived must
  // still offer the archive; no active proposal exists to carry that entry.
  await page.locator('.tab[data-kind="conversation"]').first().click();
  if (await page.getByTestId('detail-drawer').isVisible().catch(() => false)) {
    await page.getByTestId('drawer-entry').click();
    await page.getByTestId('detail-drawer').waitFor({ state: 'hidden' });
  }
  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('archived-draft-1').waitFor();
  await page.getByTestId('restore-draft-1').click();
  await expect.poll(() => page.getByTestId('drawer-draft-summary').innerText()).toBe('修订方案');
  expect(await page.locator('.drawer-draft-title').innerText()).toBe('草稿 v1');
  await page.getByTestId('delete-draft').click();
  await expect.poll(async () => {
    const view = await server.runtime.conversations.view(created.conversationId);
    return { current: view.proposal, active: view.proposalHistory, archived: view.archivedProposals };
  }).toEqual({ current: null, active: [], archived: [] });
  await page.getByTestId('proposal-draft').waitFor({ state: 'hidden' });
  const status = await page.evaluate(async id => (await fetch(`/api/conversations/${id}/proposals/1`)).status, created.conversationId);
  expect(status).toBe(400);
}, 60_000);

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
  await expect.poll(() => add.evaluate(element => getComputedStyle(element).opacity)).toBe('0');
  await sidebar.getByRole('button', { name: '最近', exact: true }).hover();
  await expect.poll(() => add.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
  // The rail is icons only, so each entry states its own name for assistive use.
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

// The drawer opens on the task graph, so this test renders React Flow inside the drawer:
// that is slower than the old cheap first page and gets its own budget.
test('the right drawer keeps proposal details and node inspection independent from the chat', async () => {
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
  await server.runtime.supervisor(view.anchorTaskId).propose(workerCheckProposal('先做一个最小版本', 'check', 'works'), 'draft-1');
  await server.runtime.supervisor(view.anchorTaskId).propose(workerCheckProposal('第二版增加审查', 'review', 'reviewed'), 'draft-2', { newVersion: true });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('drawer-entry').waitFor();
  // The collapsed drawer advertises its state in the header; the draft card is
  // not part of the chat stream any more.
  await expect.poll(() => page.getByTestId('drawer-entry').getAttribute('aria-label')).toContain('草稿 v2');
  expect(await page.getByTestId('drawer-entry').getAttribute('aria-label')).toContain('待确认');
  expect(await page.locator('.conversation-thread-inner [data-testid="proposal-draft"]').count()).toBe(0);
  // The header carries the drawer entry and the detail toggle; the pause control
  // lives in the composer now.
  const headerDrawerBox = await page.getByTestId('drawer-entry').boundingBox();
  expect(await page.getByTestId('workspace-drawer-toggle').count()).toBe(0);
  expect(headerDrawerBox).not.toBeNull();
  expect(await page.getByTestId('drawer-entry').getAttribute('data-open')).toBe('false');
  // The chat column is the conversation itself; the window is named in the tab bar.
  expect(await page.locator('.tab[data-kind="conversation"]').first().getAttribute('data-active')).toBe('true');
  const beforeMain = await page.locator('.conversation-main').boundingBox();
  const beforeComposer = await page.locator('.conversation-composer-wrap').boundingBox();
  expect(beforeMain).not.toBeNull();
  expect(beforeComposer).not.toBeNull();

  // One click on the labelled header entry opens the drawer on the draft page,
  // where the summary, the confirm controls and the graph/acceptance entries
  // now live.
  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('detail-drawer').waitFor();
  expect(await page.getByTestId('drawer-entry').getAttribute('data-open')).toBe('true');
  await page.getByTestId('proposal-draft').waitFor();
  expect(await page.getByTestId('proposal-draft').innerText()).toContain('第二版增加审查');
  // The drawer is a launcher: it names the two windows a draft has and nothing more.
  expect(await page.getByTestId('drawer-entry-graph').isVisible()).toBe(true);
  expect(await page.getByTestId('drawer-entry-artifacts').isVisible()).toBe(true);
  expect(await page.getByTestId('accept-branch').isVisible()).toBe(true);
  expect(await page.getByTestId('confirm-draft').isVisible()).toBe(true);
  // The draft card lays its own content out inside its box: an unconfirmed draft
  // used to squeeze the card to its flex basis, so the version list and the two
  // window links spilled out over the task navigation (measured: card 78..164,
  // version list at 298, links at 349, task section from 176). The card keeps its
  // own parts inside it, and the version list is now its own section: it must sit
  // below the card and above the task navigation instead of overlapping either.
  await expect.poll(async () => {
    const card = await page.getByTestId('proposal-draft').boundingBox();
    const toc = await page.getByTestId('drawer-draft-toc').boundingBox();
    const links = await page.locator('[data-testid=proposal-draft] [data-testid=drawer-entry-links]').boundingBox();
    const tasks = await page.getByTestId('conversation-tasks').boundingBox();
    if (!card || !toc || !links || !tasks) return null;
    return {
      linksInside: links.y + links.height <= card.y + card.height + 1,
      tocBelowCard: toc.y >= card.y + card.height - 1,
      tasksBelowToc: tasks.y >= toc.y + toc.height - 1,
    };
  }).toEqual({ linksInside: true, tocBelowCard: true, tasksBelowToc: true });
  await page.waitForTimeout(260);
  await expect.poll(async () => (await page.locator('.conversation-main').boundingBox())!.width)
    .toBe(beforeMain!.width);
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
    return Boolean(main && drawer && drawer.y >= 40 && drawer.y + drawer.height === 720 && main.width === beforeMain!.width);
  }).toBe(true);
  const settledMain = await page.locator('.conversation-main').boundingBox();
  const settledComposer = await page.locator('.conversation-composer-wrap').boundingBox();
  const settledDrawer = await page.getByTestId('detail-drawer').boundingBox();
  expect(settledMain).not.toBeNull();
  expect(settledComposer).not.toBeNull();
  expect(settledDrawer).not.toBeNull();
  expect(settledComposer!.width).toBe(afterComposer!.width);
  expect(afterComposer!.y + afterComposer!.height).toBeLessThanOrEqual(720);
  expect(await page.locator('[data-testid="detail-toggle-close"]').count()).toBe(0);
  // The drawer hosts no graph and no artifact list of its own any more.
  expect(await page.locator('.detail-drawer [data-testid="conversation-graph"]').count()).toBe(0);
  expect(await page.locator('.detail-drawer [data-testid="drawer-artifacts"]').count()).toBe(0);

  // The version table of contents stayed in the drawer; a window names its own version.
  await page.getByTestId('drawer-draft-version-1').click();
  await expect.poll(() => page.getByTestId('drawer-draft-version-1').getAttribute('data-active')).toBe('true');

  // The pages that moved out of the drawer are gone, not merely hidden.
  for (const gone of ['draft-tab-acceptance', 'draft-tab-nodes', 'draft-tab-decisions', 'draft-page-graph', 'draft-page-artifacts', 'task-page-tabs']) {
    expect(await page.getByTestId(gone).count()).toBe(0);
  }

  // The task graph is a window of its own now: the drawer entry opens it as a tab, full width.
  await page.getByTestId('drawer-entry-graph').click();
  await expect.poll(() => new URL(page.url()).hash).toContain('/graph');
  await page.getByTestId('draft-graph-tab').waitFor();
  expect(await page.locator('.tab[data-kind="draft"][data-active="true"] .tab-title').innerText()).toContain('任务图');
  expect(await page.getByTestId('conversation-graph-title').innerText()).toContain('先做一个最小版本');
  await page.getByTestId('conversation-graph').waitFor();
  await page.getByTestId('draft-graph-detail').waitFor();
  expect(await page.getByTestId('graph-state-summary').innerText()).toContain('任务状态');
  const legend = await page.getByTestId('legend').innerText();
  for (const label of ['待执行', '运行中', '已完成', '被阻塞']) expect(legend).toContain(label);
  expect(await page.locator('[data-testid="legend"] [data-board-state]').count()).toBe(4);

  // Another window on the same draft names the version it was opened for.
  await page.goto(`${server.url}/#/conversations/${created.conversationId}/graph?v=2`);
  await page.getByTestId('draft-graph-tab').waitFor();
  await expect.poll(() => page.getByTestId('conversation-graph-title').innerText()).toContain('第二版增加审查');
  await page.locator('.node-card[data-node-id="review"]').waitFor();
  expect(await page.locator('.node-card[data-node-id="review"]').innerText()).toContain('review');
  expect(await page.locator('.node-card[data-node-id="review"]').getAttribute('data-node-type')).toBe('tool');
  // An unconfirmed operation module has the same pending presentation as the draft agent.
  expect(await page.locator('.node-card[data-node-id="review"]').getAttribute('data-status')).toBe('draft');
  expect(await page.locator('.node-card[data-node-id="review"]').getAttribute('data-tone')).toBe('pending');
  expect(await page.locator('.node-card[data-node-id="review"]').getAttribute('data-board-state')).toBe('pending');
  // The window fills the workspace the chat column filled before.
  const graphBox = await page.locator('.conversation-graph-main').boundingBox();
  expect(graphBox).not.toBeNull();
  expect(graphBox!.width).toBeGreaterThan(300);

  await page.locator('.react-flow__node').filter({ hasText: 'work' }).first().click();
  const nodeDetail = page.getByTestId('conversation-node-detail');
  await nodeDetail.waitFor();
  expect(await nodeDetail.innerText()).toContain('work');
  expect(await nodeDetail.innerText()).toContain('coder@1');
  expect(await nodeDetail.innerText()).toContain('独立会话');
  expect(await nodeDetail.innerText()).not.toContain('Fresh');
  expect(await nodeDetail.locator('dt').allTextContents()).not.toContain('依赖');
  expect(await nodeDetail.innerText()).toContain('工作经历');
  expect(await nodeDetail.innerText()).toContain('灌输的指令');
  const interfaces = await nodeDetail.innerText();
  expect(interfaces).toContain('传入接口');
  expect(interfaces).toContain('传出接口');
  expect(interfaces).toContain('\"job\"');
  expect(interfaces).toContain('\"result\"');
  expect(interfaces).toContain('\"protocol\": \"data\"');

  // The chat tab stayed mounted and interactive while the graph window was in front.
  await page.locator('.tab[data-kind="conversation"]').first().click();
  await page.locator('.conversation-composer-wrap').waitFor();
  expect(await page.locator('.tab[data-kind="conversation"][data-active="true"]').count()).toBe(1);
  await page.getByTestId('chat-input').fill('草稿详情已移入右侧抽屉。');
  expect(await page.getByTestId('chat-input').evaluate((element: HTMLInputElement) => element.value)).toBe('草稿详情已移入右侧抽屉。');

  // The shared-artifact index is its own window too, and the drawer only links to it.
  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('detail-drawer').waitFor();
  await page.getByTestId('drawer-entry-artifacts').click();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/artifacts?project=alpha');
  await page.getByTestId('artifact-index').waitFor();
  expect(await page.locator('.tab[data-kind="page"][data-active="true"] .tab-title').innerText()).toContain('共享产物');
  expect(await page.getByTestId('drawer-artifacts-project').innerText()).toContain('不属于任何任务');
  expect(await page.getByTestId('drawer-artifacts-own').innerText()).toContain('还没有任务图发布过产物');
  }, 60_000);

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
  await server.runtime.supervisor(view.anchorTaskId).propose(workerCheckProposal('节点聊天'), 'agent-node-chat-proposal');
  await server.runtime.projects.prepare({ projectId: 'alpha', requestId: 'agent-node-chat-prepare', initialize: true, createBaseline: true });
  const confirmed = await server.runtime.conversations.confirm(created.conversationId, {
    proposalVersion: 1, draftRevision: 1,
    targetBranch: 'main',
    requestId: 'agent-node-chat-confirm',
  });
  const projection = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(async () => projection.close());
  for (let i = 0; i < 210; i++) appendNodeEntry(projection, {
    taskId: confirmed.taskId, nodeId: 'work', role: 'user', kind: 'chat', text: `更早节点消息 ${i}`,
  });
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
  // The node is a window of its own: clicking it in the task graph opens its tab.
  await page.goto(`${server.url}/#/tasks/${confirmed.taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  await page.locator('.react-flow__node').filter({ hasText: 'work' }).first().click();
  await expect.poll(() => new URL(page.url()).hash).toContain('/nodes/work');
  expect(await page.locator('.tab[data-kind="node"][data-active="true"] .tab-title').innerText()).toContain('work');
  await page.getByTestId('node-overview').waitFor();
  await page.getByTestId('node-prompt').waitFor();
  const chat = page.getByTestId('graph-agent-chat');
  await chat.waitFor();
  expect(await chat.getAttribute('data-page')).toBe('true');
  // The tab bar names the node; the transcript uses the full height below it.
  expect(await chat.getAttribute('class')).toContain('conversation-thread-shell');
  expect(await page.locator('[data-testid="node-chat-tab"] > .conversation-header').count()).toBe(0);
  expect(await page.getByTestId('node-prompt').locator('summary').getAttribute('aria-label')).toBe('System prompt');
  expect(await page.locator('[data-testid="node-chat-tab"] .conversation-body .conversation-main .conversation-thread').count()).toBe(1);
  expect(await page.locator('.tab[data-kind="node"] .tab-title').first().innerText()).toContain('work');
  await expect.poll(() => chat.innerText()).toContain('任务说明');
  expect(await chat.innerText()).toContain('实现 README 功能');
  await chat.getByRole('button', { name: '展开这一轮的思考与工具调用' }).click();
  expect(await chat.innerText()).toContain('读取 1 项');
  expect(await chat.innerText()).toContain('coder · 回复');
  expect(await chat.innerText()).toContain('实现完成。');
  expect(await page.getByTestId('node-chat-input').isVisible()).toBe(true);
  await chat.getByRole('button', { name: '展开工具活动' }).click();
  expect(await chat.innerText()).toContain('README.md');
  const messages = page.getByTestId('node-message-list');
  expect(await chat.getByText('更早节点消息 0', { exact: true }).count()).toBe(0);
  await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await messages.evaluate(element => {
    element.addEventListener('wheel', () => element.setAttribute('data-wheeled', 'yes'));
  });
  await messages.hover();
  await page.mouse.wheel(0, -100000);
  try { await chat.getByText('更早节点消息 0', { exact: true }).waitFor({ timeout: 5000 }); }
  catch (error) {
    console.log('NODE SCROLL', await messages.evaluate(element => {
      const b = element.getBoundingClientRect();
      return { top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight, wheel: element.getAttribute('data-wheeled'),
        target: document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.outerHTML.slice(0, 500),
        older: element.querySelector('[data-testid="node-load-older"]')?.textContent };
    }));
    await page.screenshot({ path: '/tmp/node-scroll-failure.png' });
    throw error;
  }
  // A window closes from the tab bar, not from inside the transcript.
  expect(await chat.getByRole('button', { name: '关闭节点对话' }).count()).toBe(0);
  // The operation ledger lives nowhere in this window any more.
  expect(await page.getByTestId('node-operations').count()).toBe(0);
  await page.locator('.tab[data-kind="graph"] .tab-open').first().click();
  await expect.poll(() => page.getByTestId('node-prompt').isVisible()).toBe(false);
  await page.locator('.tab[data-kind="node"] .tab-open').first().click();
  await expect.poll(() => page.getByTestId('node-prompt').isVisible()).toBe(true);

}, 60_000);

test('the task graph page keeps the permanent four-state legend', async () => {
  const root = await temp('task-graph-legend');
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
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'task-graph-legend-definition');
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '图例任务', requestId: 'task-graph-legend-create' });
  const view = await server.runtime.conversations.view(created.conversationId);
  await server.runtime.supervisor(view.anchorTaskId).propose(workerCheckProposal('四态图例'), 'task-graph-legend-proposal');
  await server.runtime.projects.prepare({ projectId: 'alpha', requestId: 'task-graph-legend-prepare', initialize: true, createBaseline: true });
  const confirmed = await server.runtime.conversations.confirm(created.conversationId, {
    proposalVersion: 1, draftRevision: 1,
    targetBranch: 'main',
    requestId: 'task-graph-legend-confirm',
  });

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

  // The composer primary control is the single pause entry point, so the header
  // no longer repeats it. Reach the paused state through the same endpoint the
  // composer calls, then resume through the composer button itself.
  expect(await page.getByTestId('conversation-pause').count()).toBe(0);
  expect(await page.getByTestId('conversation-resume').count()).toBe(0);
  await server.runtime.conversations.pause(created.conversationId, 'pause-feedback-pause');
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
        interrupt: async (_operation, text) => { steered.push(text ?? ''); },
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
  // The candidate prompt is off by default (设置 → 通用/偏好). This test covers
  // the composer behaviour while it is enabled.
  await page.addInitScript(() => window.localStorage.setItem('graph-pref-candidate-prompt', 'true'));
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const input = page.getByTestId('chat-input');
  await input.waitFor();
  await expect.poll(async () => (await server.runtime.conversations.view(created.conversationId)).master?.status, { timeout: 10_000 }).toBe('running');

  // State 2: a nonempty prompt sent during output is queued.
  await input.fill('优先检查失败分支。');
  await input.press('Enter');
  await page.getByTestId('queued-message').filter({ hasText: '优先检查失败分支。' }).waitFor();
  // The chip is optimistic: the runtime may not have accepted the queue yet, and the second Enter
  // would then steer a queue that does not exist. Assert the real precondition instead of pressing
  // Enter into the dark (a bigger poll budget cannot fix a missing precondition).
  await expect.poll(async () => {
    const messages = (await server.runtime.conversations.view(created.conversationId)).messages;
    return messages.find(message => message.text === '优先检查失败分支。')?.state;
  }, { timeout: 10_000 }).toBe('queued');

  // State 3: an empty composer with a queued message sends that queue as steering.
  // Assert the two conditions the Enter handler itself branches on - the app knows the
  // master is busy (while it outputs the primary control is pause, by design) and the
  // queued chip above proves it knows the queue - instead of pressing Enter into the dark.
  await expect.poll(() => input.evaluate((element: HTMLInputElement) => element.value)).toBe('');
  await expect.poll(() => page.getByTestId('chat-send').getAttribute('data-mode'), { timeout: 30_000 }).toBe('pause');
  await input.press('Enter');
  // Under the full parallel gate a request that travels UI → HTTP → runtime can take far
  // longer than the default one-second poll. The budget is deliberately generous: the
  // preconditions above, not the budget, are what makes this assertion meaningful. It is
  // also the only assertion here whose latency grows with the number of capabilities the
  // master bundle resolves — and it is the one that timed out in production: a full gate on a
  // loaded machine reported `expected +0 to be 1` after 60s while 174 other files ran beside it,
  // so a budget in seconds was answering a question about load, not about the app.
  await expect.poll(() => steered.length, { timeout: 150_000 }).toBe(1);
  expect(steered[0]).toContain('优先检查失败分支。');
  await expect.poll(async () => {
    const messages = (await server.runtime.conversations.view(created.conversationId)).messages;
    return messages.find(message => message.text === '优先检查失败分支。')?.state;
  }, { timeout: 10_000 }).toBe('delivered');

  release();
  await expect.poll(async () => (await server.runtime.conversations.view(created.conversationId)).master?.status, { timeout: 10_000 }).toBe('succeeded');
  await expect.poll(() => input.getAttribute('data-suggestion'), { timeout: 10_000 }).toBe('继续检查测试覆盖和失败分支。');

  // Tab fills the grey suggestion.
  await input.press('Tab');
  expect(await input.evaluate((element: HTMLInputElement) => element.value)).toBe('继续检查测试覆盖和失败分支。');

  // State 1: with the composer empty again, Enter sends the suggestion directly.
  await input.fill('');
  await input.press('Enter');
  await expect.poll(async () => {
    const messages = (await server.runtime.conversations.view(created.conversationId)).messages;
    return messages.some(message => message.role === 'user' && message.text === '继续检查测试覆盖和失败分支。');
  }, { timeout: 10_000 }).toBe(true);
  // This test drives a real turn through a browser, so it owns several sequential waits whose
  // budgets add up (10s + 10s + 1s + 30s + 150s + 10s + 10s + 10s). The outer budget must exceed
  // that sum: at 60s the test itself died first and reported only "Test timed out in 60000ms",
  // naming no condition. With room to spare, a real stall now fails inside the poll that was
  // still waiting and says which state never arrived.
}, 420_000);

test('Escape closes the model menu before it interrupts the running Agent', async () => {
  const root = await temp('escape-interrupt');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const interrupted: string[] = [];
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    actions: {
      master: {
        kind: 'agent',
        reserveTokens: 100,
        prepare: async () => async () => {
          await gate;
          return {
            outcome: 'completed',
            output: { text: '已打断。' },
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          };
        },
        interrupt: async (_operation, text) => {
          interrupted.push(text ?? '');
          release();
        },
      },
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
    autoDrive: true,
    webDir,
    startup: { mode: 'execute', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ text: '开始一个可打断的回合。', requestId: 'escape-interrupt' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await expect.poll(async () => (await server.runtime.conversations.view(created.conversationId)).master?.status, { timeout: 10_000 }).toBe('running');

  await page.getByTestId('model-control').click();
  await page.getByTestId('model-menu').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('model-menu').waitFor({ state: 'detached' });
  expect(interrupted).toEqual([]);

  await page.keyboard.press('Escape');
  await expect.poll(() => interrupted.length, { timeout: 10_000 }).toBe(1);
  expect(interrupted[0]).toBe('');
  await expect.poll(async () => (await server.runtime.conversations.view(created.conversationId)).master?.status, { timeout: 10_000 }).toBe('succeeded');
}, 60_000);

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
  expect(await page.getByTestId('agent-combination-code').innerText()).toContain('组合架构身份与研究 Skill。');
  expect(await page.getByTestId('agent-combination-code').innerText()).toContain('Agent 配方 · medium · 编码');
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
  await expect.poll(() => server.runtime.catalog.agentCombinations().find(item => item.id === 'worker')?.description)
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

test('the composer slash menu selects tools, switches model and queues compaction', async () => {
  const root = await temp('composer-slash');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 2, enabledModelCount: 2 },
  });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '先讨论', requestId: 'composer-slash' });

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
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 0, enabledModelCount: 0 },
  });
  cleanup.push(() => server.close());

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
    access: () => fullAccessPolicy(),
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
  await page.getByTestId('agent-context-open').waitFor();
  expect(await page.getByTestId('agent-context-bar').count()).toBe(0);

  await page.getByTestId('agent-context-open').click();
  await page.getByTestId('agent-context-drawer').waitFor();
  // 面板只展示真正发出去的那一份；没发过请求的会话没有可展示的 prompt。
  await page.getByTestId('agent-context-sent').waitFor();
  const sentPanel = await page.getByTestId('agent-context-sent').innerText();
  expect(sentPanel).toContain('实际发出');
  expect(sentPanel).toContain('本次会话尚未记录到已发出的请求');
  await expect.poll(() => page.getByTestId('agent-context-sent').innerText()).toContain(`源码 Docs ${graphDocumentationPaths().root}`);
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
  await expect.poll(() => agentContext.override('runtime/worker.md')).toContain('CUSTOM CONVERSATION');
  await page.getByRole('button', { name: '恢复默认' }).click();
  await page.getByTestId('toasts').getByText(/已恢复 Worker 运行规则/).waitFor();
  await expect.poll(() => agentContext.override('runtime/worker.md')).not.toContain('CUSTOM CONVERSATION');
  await page.getByTestId('agent-prompt-editor').fill('');
  await expect.poll(() => page.getByTestId('agent-prompt-editor').evaluate((element: HTMLInputElement) => element.value)).toBe('');
  await page.getByRole('button', { name: '设为默认' }).click();
  await page.getByTestId('toasts').getByText(/已将 Worker 运行规则 设为默认/).waitFor();
  await expect.poll(() => agentContext.prompt('runtime/worker.md')).toBe('');
  expect(await readFile(join(root, 'graph', 'prompts', 'defaults', 'runtime', 'worker.md'), 'utf8')).toBe('\n');
  await page.getByTestId('agent-prompt-editor').fill('Temporary after default');
  await expect.poll(() => page.getByTestId('agent-prompt-editor').evaluate((element: HTMLInputElement) => element.value)).toBe('Temporary after default');
  await page.getByRole('button', { name: '保存 Prompt' }).click();
  await page.getByTestId('toasts').getByText(/已保存 Worker 运行规则/).waitFor();
  await expect.poll(() => agentContext.override('runtime/worker.md')).toContain('Temporary after default');
  await page.getByRole('button', { name: '恢复默认' }).click();
  await page.getByTestId('toasts').getByText(/已恢复 Worker 运行规则/).last().waitFor();
  await expect.poll(() => agentContext.prompt('runtime/worker.md')).toBe('');
  await page.getByRole('button', { name: '恢复内置' }).click();
  await page.getByTestId('toasts').getByText(/已恢复 Worker 运行规则 的内置默认/).waitFor();
  await expect.poll(() => agentContext.prompt('runtime/worker.md')).toContain('Use the native Pi tools');

  await page.getByTestId('agent-context-tab-tools').click();
  await page.getByTestId('agent-tool-write').uncheck();
  await page.getByRole('button', { name: '保存工具选择' }).click();
  await expect.poll(() => agentContext.disabledTools()).toContain('write');
}, 60_000);

test('a self-improvement report renders as its own card in the conversation', async () => {
  const root = await temp('rsi-report');
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '改进 harness', requestId: 'rsi-report' });
  const projection = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(async () => projection.close());
  const report = appendMessage(projection, {
    conversationId: created.conversationId,
    role: 'system',
    kind: 'rsi',
    text: '### RSI 已应用：修复超时',
    data: {
      id: 'rsi-1',
      status: 'applied',
      title: '修复超时',
      problem: '命令在含空格路径下失败',
      branch: 'rsi/fix-timeout',
      commit: 'a'.repeat(40),
      files: ['src/runtime/rsi.ts'],
      validation: [{ command: 'node --run check', status: 'passed', output: '' }],
      restartRequired: true,
      diff: 'diff --git a/x b/x',
      report: '### RSI 已应用：修复超时',
    },
  });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const card = page.getByTestId('rsi-report');
  await card.waitFor();
  expect(await card.getAttribute('data-status')).toBe('applied');
  expect(await card.getByRole('button', { name: '查看改动' }).count()).toBe(0);
  await card.getByRole('button', { name: '展开', exact: true }).click();
  const text = await card.innerText();
  expect(text).toContain('修复超时');
  expect(text).toContain('等待重载');
  expect(text).toContain('src/runtime/rsi.ts');
  expect(text).toContain('node --run check');
  expect(text).toContain('等待正在执行的任务结束后重载');
  await page.getByRole('button', { name: '查看改动' }).click();
  await expect.poll(() => card.innerText()).toContain('diff --git');
  appendMessage(projection, {
    conversationId: created.conversationId, messageId: report.id, role: 'system', kind: 'rsi',
    text: '重载已确认', data: { ...report.data as Record<string, import('../../src/core/types.ts').Json>, activation: { state: 'active', confirmedAt: Date.now() } },
  });
  await page.reload();
  await expect.poll(() => card.innerText()).toContain('已生效');
  expect(await card.locator('.rsi-report-problem').count()).toBe(0);
  await card.getByRole('button', { name: '展开', exact: true }).click();
  await expect.poll(() => card.innerText()).toContain('宿主已确认重载，改动已生效');
  expect(await card.innerText()).not.toContain('等待重载');
}, 60_000);

test('the sent tab shows the tool declarations one request carried, with their count and size', async () => {
  const root = await temp('agent-context-tools-ui');
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
  const created = await server.runtime.conversations.create({ text: '看声明', requestId: 'sent-tools-ui' });

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
      docsRoot: graphDocumentationPaths().root,
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
  const server = await openGraphServer({ stateDir: join(root, 'state'), projects: [{ id: 'alpha', root }], webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 } });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '图片测试', requestId: 'draft-image' });
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
  const server = await openGraphServer({stateDir:join(root,'state'),webDir,autoDrive:false});
  cleanup.push(()=>server.close());
  const created=await server.runtime.conversations.create({text:'Live editor',requestId:'live'});
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
  expect((await server.runtime.conversations.view(created.conversationId)).messages.filter(m=>m.role==='user').length).toBe(1);
  await page.screenshot({path:'/tmp/graph-live-editor.png'});
  await page.goto(`${server.url}/#/catalog/architectures`);
  await page.getByTestId('architecture-canvas').waitFor();
  await page.getByRole('button',{name:/主管与工人/}).click();
  await expect.poll(()=>page.locator('.architecture-canvas .react-flow__node').count()).toBe(3);
  await page.locator('.architecture-canvas .react-flow__node').filter({hasText:'工人 A'}).click();
  await expect.poll(()=>page.locator('.architecture-stage footer').innerText()).toContain('工作副本');
  await page.screenshot({path:'/tmp/graph-architecture-board.png'});
});
