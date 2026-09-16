import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium, type Page } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import type { NodeSpec } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-m8-rework-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});
afterAll(() => rm(webDir, { recursive: true, force: true }));

const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-rework-ui-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function actions(root: string) {
  return {
    work: { kind: 'agent' as const, reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed' as const, output: { done: true }, usage }) },
    check: {
      kind: 'program' as const,
      prepare: async () => async () => ({
        outcome: 'completed' as const, output: { passed: true },
        evidence: [{ acceptanceId: 'works', summary: '检查通过', artifact: { path: join(root, 'ok.txt'), digest: 'a'.repeat(64) } }],
      }),
    },
  };
}

async function launch(): Promise<Page> {
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  return browser.newPage();
}

async function propose(server: Awaited<ReturnType<typeof openGraphServer>>, taskId: string, nodes: NodeSpec[]) {
  await server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: '实时记录',
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes,
  }, `proposal-${taskId}`);
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: `accept-${taskId}` });
}

test('node records and evidence refresh from task events without leaving the page or clicking more', async () => {
  const root = await temp('live');
  const server = await openGraphServer({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir, actions: actions(root) });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  const { taskId } = await server.runtime.user.begin({ projectId: 'p', request: '实时记录', requestId: 'begin' });
  await propose(server, taskId, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  const page = await launch();
  await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  await page.locator('.react-flow__node').filter({ hasText: 'check' }).first().click();
  const before = await page.getByTestId('node-detail').innerText();
  expect(before).toContain('操作记录（0）');
  expect(before).toContain('验收证据 无');

  await server.runtime.host.runReady();
  await server.runtime.host.runReady();
  // No navigation, no "加载更多": the event stream must refresh records and evidence.
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="node-operations"] li').length > 0);
  await page.waitForFunction(() => document.querySelector('[data-testid="node-detail"]')?.textContent?.includes('检查通过'));
  const after = await page.getByTestId('node-detail').innerText();
  expect(after).toContain('检查通过');
  expect(after).toContain('works:有效');
  await page.locator('.node-card[data-node-id="work"][data-status="succeeded"]').waitFor();
}, 90_000);

test('a late response for task A never overwrites task B after a fast switch', async () => {
  const root = await temp('race');
  const server = await openGraphServer({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir, actions: actions(root) });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  const first = await server.runtime.user.begin({ projectId: 'p', request: '任务 A', requestId: 'begin-a' });
  await propose(server, first.taskId, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  const second = await server.runtime.user.begin({ projectId: 'p', request: '任务 B', requestId: 'begin-b' });
  await propose(server, second.taskId, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  const page = await launch();
  await page.goto(server.url);
  // Hold A's view response so it resolves after B is already displayed.
  await page.route(`**/api/tasks/${first.taskId}`, async route => {
    await new Promise(resolve => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await page.goto(`${server.url}/#/tasks/${first.taskId}`);
  await page.goto(`${server.url}/#/tasks/${second.taskId}`);
  await page.waitForFunction(() => document.querySelector('[data-testid="request"]')?.textContent?.includes('任务 B'));
  await page.waitForTimeout(2_500);
  const text = await page.getByTestId('request').innerText();
  expect(text).toContain('任务 B');
  expect(text).not.toContain('任务 A');
  expect(await page.getByTestId('task').innerText()).not.toContain('任务 A');
}, 90_000);
