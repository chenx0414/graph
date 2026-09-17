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
import { TaskStore } from '../../src/core/store.ts';
import { appendNodeEntry } from '../../src/core/node-run.ts';

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
  // A compaction is its own display line plus a tagged invocation. The row is
  // written through the same projection API the adapter uses; purpose is what
  // the real gate writes at dispatch time.
  const projection = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(async () => projection.close());
  appendNodeEntry(projection, { taskId, nodeId: 'work', role: 'system', kind: 'compaction', text: '## Goal\n窗口写满后的摘要', data: { reason: 'threshold', tokensBefore: 1_200 } });
  projection.db.prepare("UPDATE invocations SET purpose='compaction' WHERE id=(SELECT i.id FROM invocations i JOIN operations o ON o.id=i.operation_id WHERE o.task_id=? AND o.node_id='work' LIMIT 1)").run(taskId);

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
  expect(await page.getByTestId('entry-compaction').count()).toBe(1);
  expect(await page.getByTestId('node-run-work').innerText()).toContain('上下文摘要');
  expect(await page.getByTestId('node-run-work').innerText()).toContain('含 1 次摘要调用');
  expect(await page.getByTestId('node-run-work').innerText()).toContain('能力包');
  expect(await page.getByTestId('node-run-work').innerText()).not.toContain('bundle');
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

test('two interleaved nodes with more than 500 entries stay fully reachable in the UI', async () => {
  const provider = await openaiServer([{ text: 'unused' }]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-node-paging-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  const stateDir = join(root, 'state');
  const server = await openGraphServer({
    stateDir, projects: [{ id: 'p', root: workspace }], actions: {}, webDir,
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'key', modelRuntime: provider.runtime },
  });
  cleanup.push(() => server.close());
  const { taskId } = await server.runtime.user.begin({ projectId: 'p', request: 'paging', requestId: 'paging-begin' });
  await server.runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'paging',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'a', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'b', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['a'], input: { command: 'node', args: ['-v'] } },
    ],
  }, 'paging-proposal');
  await server.runtime.projects.prepare({ projectId: 'p', requestId: 'paging-prepare', initialize: true, createBaseline: true });
  await server.runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'paging-accept' });
  // Seed the real projection table on a second SQLite connection (WAL) so the
  // UI is exercised against the same storage the adapter writes.
  const store = new TaskStore(join(stateDir, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  for (let index = 0; index < 501; index += 1) {
    appendNodeEntry(store, { taskId, nodeId: 'a', role: 'system', kind: 'note', text: `a-${String(index).padStart(3, '0')}` });
    appendNodeEntry(store, { taskId, nodeId: 'b', role: 'system', kind: 'note', text: `b-${String(index).padStart(3, '0')}` });
  }
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/tasks/${taskId}/nodes/a`);
  await page.getByTestId('node-run-a').waitFor();
  const rows = page.locator('[data-testid^="node-entry-"]');
  await expect.poll(async () => rows.count(), { timeout: 10_000 }).toBe(200);
  // The first page is the live tail, not the oldest window.
  expect(await page.getByTestId('node-run-a').innerText()).toContain('a-500');
  for (let click = 0; click < 6; click += 1) {
    const more = page.getByTestId('node-entries-more');
    if (!(await more.count())) break;
    await more.click();
    await page.waitForTimeout(120);
  }
  expect(await rows.count()).toBe(501);
  const text = await page.getByTestId('node-run-a').innerText();
  expect(text).toContain('a-000');
  expect(text).toContain('a-500');
  expect(text).not.toContain('b-000');
  expect(text).not.toContain('b-500');
  // The other node is an independent projection.
  await page.goto(`${server.url}/#/tasks/${taskId}/nodes/b`);
  await page.getByTestId('node-run-b').waitFor();
  expect(await page.getByTestId('node-run-b').innerText()).toContain('b-500');
  expect(await page.getByTestId('node-run-b').innerText()).not.toContain('a-500');
}, 120_000);
