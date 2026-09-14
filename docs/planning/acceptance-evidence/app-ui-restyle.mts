/**
 * UI restyle evidence probe: renders the redesigned console in both themes and
 * captures the overview, task, graph, inbox, settings and wizard pages from a
 * real Chromium, with visible-text assertions.
 * Run: export PATH="$PWD/node_modules/.bin:$PATH"; node docs/planning/acceptance-evidence/app-ui-restyle.mts
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openGraphServer } from '../../../src/server/host.ts';
import { startGraphDaemon } from '../../../src/server/start.ts';

const shot = (name: string) => new URL(`./${name}`, import.meta.url).pathname;
const webDir = new URL('../../../dist/web', import.meta.url).pathname;
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
const root = await mkdtemp(join(tmpdir(), 'graph-ui-restyle-'));
const evidence: Record<string, unknown> = {};

const server = await openGraphServer({
  stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir,
  actions: {
    work: { kind: 'agent' as const, reserveTokens: 10, prepare: async () => async () => ({ outcome: 'completed' as const, output: { done: true }, usage }) },
    check: {
      kind: 'program' as const,
      prepare: async () => async () => ({
        outcome: 'completed' as const, output: { passed: true },
        evidence: [{ acceptanceId: 'works', summary: '检查通过', artifact: { path: join(root, 'ok.txt'), digest: 'a'.repeat(64) } }],
      }),
    },
  },
});
server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
const first = await server.runtime.user.begin({ projectId: 'p', request: '重塑控制台界面', requestId: 'ui-begin' });
await server.runtime.supervisor(first.taskId).propose({
  requirementVersion: 1, summary: '界面重塑',
  acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
  nodes: [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
  ],
}, 'ui-proposal');
await server.runtime.user.task(first.taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'ui-accept' });
for (let attempt = 0; attempt < 60; attempt += 1) {
  await server.runtime.host.runReady();
  if ((await server.runtime.user.task(first.taskId).view()).questions.some(question => question.status === 'open')) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
// Let the entrance animations settle before each capture.
const settle = () => page.waitForTimeout(450);

await page.goto(server.url);
await page.getByTestId('queue').waitFor();
evidence.overviewText = (await page.locator('main').innerText()).slice(0, 120).replace(/\n/g, ' | ');
await settle();
await page.screenshot({ path: shot('app-ui-overview.png') });

await page.evaluate(() => localStorage.setItem('graph-theme', 'dark'));
await page.reload();
await page.getByTestId('queue').waitFor();
evidence.darkTheme = await page.evaluate(() => document.documentElement.dataset.theme);
await settle();
await page.screenshot({ path: shot('app-ui-overview-dark.png') });
await page.evaluate(() => localStorage.setItem('graph-theme', 'light'));
await page.reload();
await page.getByTestId('queue').waitFor();

await page.goto(`${server.url}/#/tasks/${first.taskId}`);
await page.getByTestId('timeline').waitFor();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline"] li').length > 0);
evidence.taskTimelineEntries = await page.locator('[data-testid="timeline"] li').count();
evidence.taskStatus = await page.getByTestId('status').innerText();
await settle();
await page.screenshot({ path: shot('app-ui-task.png') });

await page.goto(`${server.url}/#/tasks/${first.taskId}/graph`);
await page.locator('.react-flow__minimap').waitFor();
evidence.graphNodes = await page.locator('.react-flow__node').count();
await settle();
await page.screenshot({ path: shot('app-ui-graph.png') });

await page.goto(`${server.url}/#/inbox`);
await page.getByTestId('inbox').waitFor();
await page.waitForFunction(() => document.querySelector('[data-testid="inbox"]')?.textContent?.includes('预算不足'));
evidence.inboxText = (await page.getByTestId('inbox').innerText()).slice(0, 120).replace(/\n/g, ' | ');
await settle();
await page.screenshot({ path: shot('app-ui-inbox.png') });

// Settings and wizard need a config-bound daemon.
const configDir = join(root, 'config');
await mkdir(configDir, { recursive: true });
const configPath = join(configDir, 'graph.config.json');
await writeFile(configPath, `${JSON.stringify({
  version: 1,
  projects: [{ id: 'demo', root }],
  models: { entries: [{ id: 'local-model', provider: 'local', grade: 'medium', api: 'openai-completions', baseUrl: 'http://127.0.0.1:8080/v1', contextWindow: 32768, maxTokens: 4096, credentialId: 'local' }] },
  credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
  limits: { credentials: { local: 2 }, sharedGroups: {} },
}, null, 2)}\n`);
const settingsDaemon = await startGraphDaemon({ configPath, stateDir: join(configDir, 'state'), webDir, port: 0, mode: 'view', env: {}, log: () => undefined });
await page.goto(`${settingsDaemon.url}/#/settings`);
await page.getByTestId('settings-page').waitFor();
evidence.settingsRevision = await page.getByTestId('config-revision').innerText();
await settle();
await page.screenshot({ path: shot('app-ui-settings.png') });

const emptyDir = join(root, 'empty');
await mkdir(emptyDir, { recursive: true });
const emptyConfig = join(emptyDir, 'graph.config.json');
await writeFile(emptyConfig, `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`);
const setupDaemon = await startGraphDaemon({ configPath: emptyConfig, stateDir: join(emptyDir, 'state'), webDir, port: 0, mode: 'view', env: {}, log: () => undefined });
await page.goto(`${setupDaemon.url}/#/setup`);
await page.getByTestId('setup').waitFor();
evidence.setupSaveLabel = await page.getByTestId('setup-save').innerText();
await settle();
await page.screenshot({ path: shot('app-ui-setup.png') });

await browser.close();
await setupDaemon.close();
await settingsDaemon.close();
await server.close();
await rm(root, { recursive: true, force: true });
console.log(JSON.stringify(evidence, null, 1));
