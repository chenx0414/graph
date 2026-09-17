import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

// Each browser suite builds into its own directory; a shared dist/web would
// let one suite empty it while another is loading the hashed assets.
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-m5-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterAll(() => rm(webDir, { recursive: true, force: true }));

test('the local UI shows settings, queue, graph back-edges, and does not allow editing the graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m5-ui-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtimeOptions = {
    stateDir: join(root, 'state'),
    projects: [{ id: 'project', root }],
    actions: {
      implement: { kind: 'agent' as const, reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed' as const, output: { done: true }, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } }) },
      check: { kind: 'program' as const, prepare: async () => async () => ({ outcome: 'completed' as const, output: null, evidence: [{ acceptanceId: 'works', summary: 'ok', artifact: { path: join(root, 'ok.txt'), digest: 'a'.repeat(64) } }] }) },
    },
  };
  const preview = await openTaskRuntime(runtimeOptions);
  preview.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'pub');
  await preview.close();
  const server = await openGraphServer({ ...runtimeOptions, autoDrive: true, webDir });
  cleanup.push(() => server.close());
  const { taskId } = await server.runtime.user.begin({ projectId: 'project', request: 'Show graph', requestId: 'begin' });
  await server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Show graph',
    acceptance: [{ id: 'works', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'implement', kind: 'agent', action: 'implement', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['implement'] },
    ],
  }, 'proposal');
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.getByTestId('new-conversation-input').waitFor();
  await page.getByTestId('conversation-list').waitFor();
  await page.goto(`${server.url}/#/catalog`);
  await page.getByTestId('catalog').waitFor();
  expect(await page.getByTestId('resource-agents').innerText()).toContain('暂无 Agent 组合');
  expect(await page.getByTestId('catalog').innerText()).not.toContain('coder@1');
  await page.goto(`${server.url}/#/tasks/${taskId}`);
  await page.getByTestId('status').waitFor();
  await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  expect(await page.getByTestId('graph').getAttribute('data-editable')).toBe('false');
  await page.getByTestId('flow').waitFor();
  const edgePath = page.locator('.react-flow__edge-path').first();
  await edgePath.waitFor({ state: 'attached' });
  expect(await page.locator('.react-flow__edge.grid-edge').count()).toBeGreaterThan(0);
  expect(await edgePath.getAttribute('d')).not.toMatch(/[CQ]/);
  expect(await page.locator('.react-flow__background circle').count()).toBeGreaterThan(0);
  const implement = page.locator('.react-flow__node').filter({ hasText: 'implement' }).first();
  await implement.waitFor({ state: 'visible' });
  expect(await page.locator('.node-card[data-node-id="implement"]').innerText()).toContain('implement agent');
  expect(await page.locator('.node-card[data-node-id="check"]').innerText()).toContain('check tool');
  await implement.click();
  expect(await page.getByTestId('node-detail').innerText()).toContain('implement');
}, 60_000);

test('the graph follows runtime events and a budget question accepts a token increment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m5-live-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir,
    limits: { defaultBudgetTokens: 20_000_000 },
    actions: {
      work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: null, usage }) },
      expensive: { kind: 'agent', reserveTokens: 20_000_001, prepare: async () => async () => ({ outcome: 'completed', output: null, usage }) },
      check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(root, 'ok'), digest: 'a'.repeat(64) } }] }) },
    },
  });
  cleanup.push(() => server.close());
  const { taskId } = await server.runtime.user.begin({ projectId: 'p', request: 'UI live state', requestId: 'one' });
  await server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Live',
    acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'plan-one');
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept-one' });
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
  await page.locator('.react-flow__node').filter({ hasText: 'work' }).waitFor();
  await page.locator('.node-card[data-node-id="work"][data-status="pending"]').waitFor();
  await server.runtime.host.drive();
  await page.locator('.node-card[data-node-id="work"][data-status="succeeded"]').waitFor();
  const next = await server.runtime.user.begin({ projectId: 'p', request: 'Budget question', requestId: 'two' });
  await server.runtime.supervisor(next.taskId).propose({
    requirementVersion: 1, summary: 'Budget',
    acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'expensive', kind: 'agent', action: 'expensive', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['expensive'] },
    ],
  }, 'plan-two');
  await server.runtime.user.task(next.taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept-two' });
  await server.runtime.host.drive();
  await page.goto(`${server.url}/#/tasks/${next.taskId}`);
  await page.getByTestId('questions').getByRole('button', { name: '答复' }).waitFor();
  await page.getByTestId('budget-tokens').fill('20000000');
  const response = page.waitForResponse(r => r.url().endsWith('/answer'));
  await page.getByTestId('questions').getByRole('button', { name: '答复' }).click();
  const res = await response;
  expect(res.status()).toBe(200);
  expect((await server.runtime.user.task(next.taskId).view()).questions.filter(question => question.status === 'open')).toEqual([]);
}, 60_000);
