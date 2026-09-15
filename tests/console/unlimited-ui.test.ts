import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-unlimited-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterAll(() => rm(webDir, { recursive: true, force: true }));

test('the console shows an unlimited instance as 不限 instead of a fake cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-unlimited-ui-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir,
    actions: {
      work: { kind: 'agent', reserveTokens: 20_000_100, prepare: async () => async () => ({ outcome: 'completed', output: null, usage: { input: 20_000_001, output: 0, cacheRead: 0, cacheWrite: 0 } }) },
      check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(root, 'ok'), digest: 'a'.repeat(64) } }] }) },
    },
  });
  cleanup.push(() => server.close());
  const { taskId } = await server.runtime.user.begin({ projectId: 'p', request: 'Unlimited UI', requestId: 'begin' });
  const proposed = await server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Unlimited UI',
    acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await server.runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  expect(await server.runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(await server.runtime.host.runReady()).toEqual({ dispatched: 1 });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/tasks/${taskId}`);
  await page.getByTestId('status').waitFor();
  const taskText = await page.locator('body').innerText();
  expect(taskText).toContain('不限');
  expect(taskText).not.toContain('总预算 20,000,000');

  await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  await page.getByTestId('flow').waitFor();
  const work = page.locator('.react-flow__node').filter({ hasText: 'work' }).first();
  await work.waitFor({ state: 'visible' });
  await work.click();
  const detail = await page.getByTestId('node-detail').innerText();
  expect(detail).toContain('额度不限');
  expect(detail).toContain('20,000,001');
}, 90_000);
