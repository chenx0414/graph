import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { evidenceDir } from '../helpers/evidence.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-conversation-boundaries-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-conversation-boundaries-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the conversation page surfaces master questions, live worker status, costs and message history', async () => {
  const root = await temp('flow');
  await mkdir(join(root, 'project'), { recursive: true });
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
  let masterCalls = 0;
  let releaseWork!: () => void;
  const held = new Promise<void>(resolve => { releaseWork = resolve; });
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: join(root, 'project') }],
    actions: {
      master: {
        kind: 'agent', reserveTokens: 100,
        prepare: async () => async () => {
          masterCalls += 1;
          return { outcome: 'completed' as const, output: { text: `MASTER_REPLY_${masterCalls}` }, usage: masterCalls === 1 ? null : usage };
        },
      },
      work: {
        kind: 'agent', reserveTokens: 100,
        prepare: async () => async () => { await held; return { outcome: 'completed' as const, output: { built: true }, usage }; },
      },
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    autoDrive: false, webDir,
    startup: { mode: 'execute', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const evidence = evidenceDir(root, 'master-agent-entry');
  await mkdir(evidence, { recursive: true });

  const created = await server.runtime.conversations.create({ projectId: 'p', text: 'Discuss before working', requestId: 'create' });
  await server.runtime.host.runReady();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);

  // Missing usage on an unlimited master is recorded as unknown without
  // turning into a blocking inbox question.
  expect(await page.getByTestId('master-questions').count()).toBe(0);
  await page.screenshot({ path: join(evidence, '06-master-unknown-usage-nonblocking.png'), fullPage: true });

  // A message sent after the unknown-usage turn runs normally.
  await page.getByTestId('chat-input').fill('queued second message');
  await page.getByTestId('chat-send').click();
  await page.waitForFunction(() => document.body.innerText.includes('queued second message'));
  await server.runtime.host.runReady();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="message-assistant"]').length === 2);

  // ME-R05: worker completion updates the sidebar without a manual refresh.
  const anchorTaskId = (await server.runtime.conversations.view(created.conversationId)).anchorTaskId;
  await server.runtime.supervisor(anchorTaskId).propose({
    requirementVersion: 1, summary: 'Independent sidebar fixture',
    acceptance: [{ id: 'a1', description: 'Human checks final output', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'graph.human_check', dependsOn: ['work'] },
    ],
  }, 'draft');
  const confirmed = await server.runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });
  const drive = server.runtime.host.runReady();
  // Node state is read where nodes now live: the task graph, opened in its own tab.
  const workerStatus = `.node-card[data-node-id="work"]`;
  await page.waitForFunction(() => document.querySelector('[data-testid="drawer-entry-label"]')?.textContent?.includes('任务 1'));
  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('detail-drawer').waitFor();
  expect(await page.getByTestId('drawer-mode-tabs').count()).toBe(0);
  await page.getByTestId(`task-graph-tab-${confirmed.taskId}`).click();
  await page.locator(workerStatus).waitFor();
  // Neither the draft card nor the task overview appears in the chat thread any
  // more; the drawer and the graph tab are their only homes.
  expect(await page.locator('.conversation-thread-inner [data-testid="proposal-draft"]').count()).toBe(0);
  expect(await page.locator('.conversation-thread-inner [data-testid^="conversation-task-"]').count()).toBe(0);
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('data-status') === 'running', workerStatus);
  releaseWork();
  await drive;
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('data-status') === 'succeeded', workerStatus);
  const ledgerStatus = (await server.runtime.user.task(confirmed.taskId).view()).nodes.find(node => node.id === 'work')!.status;
  expect(await page.locator(workerStatus).getAttribute('data-status')).toBe(ledgerStatus);
  await page.screenshot({ path: join(evidence, '07-live-worker-status.png'), fullPage: true });

  // ME-R04: more than one page of records still shows the newest messages and
  // keeps older history reachable.
  await server.runtime.conversations.pause(created.conversationId, 'paging-pause');
  for (let index = 0; index < 210; index++) {
    await server.runtime.conversations.chat(created.conversationId, { text: `paged-${String(index).padStart(3, '0')}`, requestId: `paged-${index}` });
  }
  // Back to the conversation tab the way a user would switch, then reload: the shell
  // restores whatever route the address carries.
  await page.locator('.tab[data-kind="conversation"] .tab-open').first().click();
  await page.getByTestId('conversation').waitFor();
  await page.reload();
  await page.getByTestId('conversation').waitFor();
  await page.waitForFunction(() => document.body.innerText.includes('paged-209'));
  await page.getByTestId('load-older').waitFor();
  await page.getByTestId('load-older').click();
  await page.waitForFunction(() => document.body.innerText.includes('queued second message'));
  await page.screenshot({ path: join(evidence, '08-message-paging.png'), fullPage: true });
}, 120_000);
