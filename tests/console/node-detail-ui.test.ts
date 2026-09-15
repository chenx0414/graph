import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { installPresets } from '../../src/catalog/presets.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const presetsRoot = fileURLToPath(new URL('../../presets', import.meta.url));

let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-node-detail-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterAll(() => rm(webDir, { recursive: true, force: true }));

test('node detail renders real entries, operations and a program command, and stays read-only', async () => {
  const provider = await openaiServer([
    { tools: [{ id: 'r1', name: 'read', arguments: JSON.stringify({ path: 'note.txt' }) }] },
    { text: 'Read the note and finished.' },
  ]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-node-detail-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'note.txt'), 'detail marker\n');
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }], actions: {}, webDir,
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
  });
  cleanup.push(() => server.close());
  await installPresets(server.runtime.catalog, presetsRoot);
  const { taskId } = await server.runtime.user.begin({ projectId: 'p', request: 'Node detail UI', requestId: 'begin' });
  await server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Node detail UI',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['-v'] } },
    ],
  }, 'proposal');
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await server.runtime.host.drive();

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  const work = page.locator('.react-flow__node').filter({ hasText: 'work' }).first();
  await work.waitFor({ state: 'visible' });
  await work.click();
  const detail = page.getByTestId('node-detail');
  await detail.waitFor();
  await page.getByTestId('node-run-work').waitFor();
  expect(await page.getByTestId('node-run-work').innerText()).toContain('对话与工具');
  expect(await page.getByTestId('node-run-work').innerText()).toContain('Read the note');
  expect(await page.getByTestId('node-entry-assistant').count()).toBeGreaterThan(0);
  // Read-only: no customer-action controls inside the detail panel.
  expect(await page.getByTestId('node-run-work').getByRole('button', { name: '发送' }).count()).toBe(0);
  expect(await page.getByTestId('node-run-work').getByRole('button', { name: '答复' }).count()).toBe(0);

  // A direct node link restores the same projection and shows the program command.
  await page.goto(`${server.url}/#/tasks/${taskId}/nodes/work`);
  await page.getByTestId('node-run-work').waitFor();
  expect(await page.getByTestId('node-run-work').innerText()).toContain('运行记录');
  await page.goto(`${server.url}/#/tasks/${taskId}/nodes/check`);
  await page.getByTestId('node-run-check').waitFor();
  expect(await page.getByTestId('program-input').innerText()).toContain('"node"');
}, 120_000);
