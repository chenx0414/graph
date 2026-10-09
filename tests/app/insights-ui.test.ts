import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium, type Page } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-app-insights-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});
afterAll(() => rm(webDir, { recursive: true, force: true }));

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-app-insights-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function launch(): Promise<Page> {
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  return browser.newPage();
}

test('the inbox aggregates native graph questions, updates its badge and answers each graph independently', async () => {
  const root = await temp('inbox');
  const server = await openGraphServer({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir,
    autoDrive: false, limits: { defaultBudgetTokens: 1 } });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');
  const owner = await server.runtime.user.begin({ projectId: 'p', request: 'Native inbox', requestId: 'begin' });
  const main = server.runtime.supervisor(owner.taskId);
  const graphs: string[] = [];
  for (const name of ['First budget', 'Second budget']) {
    const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name,
      protocols: { job: { type: 'object' } }, nodes: { work: { recipe: 'worker@1', task: 'Reply after quota authorization.',
        inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {} } }, modules: {}, edges: {},
    }) }) as { graphId: string };
    graphs.push(graphId); await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} });
  }
  await server.runtime.host.drive();
  const page = await launch(); await page.goto(server.url);
  await expect.poll(() => page.getByTestId('rail-inbox-badge').textContent()).toBe('2');
  await page.click('a[href="#/inbox"]'); await page.getByTestId('inbox').waitFor();
  await expect.poll(() => page.getByTestId('budget-tokens').count()).toBe(2);
  for (const remaining of [1, 0]) {
    await page.getByTestId('budget-tokens').first().fill('200000');
    const response = page.waitForResponse(r => r.url().endsWith('/answer'));
    await page.getByRole('button', { name: '答复' }).first().click();
    expect((await response).status()).toBe(200);
    await expect.poll(() => page.getByTestId('budget-tokens').count()).toBe(remaining);
    if (remaining) await expect.poll(() => page.getByTestId('rail-inbox-badge').textContent()).toBe('1');
  }
  await page.getByTestId('inbox-empty').waitFor();
  await expect.poll(() => page.locator('.question-history-item').count()).toBe(2);
  await expect.poll(() => page.getByTestId('rail-inbox-badge').count()).toBe(0);
  for (const graphId of graphs) {
    expect((await server.runtime.user.task(graphId).view()).questions.filter(question => question.status === 'open')).toEqual([]);
    expect(server.runtime.nodeRun(graphId, 'work').instance).toMatchObject({ authorizedBudget: { budget: 200001, unlimited: false } });
  }
}, 60000);

test('a real 100-node native HTTP graph first paint stays inside the interaction budget', async () => {
  const root = await temp('perf');
  const server = await openGraphServer({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir, autoDrive: false });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');
  const owner = await server.runtime.user.begin({ projectId: 'p', request: 'Native performance', requestId: 'begin' });
  const data = { protocol: 'data' };
  const { graphId } = await server.runtime.supervisor(owner.taskId).graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2,
    name: '100-node pipeline', protocols: { data: { type: 'object' } },
    nodes: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`n${i}`, { recipe: 'worker@1', task: `Stage ${i}`,
      inputs: { job: data }, outputs: { result: data }, submission: { required: ['result'] } }])), modules: {},
    edges: Object.fromEntries(Array.from({ length: 99 }, (_, i) => [`e${i}`, { from: `n${i}.result`, to: `n${i + 1}.job`, enabled: true }])),
  }) }) as { graphId: string };
  const page = await launch(); const started = Date.now();
  await page.goto(`${server.url}/#/tasks/${graphId}/graph`);
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length >= 100);
  const elapsed = Date.now() - started;
  console.log(`real 100-node graph first paint: ${elapsed}ms`);
  expect(elapsed).toBeLessThan(3000);
  await expect.poll(() => page.locator('.react-flow__edge.grid-edge').count()).toBe(99);
}, 60000);
