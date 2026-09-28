import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { withIndependentReview } from '../fixtures/review-gate.ts';
import { git as runGit } from '../../src/git/git.ts';
import { nextEventCursor } from '../../src/web/event-cursor.ts';
import type { NodeSpec } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-m8-flow-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});
afterAll(() => rm(webDir, { recursive: true, force: true }));

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-ui-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function actions(root: string) {
  return {
    implement: { kind: 'agent' as const, reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed' as const, output: { done: true }, usage }) },
    check: {
      kind: 'program' as const,
      prepare: async () => async () => ({
        outcome: 'completed' as const, output: { passed: true },
        evidence: [{ acceptanceId: 'works', summary: '检查通过', artifact: { path: join(root, 'ok.txt'), digest: 'a'.repeat(64) } }],
      }),
    },
  };
}

async function launch() {
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  return browser;
}

test('cursor helpers ignore duplicates and out-of-order frames', () => {
  expect(nextEventCursor(0, { cursor: 3, type: 'task.created' })).toMatchObject({ cursor: 3, type: 'task.created', data: {} });
  // The full payload survives so the timeline can label the event.
  expect(nextEventCursor(0, { cursor: 5, type: 'x', data: { nodeId: 'work' }, timestamp: 123 })).toEqual({ cursor: 5, type: 'x', data: { nodeId: 'work' }, timestamp: 123 });
  expect(nextEventCursor(3, { cursor: 3, type: 'task.created' })).toBeNull();
  expect(nextEventCursor(3, { cursor: 2, type: 'task.created' })).toBeNull();
  expect(nextEventCursor(3, { cursor: 4.5, type: 'x' })).toBeNull();
  expect(nextEventCursor(3, { type: 'x' })).toBeNull();
  expect(nextEventCursor(3, null)).toBeNull();
});

test('the console completes the main flow, keeps projects separate, and restores a direct graph URL', async () => {
  const rootA = await temp('flow-a');
  const rootB = await temp('flow-b');
  // The target branch must exist before acceptance; create a real local repo
  // with the feature branch the UI will type.
  runGit(rootA, ['init', '-b', 'main']);
  await writeFile(join(rootA, 'README.md'), 'project a\n');
  runGit(rootA, ['add', 'README.md']);
  runGit(rootA, ['commit', '-m', 'init']);
  runGit(rootA, ['branch', 'feature-a']);
  const reviewedA = withIndependentReview(actions(rootA), [
    { id: 'implement', kind: 'agent', action: 'implement', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['implement'] },
  ]);
  const server = await openGraphServer({
    stateDir: join(rootA, 'state'),
    projects: [{ id: 'project-a', root: rootA }, { id: 'project-b', root: rootB }],
    actions: reviewedA.actions,
    autoDrive: true,
    webDir,
    startup: { mode: 'execute', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  const browser = await launch();
  const page = await browser.newPage();

  const taskA = (await server.runtime.user.begin({ projectId: 'project-a', request: '任务 A：实现搜索', requestId: 'begin-a' })).taskId;
  await server.runtime.supervisor(taskA).propose({
    requirementVersion: 1, summary: '任务 A 提案',
    acceptance: [{ id: 'works', description: '搜索可用', checkNode: 'check' }],
    nodes: reviewedA.nodes,
  }, 'proposal-a');
  await server.runtime.user.task(taskA).accept({ proposalVersion: 1, targetBranch: 'feature-a', requestId: 'accept-a' });
  // A task opens on its graph now; the node cards carry the state the task page used to print.
  await page.goto(`${server.url}/#/tasks/${taskA}/graph`);
  await page.getByTestId('graph').waitFor();
  await page.locator('.node-card[data-node-id="check"][data-status="succeeded"]').waitFor();
  await page.locator('.node-card[data-node-id="implement"][data-status="succeeded"]').waitFor();
  await page.locator('.react-flow__node').filter({ hasText: 'implement' }).first().click();
  // A node opens its own tab; the overview states what it is, and the graph keeps the state.
  await expect.poll(() => page.getByTestId('node-overview').innerText()).toContain('implement');
  await page.locator('.tab[data-kind="node"] .tab-close').first().click();
  await page.locator('.node-card[data-node-id="implement"][data-status="succeeded"]').waitFor();
  await page.getByTestId('legend').waitFor();

  // A second project and task must not mix data with the first.
  const taskB = (await server.runtime.user.begin({ projectId: 'project-b', request: '任务 B：修复导出', requestId: 'begin-b' })).taskId;
  expect(taskB).not.toBe(taskA);
  // Which task is in front is read from its window: the active task-graph tab is named
  // after the task, so one project's task cannot show up under another's name.
  const activeGraphTab = '.tab[data-kind="graph"][data-active="true"] .tab-title';
  await page.goto(`${server.url}/#/tasks/${taskA}/graph`);
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes('任务 A'), activeGraphTab);
  await page.goto(`${server.url}/#/tasks/${taskB}/graph`);
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes('任务 B'), activeGraphTab);
  expect(await page.locator(activeGraphTab).first().innerText()).not.toContain('任务 A');
  // A direct reload of the graph address restores the page.
  await page.goto(`${server.url}/#/tasks/${taskA}/graph`);
  await page.reload();
  await page.getByTestId('graph').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length >= 2);
}, 90_000);

test('parallel branches, subgraphs and rework back-edges render and errors are explicit', async () => {
  const root = await temp('complex');
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: actions(root),
    autoDrive: false, webDir,
    startup: { mode: 'execute', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  const { taskId } = await server.runtime.user.begin({ projectId: 'project', request: '复杂图', requestId: 'begin' });
  const nodes: NodeSpec[] = [
    { id: 'left', kind: 'agent', action: 'implement', definitionVersion: 'coder@1', model: 'scripted', container: 'grp' },
    { id: 'right', kind: 'agent', action: 'implement', definitionVersion: 'coder@1', model: 'scripted', container: 'grp' },
    { id: 'join', kind: 'program', action: 'check', dependsOn: ['left', 'right'] },
  ];
  await server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: '并行与回边',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'join' }],
    nodes,
    containers: [{ id: 'grp', outputs: ['left'] }],
    loops: [{ from: 'join', to: 'left' }],
  }, 'proposal');
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  const browser = await launch();
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length >= 4);
  expect(await page.locator('.react-flow__edge').evaluateAll(edges => edges.some(edge => (edge.getAttribute('data-testid') ?? '').includes('loop:')))).toBe(true);
  const loopPath = page.locator('.react-flow__edge.grid-loop-edge .react-flow__edge-path').first();
  await loopPath.waitFor();
  expect(await loopPath.getAttribute('d')).not.toMatch(/[CQ]/);
  await expect.poll(async () => {
    const container = await page.locator('.react-flow__node').filter({ hasText: 'grp' }).first().boundingBox();
    const left = await page.locator('.react-flow__node').filter({ hasText: 'left' }).first().boundingBox();
    return Boolean(container && left
      && container.x <= left.x
      && container.y <= left.y
      && container.x + container.width >= left.x + left.width
      && container.y + container.height >= left.y + left.height);
  }).toBe(true);
  await page.getByTestId('container-grp').click();
  await page.waitForFunction(() => !document.body.innerText.includes('left'));
  await page.getByTestId('container-grp').click();
  await page.waitForFunction(() => document.body.innerText.includes('left'));

  // Explicit errors: an unknown task and a synthetic 500 never hang on loading.
  await page.goto(`${server.url}/#/tasks/missing-task`);
  await page.getByTestId('error').filter({ visible: true }).waitFor();
  expect(await page.getByTestId('error').filter({ visible: true }).innerText()).not.toContain('加载中');
  await page.route('**/api/tasks/broken-task**', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'internal', message: '合成服务器错误' }) }));
  await page.goto(`${server.url}/#/tasks/broken-task`);
  await page.getByTestId('error').filter({ visible: true }).waitFor();
  expect(await page.getByTestId('error').filter({ visible: true }).innerText()).toContain('合成服务器错误');
}, 90_000);
