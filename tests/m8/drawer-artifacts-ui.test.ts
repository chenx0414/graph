import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { ArtifactWorkspace } from '../../src/core/artifact-workspace.ts';
import { TaskStore } from '../../src/core/store.ts';
import { openGraphServer } from '../../src/server/host.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;

beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-drawer-artifacts-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);

afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

test('the shared-artifact index shows a task\'s artifacts apart from the project\'s own, and a detail opens in its own tab', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-artifact-index-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'alpha', root }],
    webDir,
    autoDrive: false,
    startup: { mode: 'view', configured: false, modelCount: 0, enabledModelCount: 0 },
  });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '共享产物索引。', requestId: 'artifact-index' });
  const view = await server.runtime.conversations.view(created.conversationId);

  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'plan.md'), '# 只属于这个任务的计划\n\n正文。\n');
  await writeFile(join(source, 'backlog.md'), '# Graph harness backlog\n\n一行一项。\n');
  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  let promoted;
  let shared;
  let taskOnly;
  try {
    const artifacts = new ArtifactWorkspace(store, join(root, 'state', 'artifact-workspace'));
    taskOnly = await artifacts.publish({
      taskId: view.anchorTaskId,
      workspace: source,
      namespace: 'plans',
      name: 'task-only',
      sourcePath: 'plan.md',
      title: '只属于这个任务',
      producer: { nodeId: 'planner', instanceId: 'instance', operationId: 'op-own', activationId: 'activation' },
      requestId: 'publish-own',
    });
    shared = await artifacts.publish({
      taskId: view.anchorTaskId,
      workspace: source,
      namespace: 'plans',
      name: 'harness-backlog',
      sourcePath: 'backlog.md',
      title: 'Graph harness backlog',
      producer: { nodeId: 'planner', instanceId: 'instance', operationId: 'op-shared', activationId: 'activation' },
      requestId: 'publish-shared',
    });
    // Promotion is what makes an artifact belong to the project rather than to the task.
    promoted = await artifacts.promote({
      taskId: view.anchorTaskId,
      artifactId: shared.artifactId,
      version: shared.version,
      promotedBy: 'user',
      requestId: 'promote-shared',
    });
    // A frequently updated document must occupy one row, not 135 rows.
    for (let version = 2; version <= 135; version++) {
      await writeFile(join(source, 'backlog.md'), `# Graph harness backlog\n\n版本 ${version}。\n`);
      shared = await artifacts.publish({ taskId: view.anchorTaskId, workspace: source,
        namespace: 'plans', name: 'harness-backlog', sourcePath: 'backlog.md', title: 'Graph harness backlog',
        producer: { nodeId: 'planner', instanceId: 'instance', operationId: `op-${version}`, activationId: 'activation' },
        requestId: `publish-${version}` });
      promoted = await artifacts.promote({ taskId: view.anchorTaskId, artifactId: shared.artifactId,
        version: shared.version, promotedBy: 'user', requestId: `promote-${version}` });
    }
    expect(taskOnly.scope).toBe('task');
  } finally {
    store.close();
  }
  expect(promoted.scope).toBe('project');

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('conversation').waitFor();

  // The drawer is only the launcher: it names the task's two windows and links to the index.
  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('detail-drawer').waitFor();
  // This conversation has no draft and no feature task of its own, so the drawer names only the
  // window that exists: the shared-artifact index. It never pretends a task graph is there.
  await page.getByTestId('no-task-graph').waitFor();
  expect(await page.getByTestId('drawer-task-artifacts').count()).toBe(1);
  expect(await page.locator('[data-testid^="task-graph-tab-"]').count()).toBe(0);
  // The drawer no longer lists any artifacts itself.
  expect(await page.getByTestId('drawer-task-detail').locator('[data-testid="drawer-artifacts"]').count()).toBe(0);

  // The index is a window of its own; the drawer opens it as a tab, on the project the user is
  // working in rather than whichever project happens to come first.
  await page.getByTestId('drawer-task-artifacts').click();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/artifacts?project=alpha');
  await page.getByTestId('artifact-index').waitFor();
  expect(await page.getByTestId('artifact-index-project').inputValue()).toBe('alpha');
  const own = page.getByTestId('drawer-artifacts-own');
  const project = page.getByTestId('drawer-artifacts-project');
  await own.waitFor();
  await expect.poll(() => own.innerText()).toContain('只属于这个任务');
  await expect.poll(() => project.innerText()).toContain('Graph harness backlog');
  expect(await project.innerText()).toContain('不属于任何任务');
  const rows = (scope: typeof own) => scope.locator('[data-testid^="drawer-artifact-detail-"]')
    .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')));
  // The project group carries the promoted version; the task keeps its own copy of the same
  // artifact in its own group. Same name, two records, one group each.
  expect(await rows(project)).toEqual([`drawer-artifact-detail-${promoted.artifactId}-${promoted.version}`]);
  expect(await rows(own)).toContain(`drawer-artifact-detail-${shared.artifactId}-${shared.version}`);
  expect(await rows(own)).not.toContain(`drawer-artifact-detail-${promoted.artifactId}-${promoted.version}`);
  const search = page.getByRole('searchbox', { name: '搜索共享产物' });
  await search.fill('task-only');
  await expect.poll(async () => (await rows(own)).length).toBe(1);
  expect(await rows(project)).toEqual([]);
  await search.fill('');
  await page.getByRole('combobox', { name: '产物范围' }).selectOption('project');
  await expect.poll(async () => (await rows(own)).length).toBe(0);
  expect(await rows(project)).toEqual([`drawer-artifact-detail-${promoted.artifactId}-${promoted.version}`]);
  await page.getByRole('combobox', { name: '产物范围' }).selectOption('all');
  await expect.poll(async () => (await rows(own)).length).toBe(2);
  await page.screenshot({ path: '/tmp/artifact-index-01-two-groups.png' });

  await project.locator(`[data-testid="drawer-artifact-detail-${promoted.artifactId}-${promoted.version}"]`).click();
  await page.getByText('版本 135。', { exact: true }).waitFor();
  await page.locator('.artifact-version-history summary').click();
  await page.getByTestId('artifact-history-135').waitFor();
  expect(await page.locator('[data-testid^="artifact-history-"]').count()).toBe(50);
  await page.getByRole('button', { name: '更早版本' }).click();
  await page.getByTestId('artifact-history-36').waitFor();
  await page.getByRole('button', { name: '更早版本' }).click();
  await page.getByTestId('artifact-history-1').waitFor();
  expect(await page.locator('[data-testid^="artifact-history-"]').count()).toBe(135);
  await page.getByTestId('artifact-history-2').click();
  await page.getByText('版本 2。', { exact: true }).waitFor();
  await page.locator('.tab[data-kind="artifact"][data-active="true"] .tab-close').click();
  await page.getByTestId('artifact-index').waitFor();

  // 查看详情 opens a tab of its own, named after the artifact it shows.
  await own.locator(`[data-testid="drawer-artifact-detail-${taskOnly.artifactId}-${taskOnly.version}"]`).click();
  await page.getByTestId('artifact-tab').waitFor();
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('/artifacts/');
  await expect.poll(() => page.locator('.tab[data-kind="artifact"] .tab-title').first().innerText()).toBe('只属于这个任务');
  // The tab shows the artifact's own bytes, not a summary of them.
  await page.getByText('只属于这个任务的计划').first().waitFor();
  await page.screenshot({ path: '/tmp/artifact-index-02-detail-tab.png' });

  // 提升 lives with the artifact it acts on: this tab promotes this version to the project.
  // The task keeps its own copy - the promoted one is a new version in the project scope.
  expect(await page.getByTestId('artifact-promote').isVisible()).toBe(true);
  await page.getByTestId('artifact-promote').click();
  await page.getByText('已提升到项目共享').waitFor();

  // Closing that tab goes back to the index the user came from, which now carries both
  // versions of that artifact in the project group.
  await page.locator('.tab[data-kind="artifact"] .tab-close').first().click();
  await page.getByTestId('artifact-index').waitFor();
  await expect.poll(async () => (await rows(project)).length).toBe(2);
}, 90_000);
