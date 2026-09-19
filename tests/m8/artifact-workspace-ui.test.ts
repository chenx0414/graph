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
  webDir = await mkdtemp(join(tmpdir(), 'graph-artifact-ui-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);

afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([
      Promise.resolve(action()).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 5_000)),
    ]);
  }
  cleanup.length = 0;
});

test('conversation workspace visualizes published artifact versions and content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-artifact-ui-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    webDir,
    autoDrive: false,
    startup: { mode: 'view', configured: false, modelCount: 0, enabledModelCount: 0 },
  });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({
    text: '查看共享产物。',
    requestId: 'artifact-ui-conversation',
  });
  const view = await server.runtime.conversations.view(created.conversationId);
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'papers.json'), '{"papers":[{"title":"Shared paper"}]}');
  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  try {
    const artifacts = new ArtifactWorkspace(store, join(root, 'state', 'artifact-workspace'));
    await artifacts.publish({
      taskId: view.anchorTaskId,
      workspace: source,
      namespace: 'research',
      name: 'papers',
      sourcePath: 'papers.json',
      schema: 'source-list@1',
      title: '共享文献集',
      summary: '供后续写作与审查复用',
      producer: { nodeId: 'research', instanceId: 'instance', operationId: 'operation', activationId: 'activation' },
      requestId: 'artifact-ui-publish',
    });
  } finally {
    store.close();
  }

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('conversation-tab-artifacts').click();
  await page.getByTestId('artifact-workspace').waitFor();
  const item = page.locator('[data-testid^="artifact-list-item-"]').first();
  await item.waitFor();
  await item.click();
  await page.getByRole('heading', { name: '共享文献集' }).waitFor();
  await page.getByText('Shared paper').waitFor();
  expect(await page.getByText('graph://tasks/').first().isVisible()).toBe(true);

  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.getByTestId('artifact-workspace').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}, 30_000);
