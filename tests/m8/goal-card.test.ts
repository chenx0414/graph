import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { launchCli } from '../helpers/cli-daemon.ts';
// The browser has to start from this sandbox as well as outside it: the helper uses
// the host session when the process is seatbelt-sandboxed and a plain launch otherwise.
import { launchBrowser } from '../helpers/host-browser.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * The goal is a property of the conversation, and the work itself runs in a graph:
 * the console shows one status bar - the objective, its status, how long it has been
 * standing and what it spent - with no card, no link and no ceiling, and a goal
 * stopped by a provider's capacity answer is shown as recoverable.
 *
 * The proof is the real daemon, the real bundle and a real browser; the goal is
 * created through the public HTTP surface, exactly as the composer would, and
 * every action afterwards is a click.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

let webDir = '';
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-m8-goal-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterAll(() => rm(webDir, { recursive: true, force: true }));

async function consoleWith(plans: Parameters<typeof openaiServer>[0], prefix: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-m8-goal-${prefix}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const second = join(root, 'second');
  await mkdir(project, { recursive: true });
  await mkdir(second, { recursive: true });
  const provider = await openaiServer(plans);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  const credential = `GRAPH_GOAL_${prefix.toUpperCase()}_KEY`;
  await writeFile(configPath, JSON.stringify({
    version: 1,
    // Two projects and a conversation bound to neither: no single project can own a
    // graph for these goals, so they stay in the conversation - which is the path
    // these cases are about (the bar, its spend and its controls).
    projects: [{ id: 'p', root: project }, { id: 'second', root: second }],
    models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
    credentials: { local: { secretRef: credential } },
  }));
  const daemon = await launchCli(root, { configPath, webDir, env: { [credential]: 'synthetic-only' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const session = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const post = async (path: string, body: object) => {
    const response = await fetch(`${daemon.url}${path}`, { method: 'POST', headers: session, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };
  return { daemon, post };
}

test('the goal bar shows the objective, its age and spend, and runs pause, resume, completion and clear', async () => {
  // A turn that reports no usage spends nothing the goal can account, so the
  // goal stays active instead of continuing: this case is about the card's
  // actions, not about how far a goal runs.
  const { daemon, post } = await consoleWith([
    { text: '开始做导出', usage: { prompt_tokens: 0, completion_tokens: 0 } },
    { text: '恢复后继续', usage: { prompt_tokens: 0, completion_tokens: 0 } },
  ], 'card');

  const created = await post('/api/conversations', { text: '/goal 让导出支持 CSV +500', requestId: 'goal-ui' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = String(created.body.conversationId);

  const { browser } = await launchBrowser();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/conversations/${conversationId}`);
  const bar = page.getByTestId('goal-bar');
  await bar.waitFor();

  expect(await page.getByTestId('goal-objective').innerText()).toBe('让导出支持 CSV');
  expect(await page.getByTestId('goal-status').innerText()).toBe('进行中');
  // Only what was actually spent: no ceiling, no progress bar, no top-up.
  expect(await page.getByTestId('goal-usage').innerText()).toBe('0 tokens');
  expect(await page.getByTestId('goal-meter').count()).toBe(0);
  expect(await page.getByTestId('goal-extend').count()).toBe(0);
  // How long it has been standing is on the bar, in the unit a person says out loud.
  expect(await page.getByTestId('goal-elapsed').innerText()).toMatch(/刚刚开始|\d+ 分钟/);
  // It is one line: no card and nothing to click through to the graph.
  expect(await page.getByTestId('goal-card').count()).toBe(0);
  expect(await bar.locator('a').count()).toBe(0);

  await page.getByTestId('goal-pause').click();
  await expect.poll(() => page.getByTestId('goal-status').innerText(), { timeout: 10_000 }).toBe('已暂停');
  await page.getByTestId('goal-resume').click();
  await expect.poll(() => page.getByTestId('goal-status').innerText(), { timeout: 10_000 }).toBe('进行中');
  expect(await page.getByTestId('goal-usage').innerText()).toBe('0 tokens');

  // Finishing a goal is not a button on the bar any more - the graph's independent
  // review decides - so completion is the command, and its receipt is in the thread.
  await page.getByTestId('chat-input').fill('/goal done 导出已上线');
  await page.getByTestId('chat-input').press('Enter');
  await expect.poll(() => page.getByTestId('goal-status').innerText(), { timeout: 20_000 }).toBe('已完成');
  await expect.poll(() => page.getByText('目标已完成：让导出支持 CSV').count(), { timeout: 20_000 }).toBeGreaterThan(0);

  // The slash palette names the command instead of requiring the person to
  // remember it; picking it writes the command into the composer.
  await page.getByTestId('chat-input').fill('/');
  const option = page.getByTestId('slash-popover').getByText('设定目标');
  await option.waitFor();
  await option.click();
  // The composer is a CodeMirror contenteditable, not an input element.
  await expect.poll(() => page.getByTestId('chat-input').innerText()).toBe('/goal ');

  await page.screenshot({ path: '/tmp/graph-goal-bar.png', fullPage: true });
  await page.getByTestId('goal-clear').click();
  await expect.poll(() => page.getByTestId('goal-bar').count(), { timeout: 10_000 }).toBe(0);
}, 120_000);

test('the goal bar shows a capacity stop as recoverable and resumes it with a click', async () => {
  // The transport retries a capacity answer within its own bound before the turn
  // fails; "wait 0" keeps the proof about the bar, not about how long the
  // harness sleeps.
  const busy = { status: 429, headers: { 'retry-after': '0' }, error: 'rate limit reached', errorCode: 'rate_limit' };
  const { daemon, post } = await consoleWith([
    busy, busy, busy,
    { text: '额度恢复了', usage: { prompt_tokens: 0, completion_tokens: 0 } },
  ], 'usage');

  const created = await post('/api/conversations', { text: '/goal 把导出做成 CSV', requestId: 'goal-usage-ui' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = String(created.body.conversationId);

  const { browser } = await launchBrowser();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/conversations/${conversationId}`);
  const bar = page.getByTestId('goal-bar');
  await bar.waitFor();

  await expect.poll(() => page.getByTestId('goal-status').innerText(), { timeout: 40_000 }).toBe('额度用尽');
  expect(await bar.getAttribute('data-status')).toBe('usage_limited');
  // Why the goal stopped is in the conversation, not only on the bar.
  await expect.poll(() => page.getByText('额度/容量限制').count(), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.screenshot({ path: '/tmp/graph-goal-usage-limit.png', fullPage: true });

  // Recoverable means a button: resume puts it back to work.
  await page.getByTestId('goal-resume').click();
  await expect.poll(() => page.getByTestId('goal-status').innerText(), { timeout: 20_000 }).toBe('进行中');
  await page.getByTestId('goal-clear').click();
  await expect.poll(() => page.getByTestId('goal-bar').count(), { timeout: 10_000 }).toBe(0);
}, 120_000);
