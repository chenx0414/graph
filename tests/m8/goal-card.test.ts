import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { chromium } from 'playwright';
import { build } from 'vite';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * The goal is a property of the conversation, so the console has to show it as
 * something a person manages, not only as a command they have to remember:
 * objective, status, spend and the same actions /goal offers.
 *
 * The proof is the real daemon, the real bundle and a real browser; the goal
 * itself is created through the public HTTP surface, exactly as the composer
 * would, and every action afterwards is a click.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

let webDir = '';
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-m8-goal-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterAll(() => rm(webDir, { recursive: true, force: true }));

test('the goal card shows the objective and runs pause, resume, budget, completion and clear', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m8-goal-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const configPath = join(root, 'graph.config.json');
  // A scripted provider keeps the console in its normal state and answers the
  // turn a freshly set goal starts, so the card shows a settled spend instead
  // of an unanswered thread.
  const provider = await openaiServer([
    { text: '开始做导出', usage: { prompt_tokens: 40, completion_tokens: 10 } },
  ]);
  cleanup.push(() => provider.close());
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
    credentials: { local: { secretRef: 'GRAPH_GOAL_CARD_KEY' } },
  }));
  const daemon = await launchCli(root, { configPath, webDir, env: { GRAPH_GOAL_CARD_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const session = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const post = async (path: string, body: object) => {
    const response = await fetch(`${daemon.url}${path}`, { method: 'POST', headers: session, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };

  const created = await post('/api/conversations', { text: '/goal 让导出支持 CSV +500', requestId: 'goal-ui' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = String(created.body.conversationId);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/conversations/${conversationId}`);
  const card = page.getByTestId('goal-card');
  await card.waitFor();

  expect(await page.getByTestId('goal-objective').innerText()).toBe('让导出支持 CSV');
  expect(await page.getByTestId('goal-status').innerText()).toBe('进行中');
  // Setting the goal started a turn; its spend lands on the card on the next
  // refresh, so the assertion waits for the settled number.
  await expect.poll(() => page.getByTestId('goal-usage').innerText(), { timeout: 15_000 }).toContain('已用 50 / 500 tokens');

  await page.getByTestId('goal-pause').click();
  await expect.poll(() => page.getByTestId('goal-status').innerText(), { timeout: 10_000 }).toBe('已暂停');
  await page.getByTestId('goal-resume').click();
  await expect.poll(() => page.getByTestId('goal-status').innerText(), { timeout: 10_000 }).toBe('进行中');

  await page.getByTestId('goal-extend-amount').fill('1000');
  await page.getByTestId('goal-extend').click();
  await expect.poll(() => page.getByTestId('goal-usage').innerText(), { timeout: 10_000 }).toContain('1.5k');

  await page.getByTestId('goal-done').click();
  await page.getByTestId('goal-note-input').fill('导出已上线');
  await page.getByTestId('goal-done-confirm').click();
  await expect.poll(() => page.getByTestId('goal-status').innerText(), { timeout: 10_000 }).toBe('已完成');
  expect(await page.getByTestId('goal-note').innerText()).toContain('导出已上线');

  // The slash palette names the command instead of requiring the person to
  // remember it; picking it writes the command into the composer.
  await page.getByTestId('chat-input').fill('/');
  const option = page.getByTestId('slash-popover').getByText('设定目标');
  await option.waitFor();
  await option.click();
  // The composer is a CodeMirror contenteditable, not an input element.
  await expect.poll(() => page.getByTestId('chat-input').innerText()).toBe('/goal ');

  await page.screenshot({ path: '/tmp/graph-goal-card.png', fullPage: true });
  await page.getByTestId('goal-clear').click();
  await expect.poll(() => page.getByTestId('goal-card').count(), { timeout: 10_000 }).toBe(0);
}, 120_000);
