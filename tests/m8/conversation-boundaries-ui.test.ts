import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';

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
  const evidence = join(process.cwd(), 'docs', 'planning', 'acceptance-evidence', 'master-agent-entry');

  const created = await server.runtime.conversations.create({ projectId: 'p', text: 'Discuss before working', requestId: 'create' });
  await server.runtime.host.runReady();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);

  // ME-R02: the master's blocking question must be visible and answerable here.
  await page.getByTestId('master-questions').waitFor();
  expect(await page.getByTestId('master-questions').innerText()).toContain('unknown_usage');
  // ME-R06: unknown usage must not be shown as a zero cost.
  expect(await page.getByTestId('conversation').innerText()).toContain('费用未知');
  await page.screenshot({ path: join(evidence, '06-master-question.png'), fullPage: true });

  // A message queued behind the blocked master survives the reconciliation.
  await page.getByTestId('chat-input').fill('queued second message');
  await page.getByTestId('chat-send').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="message-user"][data-state="pending"]')?.textContent?.includes('queued second message'));
  await page.getByTestId('usage-proof').fill('local fixture proof');
  await page.getByTestId('usage-input').fill('10');
  await page.getByTestId('usage-output').fill('5');
  await page.getByRole('button', { name: '答复' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="master-questions"]'));
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
  const workerStatus = `[data-testid="conversation-nodes-${confirmed.taskId}"] [data-node="work"]`;
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('data-status') === 'running', workerStatus);
  releaseWork();
  await drive;
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('data-status') === 'succeeded', workerStatus);
  const ledgerStatus = (await server.runtime.user.task(confirmed.taskId).view()).nodes.find(node => node.id === 'work')!.status;
  expect(await page.locator(workerStatus).getAttribute('data-status')).toBe(ledgerStatus);
  await page.screenshot({ path: join(evidence, '07-live-worker-status.png'), fullPage: true });

  // ME-R04: more than one page of records still shows the newest messages and
  // keeps older history reachable.
  await page.getByTestId('conversation-pause').click();
  for (let index = 0; index < 210; index++) {
    await server.runtime.conversations.chat(created.conversationId, { text: `paged-${String(index).padStart(3, '0')}`, requestId: `paged-${index}` });
  }
  await page.reload();
  await page.getByTestId('conversation').waitFor();
  await page.waitForFunction(() => document.body.innerText.includes('paged-209'));
  await page.getByTestId('load-older').waitFor();
  await page.getByTestId('load-older').click();
  await page.waitForFunction(() => document.body.innerText.includes('queued second message'));
  await page.screenshot({ path: join(evidence, '08-message-paging.png'), fullPage: true });
}, 120_000);
