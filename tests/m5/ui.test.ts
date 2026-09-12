import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test('the local UI shows settings, queue, graph back-edges, and does not allow editing the graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m5-ui-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error' });
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
  const server = await openGraphServer({ ...runtimeOptions, autoDrive: true, webDir: join(process.cwd(), 'dist/web') });
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
  await page.getByTestId('settings').waitFor();
  await page.getByTestId('queue').waitFor();
  await page.goto(`${server.url}/#/catalog`);
  await page.getByTestId('catalog').waitFor();
  expect(await page.getByTestId('catalog').innerText()).toContain('coder@1');
  await page.goto(`${server.url}/#/tasks/${taskId}`);
  await page.getByTestId('status').waitFor();
  await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  expect(await page.getByTestId('graph').getAttribute('data-editable')).toBe('false');
  await page.getByTestId('flow').waitFor();
  await page.locator('.react-flow__node').filter({ hasText: 'implement' }).first().click();
  expect(await page.getByTestId('node-detail').innerText()).toContain('implement');
}, 60_000);
