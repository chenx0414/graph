import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { nextEventCursor } from '../../src/web/event-cursor.ts';
import type { NodeSpec } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
beforeAll(async () => { await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error' }); }, 60_000);
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

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
  expect(nextEventCursor(0, { cursor: 3, type: 'task.created' })).toEqual({ cursor: 3, type: 'task.created' });
  expect(nextEventCursor(3, { cursor: 3, type: 'task.created' })).toBeNull();
  expect(nextEventCursor(3, { cursor: 2, type: 'task.created' })).toBeNull();
  expect(nextEventCursor(3, { cursor: 4.5, type: 'x' })).toBeNull();
  expect(nextEventCursor(3, { type: 'x' })).toBeNull();
  expect(nextEventCursor(3, null)).toBeNull();
});

test('the console completes the main flow, keeps projects separate, and restores a direct graph URL', async () => {
  const rootA = await temp('flow-a');
  const rootB = await temp('flow-b');
  const server = await openGraphServer({
    stateDir: join(rootA, 'state'),
    projects: [{ id: 'project-a', root: rootA }, { id: 'project-b', root: rootB }],
    actions: actions(rootA),
    autoDrive: true,
    webDir: join(process.cwd(), 'dist/web'),
    startup: { mode: 'execute', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  const browser = await launch();
  const page = await browser.newPage();

  await page.goto(server.url);
  await page.getByTestId('queue').waitFor();
  await page.getByTestId('project-select').selectOption('project-a');
  await page.getByTestId('request-input').fill('任务 A：实现搜索');
  const begun = page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '开始' }).click();
  const taskA = (await (await begun).json() as { taskId: string }).taskId;
  await server.runtime.supervisor(taskA).propose({
    requirementVersion: 1, summary: '任务 A 提案',
    acceptance: [{ id: 'works', description: '搜索可用', checkNode: 'check' }],
    nodes: [
      { id: 'implement', kind: 'agent', action: 'implement', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['implement'] },
    ],
  }, 'proposal-a');
  await page.getByTestId('queue').getByText('任务 A：实现搜索').waitFor();
  await page.getByTestId('queue').getByText('任务 A：实现搜索').click();
  await page.getByTestId('proposal').waitFor();
  expect(await page.getByTestId('proposal').innerText()).toContain('验收项');
  expect(await page.getByTestId('proposal').innerText()).toContain('检查节点 check');
  await page.getByTestId('accept-branch').fill('feature-a');
  const accepted = page.waitForRequest(request => request.url().endsWith('/accept') && request.method() === 'POST');
  await page.getByTestId('accept').click();
  const acceptBody = JSON.parse((await accepted).postData() ?? '{}') as { proposalVersion: number; targetBranch: string };
  expect(acceptBody.proposalVersion).toBe(1);
  expect(acceptBody.targetBranch).toBe('feature-a');
  await page.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent?.includes('已完成'));
  await page.getByRole('link', { name: '查看任务图' }).click();
  await page.getByTestId('graph').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.react-flow__node')].some(node => node.textContent?.includes('implement succeeded')));
  await page.locator('.react-flow__node').filter({ hasText: 'implement' }).first().click();
  expect(await page.getByTestId('node-detail').innerText()).toContain('实例');
  await page.locator('.react-flow__node').filter({ hasText: 'check' }).first().click();
  expect(await page.getByTestId('node-detail').innerText()).toContain('works:有效');
  await page.getByTestId('legend').waitFor();

  // A second project and task must not mix data with the first.
  await page.goto(server.url);
  await page.getByTestId('queue').waitFor();
  await page.getByTestId('project-select').selectOption('project-b');
  await page.getByTestId('request-input').fill('任务 B：修复导出');
  const begunB = page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '开始' }).click();
  const taskB = (await (await begunB).json() as { taskId: string }).taskId;
  expect(taskB).not.toBe(taskA);
  await page.goto(`${server.url}/#/tasks/${taskA}`);
  await page.waitForFunction(() => document.querySelector('[data-testid="request"]')?.textContent?.includes('任务 A'));
  await page.goto(`${server.url}/#/tasks/${taskB}`);
  await page.waitForFunction(() => document.querySelector('[data-testid="request"]')?.textContent?.includes('任务 B'));
  expect(await page.getByTestId('request').innerText()).not.toContain('任务 A');
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
    autoDrive: false, webDir: join(process.cwd(), 'dist/web'),
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
  await page.getByTestId('container-grp').click();
  await page.waitForFunction(() => !document.body.innerText.includes('left'));
  await page.getByTestId('container-grp').click();
  await page.waitForFunction(() => document.body.innerText.includes('left'));

  // Explicit errors: an unknown task and a synthetic 500 never hang on loading.
  await page.goto(`${server.url}/#/tasks/missing-task`);
  await page.getByTestId('error').waitFor();
  expect(await page.getByTestId('error').innerText()).not.toContain('加载中');
  await page.route('**/api/tasks/broken-task', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'internal', message: '合成服务器错误' }) }));
  await page.goto(`${server.url}/#/tasks/broken-task`);
  await page.getByTestId('error').waitFor();
  expect(await page.getByTestId('error').innerText()).toContain('合成服务器错误');
}, 90_000);
