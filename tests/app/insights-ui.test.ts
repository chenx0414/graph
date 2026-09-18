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
  webDir = await mkdtemp(join(tmpdir(), 'graph-app-insights-web-'));
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
  const dir = await mkdtemp(join(tmpdir(), `graph-app-insights-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function actions(root: string, reserveTokens = 100) {
  return {
    work: { kind: 'agent' as const, reserveTokens, prepare: async () => async () => ({ outcome: 'completed' as const, output: { done: true }, usage }) },
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
    requirementVersion: 1, summary: '可视化增强',
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes,
  }, `proposal-${taskId}`);
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: `accept-${taskId}` });
}

async function settle(server: Awaited<ReturnType<typeof openGraphServer>>, taskId: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await server.runtime.host.runReady();
    const view = await server.runtime.user.task(taskId).view();
    if (view.phase === 'completed' || view.phase === 'failed') return view;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('task did not settle');
}

async function waitFor(predicate: () => Promise<boolean>, timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('condition not met');
}

test('the task page shows a run timeline, usage summary and a toned graph with a minimap', async () => {
  const root = await temp('timeline');
  const server = await openGraphServer({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir, actions: actions(root) });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  const { taskId } = await server.runtime.user.begin({ projectId: 'p', request: 'timeline task', requestId: 'begin' });
  await propose(server, taskId, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  await settle(server, taskId);

  const page = await launch();
  await page.goto(`${server.url}/#/tasks/${taskId}`);
  await page.getByTestId('timeline').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline"] li').length > 0);
  const timeline = await page.getByTestId('timeline').innerText();
  expect(timeline).toContain('创建任务');
  expect(timeline).toContain('任务完成');
  expect(timeline).toContain('调用完成');
  expect(await page.getByTestId('usage-summary').innerText()).toContain('已计量 20 tokens');

  await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  await page.locator('.react-flow__minimap').waitFor();
  expect(await page.locator('.react-flow__minimap').isVisible()).toBe(true);
  expect(await page.locator('.react-flow__node').count()).toBeGreaterThanOrEqual(2);
  await page.locator('.node-card[data-node-id="work"][data-status="succeeded"]').waitFor();
  const border = await page.locator('.node-card[data-node-id="work"]').first()
    .evaluate(element => ({ top: getComputedStyle(element).borderTopColor, left: getComputedStyle(element).borderLeftColor }));
  expect(border.top).toBe('rgb(22, 163, 74)');
  expect(border.left).toBe('rgb(37, 99, 235)');
  // The status dot mirrors the border tone.
  const dot = await page.locator('.node-card[data-node-id="work"]').first()
    .locator('.node-dot').evaluate(element => getComputedStyle(element).backgroundColor);
  expect(dot).toBe('rgb(22, 163, 74)');
}, 90_000);

test('the inbox aggregates open questions, shows a nav badge and can answer them', async () => {
  const root = await temp('inbox');
  const server = await openGraphServer({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir, actions: actions(root, 10) });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  const { taskId } = await server.runtime.user.begin({ projectId: 'p', request: 'pending question task', requestId: 'begin' });
  await propose(server, taskId, [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await server.runtime.host.runReady();
    if ((await server.runtime.user.task(taskId).view()).questions.some(question => question.status === 'open')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await waitFor(async () => (await server.runtime.user.task(taskId).view()).questions.some(question => question.status === 'open'));

  const page = await launch();
  await page.goto(server.url);
  await page.waitForFunction(() => document.querySelector('a[href="#/inbox"]')?.textContent?.includes('(1)'));
  await page.click('a[href="#/inbox"]');
  await page.getByTestId('inbox').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="inbox"]')?.textContent?.includes('reservation_exceeded'));
  await page.getByRole('button', { name: '答复' }).first().click();
  await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="inbox-empty"]')));
  await waitFor(async () => (await server.runtime.user.task(taskId).view()).questions.every(question => question.status !== 'open'));
}, 90_000);

test('a 100-node graph first paint stays inside the interaction budget', async () => {
  const root = await temp('perf');
  const server = await openGraphServer({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir, actions: actions(root) });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  const { taskId } = await server.runtime.user.begin({ projectId: 'p', request: 'perf task', requestId: 'begin' });
  const page = await launch();
  await page.route(`**/api/tasks/${taskId}/graph`, async route => {
    const nodes = Array.from({ length: 100 }, (_, index) => ({
      id: `n${index}`,
      kind: index % 4 === 0 ? 'program' : 'agent',
      status: index % 3 === 0 ? 'succeeded' : index % 3 === 1 ? 'preparing' : 'pending',
      used: index % 3 === 0 ? 10 : null, budget: null, reserved: 0,
      instanceId: null, selectedModel: 'scripted', boundDefinition: 'coder@1',
    }));
    const positions: Record<string, { x: number; y: number; width: number; height: number }> = {};
    const edges: { id: string; source: string; target: string }[] = [];
    nodes.forEach((node, index) => {
      positions[node.id] = { x: (index % 10) * 200, y: Math.floor(index / 10) * 120, width: 160, height: 40 };
      if (index > 0) edges.push({ id: `e${index}`, source: `n${index - 1}`, target: node.id });
    });
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ nodes, containers: [], loops: [], revisions: [{ version: 1, reason: 'perf' }], layout: { positions, edges }, cost: { unknown: false, amount: 0 } }),
    });
  });
  const started = Date.now();
  await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length >= 100);
  const elapsed = Date.now() - started;
  console.log(`100-node graph first paint: ${elapsed}ms`);
  expect(elapsed).toBeLessThan(3_000);
}, 90_000);
