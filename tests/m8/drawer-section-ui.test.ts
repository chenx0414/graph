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

test('opening the drawer slides it over the conversation instead of squeezing it', async () => {
  const { page } = await consoleWith('empty');
  const threadWidth = async () => (await page.locator('.conversation-main').boundingBox())!.width;
  const closed = await threadWidth();
  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('detail-drawer').waitFor();
  await expect.poll(async () => await threadWidth(), { timeout: 10_000 })
    .toBe(closed);
  const edges = () => page.locator('.window-drawer-layer').evaluate((element: HTMLElement) => {
    const layer = element.getBoundingClientRect();
    const host = element.parentElement!.getBoundingClientRect();
    return { offset: Math.round(layer.right - host.right), width: Math.round(layer.width) };
  });
  await expect.poll(async () => (await edges()).offset, { timeout: 10_000 })
    .toBe(0);
  expect((await edges()).width).toBeGreaterThan(300);
}, 240_000);

test('the drawer widens the desktop window instead of covering it, and overlays only when it cannot', async () => {
  const { page } = await consoleWith('empty');
  await page.evaluate(() => {
    const host = window as unknown as { __drawerCalls: unknown[]; __drawerExpanded: boolean; graph?: unknown };
    host.__drawerCalls = [];
    host.__drawerExpanded = true;
    host.graph = {
      setDrawer: async (input: { open: boolean; width: number }) => {
        host.__drawerCalls.push(input);
        return { expanded: host.__drawerExpanded };
      },
    };
  });
  const overlay = () => page.locator('.window-drawer-layer').getAttribute('data-overlay');
  await page.getByTestId('drawer-entry').click();
  await expect.poll(overlay, { timeout: 10_000 }).toBe('false');
  const calls = await page.evaluate(() => (window as unknown as { __drawerCalls: { open: boolean; width: number }[] }).__drawerCalls);
  expect(calls, 'the renderer must ask the desktop window to grow').toContainEqual({ open: true, width: 440 });

  // A section that needs more room (task graph, shared artifacts) resizes the panel
  // at once: no width animation may stretch or squeeze it while the window grows.
  const motion = await page.locator('.window-drawer-layer').evaluate(node => {
    const style = getComputedStyle(node);
    return { property: style.transitionProperty, duration: style.transitionDuration };
  });
  expect(motion.property.split(',').map(name => name.trim()), JSON.stringify(motion)).not.toContain('width');

  await page.getByTestId('drawer-entry').click();
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __drawerCalls: { open: boolean }[] }).__drawerCalls.some(call => !call.open)), { timeout: 10_000 }).toBe(true);

  await page.evaluate(() => { (window as unknown as { __drawerExpanded: boolean }).__drawerExpanded = false; });
  await page.getByTestId('drawer-entry').click();
  await expect.poll(overlay, { timeout: 10_000 }).toBe('true');
});

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
