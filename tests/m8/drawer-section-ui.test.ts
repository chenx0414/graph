/**
 * The drawer's two windows - the draft page and the task navigation - belong to the user, and
 * neither may be yanked away by the other: the "no tasks yet" note lives in the task section, so
 * falling back to the draft page would make it unreachable. The policy only matters if the user
 * can see which window they are in, so this drives the real console in a real browser.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';
import type { NativeProposal } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;

beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-drawer-section-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);

afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-drawer-section-${name}-`));
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

function workerCheckProposal(summary: string, requirementVersion = 1): NativeProposal {
  return { requirementVersion, summary, acceptance: [{ id: 'ok', description: '检查通过', checkNode: 'check' }],
    definition: { schemaVersion: 2, name: summary, protocols: { data: { type: 'object' } },
      nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Implement the requested work', inputs: { job: { protocol: 'data' } },
        outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } },
      modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.js'], output: 'result' } } },
      edges: { checkWork: { from: 'work.result', to: 'check.job', enabled: true } },
      inputs: {}, outputs: {},
      acceptance: [{ id: 'ok', description: '检查通过', kind: 'check', module: 'check' }] },
  };
}

/** A console with one project, one conversation and a real browser on it. */
async function consoleWith(name: string) {
  const root = await temp(name);
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await gitProject(project);
  const plans: ResponsePlan[] = [{ text: 'Ready.' }];
  const provider = await openaiServer(plans);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'alpha', root: project }],
    credentials: { local: { secretRef: 'GRAPH_DRAWER_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
  const server = await launchCli(root, { configPath, webDir, env: { GRAPH_DRAWER_KEY: 'drawer-fixture' }, extraArgs: ['--execute'] });
  cleanup.push(() => server.close());
  async function post(path: string, data: unknown) {
    const response = await server.request(path, { method: 'POST', body: JSON.stringify(data) });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }
  await post('/api/catalog/combinations', { combination: { id: 'coder', name: 'Coder', description: 'Implement work', systemPrompt: 'Implement the assigned work and submit its required output.', recommendedGrade: 'high', review: false, tags: [], resources: [] } });
  const created: { conversationId: string } = await post('/api/conversations', { projectId: 'alpha', model: 'local', text: '先看看抽屉', requestId: 'create' });
  async function view() {
    const response = await server.request(`/api/conversations/${created.conversationId}`);
    return response.json() as Promise<{ anchorTaskId: string; requirementVersion: number; proposal: { version: number; draftRevision: number }; tasks: { id: string }[]; master?: { status: string } }>;
  }
  async function propose(proposal: NativeProposal, requestId: string) {
    await expect.poll(async () => (await view()).master?.status, { timeout: 30000 }).toBe('succeeded');
    const current = await view();
    proposal.requirementVersion = current.requirementVersion;
    plans.push({ tools: [{ id: requestId, name: 'propose_graph', arguments: JSON.stringify({ proposal, requestId }) }] }, { text: 'Draft prepared.' });
    await post(`/api/conversations/${created.conversationId}/messages`, { text: proposal.summary, requestId });
    await expect.poll(async () => (await view()).proposal?.version, { timeout: 30000 }).toBeGreaterThan(current.proposal?.version ?? 0);
    await expect.poll(async () => (await view()).master?.status, { timeout: 30000 }).toBe('succeeded');
  }
  async function confirm() {
    const current = await view();
    return post(`/api/conversations/${created.conversationId}/confirm`, { proposalVersion: current.proposal.version, draftRevision: current.proposal.draftRevision, targetBranch: 'main', requestId: crypto.randomUUID() });
  }
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('drawer-entry').waitFor();
  return { server, page, conversationId: created.conversationId, view, propose, confirm };
}

/** Which of the two windows the drawer is showing right now. */
function section(page: { getByTestId: (id: string) => { getAttribute: (name: string) => Promise<string | null> } }) {
  return page.getByTestId('detail-drawer').getAttribute('data-section');
}

test('a conversation with no task and no draft opens on the task section, where the empty note lives', async () => {
  const { page } = await consoleWith('empty');

  // The drawer starts collapsed, and the chat stream is the conversation itself.
  expect(await page.getByTestId('drawer-entry').getAttribute('data-open')).toBe('false');
  expect(await page.locator('.conversation-thread-inner [data-testid="no-conversation-tasks"]').count()).toBe(0);
  // The collapsed drawer still says what waits inside: no draft, no task yet.
  expect(await page.getByTestId('drawer-entry').getAttribute('aria-label')).toContain('暂无草稿');
  expect(await page.getByTestId('drawer-entry').getAttribute('aria-label')).toContain('任务 0');

  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('detail-drawer').waitFor();
  // The chat column keeps the transcript, the questions and the composer; everything else
  // lives in the drawer, and there is no third home for a panel.
  expect(await page.locator('.conversation-body').getAttribute('data-resident-panels'))
    .toBe('conversation-messages conversation-questions conversation-composer');
  const drawerPanels = (await page.getByTestId('detail-drawer').getAttribute('data-drawer-panels'))!.split(' ');
  for (const panel of ['draft-versions', 'graph', 'artifacts', 'task-nav', 'task', 'task-empty', 'bind-project']) {
    expect(drawerPanels).toContain(panel);
  }
  // There is no draft to show, so the drawer opens on the task section - and it stays there.
  await expect.poll(() => section(page)).toBe('task');
  await page.getByTestId('no-conversation-tasks').waitFor();
  expect(await page.getByTestId('no-conversation-tasks').innerText()).toContain('尚无功能任务');
  // The section that has nothing yet offers no entry of its own: a task's graph is
  // reached by clicking the task, and its artifacts live at the bottom of that page.
  await page.getByTestId('no-task-graph').waitFor();
  expect(await page.getByTestId('drawer-task-artifacts').count(), 'the shared-artifacts entry is back').toBe(0);
  expect(await page.getByTestId('drawer-entry-artifacts').count(), 'the global artifacts entry is back').toBe(0);

  // The drawer body owns its own scrollbar, so the content never shifts the chat column.
  const scroll = await page.locator('.drawer-inner').evaluate(node => {
    const style = getComputedStyle(node);
    return { overflowY: style.overflowY, scrollbarGutter: style.scrollbarGutter };
  });
  expect(scroll).toEqual({ overflowY: 'auto', scrollbarGutter: 'stable' });
}, 90_000);

test('a live draft opens on the draft page, and it is not yanked away by the task navigation', async () => {
  const { page, propose } = await consoleWith('draft');
  await propose(workerCheckProposal('先做一个最小版本'), 'draft');

  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('detail-drawer').waitFor();
  await page.getByTestId('proposal-draft').waitFor();
  // The draft page is where the user's choice put it, and it stays there.
  await expect.poll(() => section(page)).toBe('draft');
  expect(await page.getByTestId('proposal-draft').innerText()).toContain('先做一个最小版本');
  // The task navigation is still beside it, not instead of it.
  expect(await page.getByTestId('conversation-tasks').count()).toBe(1);
  expect(await page.locator('.conversation-thread-inner [data-testid="proposal-draft"]').count()).toBe(0);
}, 90_000);

test('the chosen task sticks, and the task section is never yanked back to the draft page', async () => {
  const { page, server, conversationId, view, propose, confirm } = await consoleWith('tasks');
  await propose(workerCheckProposal('第一个功能'), 'draft-1');
  await confirm();
  await propose(workerCheckProposal('第二个功能', 2), 'draft-2');
  await confirm();

  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('detail-drawer').waitFor();
  // Both features are tasks now, and neither of them is a draft any more.
  await expect.poll(() => page.getByTestId('drawer-entry-label').innerText(), { timeout: 30_000 }).toContain('任务 2');
  await expect.poll(() => section(page)).toBe('task');

  const tasks = page.locator('[data-testid^="conversation-task-"]');
  await expect.poll(() => tasks.count()).toBe(2);

  // Nothing is selected yet, so the first task is adopted - the list itself is drawn newest
  // first, so the adopted one is not necessarily the one at the top.
  const listed = (await view()).tasks.map(task => task.id);
  await expect.poll(() => page.locator('[data-testid^="conversation-task-"][data-active="true"]').count()).toBe(1);
  expect(await page.getByTestId(`conversation-task-${listed[0]}`).getAttribute('data-active')).toBe('true');

  // Clicking a task opens its graph straight away: there is no separate entry to
  // click first, and no artifact index of its own.
  const other = page.locator('[data-testid^="conversation-task-"][data-active="false"]').first();
  const otherTaskId = (await other.getAttribute('data-testid'))!.replace('conversation-task-', '');
  const otherRequest = (await other.locator('span[title]').getAttribute('title'))!;
  await other.click();
  await expect.poll(() => new URL(page.url()).hash).toBe(`#/tasks/${otherTaskId}/graph`);
  await page.getByTestId('graph').waitFor();
  expect(await page.getByTestId('task-graph-title').innerText()).toBe(otherRequest);

  // Coming back, the drawer is still on the task section instead of falling back to
  // the draft page, and both tasks are still listed.
  await page.goto(`${server.url}/#/conversations/${conversationId}`);
  await page.getByTestId('drawer-entry').click();
  await expect.poll(() => section(page)).toBe('task');
  await expect.poll(() => page.locator('[data-testid^="conversation-task-"]').count()).toBe(2);
}, 90_000);

test('the right drawer shows the same project graphs in a conversation and on a task graph page', async () => {
  const { page, server, propose, confirm } = await consoleWith('drawer-parity');
  await propose(workerCheckProposal('第一个功能'), 'draft-1');
  await confirm();
  await propose(workerCheckProposal('第二个功能', 2), 'draft-2');
  await confirm();

  const ids = async (prefix: string) => page.locator(`[data-testid^="${prefix}"]`)
    .evaluateAll((nodes, marker) => nodes.map(node => node.getAttribute('data-testid')!.slice(marker.length)).sort(), prefix);

  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('detail-drawer').waitFor();
  await expect.poll(() => section(page)).toBe('task');
  await expect.poll(async () => (await ids('conversation-task-')).length).toBe(2);
  expect(await page.getByTestId('detail-drawer').innerText()).toContain('当前项目的图');
  // No sorting or filtering controls above the list: it shows the project's graphs, newest first.
  for (const control of ['task-sort', 'task-status-filter', 'task-project-filter']) {
    expect(await page.getByTestId(control).count(), `${control} came back`).toBe(0);
  }
  const inConversation = await ids('conversation-task-');

  // The same drawer, reached from a task graph page, lists the same graphs.
  await page.goto(`${server.url}/#/tasks/${inConversation[0]!}/graph`);
  await page.getByTestId('graph').waitFor();
  if (await page.getByTestId('drawer-workspace-tasks').count() === 0) await page.getByTestId('workspace-drawer-toggle').click();
  await page.getByTestId('drawer-workspace-tasks').waitFor();
  expect(await page.getByTestId('drawer-workspace-tasks').innerText()).toContain('当前项目的图');
  expect(await ids('drawer-workspace-task-')).toEqual(inConversation);
}, 120_000);

test('opening the drawer squeezes the conversation instead of covering it', async () => {
  const { page } = await consoleWith('empty');
  const boxes = () => page.evaluate(() => {
    const layer = document.querySelector('.window-drawer-layer')!.getBoundingClientRect();
    const main = document.querySelector('.conversation-main')!.getBoundingClientRect();
    return { layerLeft: Math.round(layer.left), mainRight: Math.round(main.right), layerWidth: Math.round(layer.width), mainWidth: Math.round(main.width) };
  });
  const closed = await boxes();
  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('detail-drawer').first().waitFor();
  // The panel takes its room from the conversation: it never sits on top of it.
  await expect.poll(async () => (await boxes()).layerWidth, { timeout: 10_000 }).toBeGreaterThan(300);
  const open = await boxes();
  expect(open.layerLeft, 'the panel overlaps the conversation').toBeGreaterThanOrEqual(open.mainRight - 1);
  expect(closed.mainWidth - open.mainWidth, 'the conversation did not give up the panel width').toBeCloseTo(open.layerWidth, -1);
}, 240_000);

test('the drawer opens inside the window by taking its width from the page', async () => {
  const { page } = await consoleWith('empty');
  await page.evaluate(() => {
    const host = window as unknown as { __drawerCalls: unknown[]; graph?: unknown };
    host.__drawerCalls = [];
    host.graph = {
      setDrawer: async (input: { open: boolean; width: number }) => {
        host.__drawerCalls.push(input);
        return { expanded: true };
      },
    };
  });
  const layer = page.locator('.window-drawer-layer');
  const corner = () => page.getByTestId('drawer-entry').evaluate(node => {
    const box = node.getBoundingClientRect();
    return { fromRight: Math.round(window.innerWidth - box.right), top: Math.round(box.top) };
  });
  const resting = await corner();

  await page.getByTestId('drawer-entry').click();
  await expect.poll(async () => await layer.getAttribute('data-open'), { timeout: 10_000 }).toBe('true');

  // Inward split pane: the panel grows on its own width and the page gives that room up.
  const motion = await layer.evaluate((node: HTMLElement) => {
    const style = getComputedStyle(node);
    return { property: style.transitionProperty.split(',').map(name => name.trim()), position: style.position };
  });
  expect(motion.position, 'the panel must be laid out inside the window, not floated over it').toBe('static');
  expect(motion.property, JSON.stringify(motion)).toContain('width');
  expect(await page.evaluate(() => (window as unknown as { __drawerCalls: unknown[] }).__drawerCalls),
    'the drawer must not resize the window').toEqual([]);

  // The toggle keeps its place in the window's top-right corner while the panel is out.
  expect(await corner(), 'the toggle moved when the drawer opened').toEqual(resting);

  await page.getByTestId('drawer-entry').click();
  await expect.poll(async () => await layer.getAttribute('data-open'), { timeout: 10_000 }).toBe('false');
  expect(await corner()).toEqual(resting);
}, 240_000);


test('the task graph page shows the graph itself, not the cost, revision and connection chips', async () => {
  const { page, server, view, propose, confirm } = await consoleWith('graph-header');
  await propose(workerCheckProposal('只有一个任务图'), 'draft');
  await confirm();
  await expect.poll(async () => (await view()).tasks.length, { timeout: 30_000 }).toBe(1);
  const taskId = (await view()).tasks[0]!.id;

  await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  expect(await page.getByTestId('task-graph-title').innerText()).toContain('只有一个任务图');
  for (const chip of ['cost', 'revisions', 'connection']) {
    expect(await page.getByTestId(chip).count(), `${chip} chip`).toBe(0);
  }

  // This graph's shared artifacts live at the bottom of this page, and the global
  // artifact index that used to hold them has no page of its own any more.
  const artifacts = page.getByTestId('task-artifacts');
  await artifacts.waitFor();
  expect(await artifacts.innerText()).toContain('共享产物');
  // The cards of the page that used to hold every project's artifacts live here now:
  // one grid of artifact cards for this graph, and no project-wide group.
  expect(await artifacts.getByTestId('artifact-cards').count()).toBe(1);
  expect(await artifacts.innerText()).toContain('还没有任务图发布过产物');
  expect(await artifacts.innerText()).not.toContain('项目共享');
  // Only this graph's own documents belong here: a fresh task has published none, so
  // the conversation's own artifacts must not stand in for them.
  expect(await artifacts.innerText()).not.toContain('979e670b');
  await page.goto(`${server.url}/#/artifacts`);
  expect(await page.getByTestId('artifact-index').count(), 'the global artifact index is back').toBe(0);
}, 120_000);
