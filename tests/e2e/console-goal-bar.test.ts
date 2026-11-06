import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { evidenceDir } from '../helpers/evidence.ts';
import { launchBrowser } from '../helpers/host-browser.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// A goal is one line in the chat, not a card and not a link: the objective, how
// long it has been standing, what it has spent, and pause/continue. The work
// itself is in the graph, so nothing in the conversation opens it.
//
// The proof is a real daemon on real loopback with a controlled provider, and the
// controls are exercised by clicking them in a real browser and reading the state
// back out of the DOM.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

test('the goal is one status bar with its age, its spend and pause/continue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-console-goal-bar-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const second = join(root, 'second');
  await mkdir(project, { recursive: true });
  await mkdir(second, { recursive: true });
  const webDir = join(root, 'web');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
  // Enough tiny answers for the rounds the goal starts by itself while the test
  // drives its two controls.
  const provider = await openaiServer(Array.from({ length: 8 }, (_, index) => ({
    text: `第 ${index + 1} 步完成。`, usage: { prompt_tokens: 120, completion_tokens: 8 },
  })));
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    // Two projects and a conversation bound to neither: this goal runs in the
    // conversation, which is the case where the bar is the only goal UI there is.
    projects: [{ id: 'p', root: project }, { id: 'second', root: second }],
    credentials: { local: { secretRef: 'GRAPH_GOAL_BAR_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, webDir, extraArgs: ['--execute'], env: { GRAPH_GOAL_BAR_KEY: 'synthetic-only' } });
  cleanup.push(() => daemon.close());

  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ model: 'main', title: 'Goal bar', text: '准备开始', requestId: 'goal-bar-first' }),
  });
  const createdText = await created.text();
  expect(created.status, createdText).toBe(200);
  const conversationId = (JSON.parse(createdText) as { conversationId: string }).conversationId;
  await expect.poll(async () => {
    const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as { messages: { role?: string }[] };
    return view.messages.filter(message => message.role === 'assistant').length;
  }, { timeout: 30_000, interval: 100 }).toBeGreaterThan(0);

  // The goal is set with criteria, and it starts working on its own.
  const set = await daemon.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ text: '/goal 整理发布说明\n验收：发布说明覆盖本轮改动', requestId: 'goal-bar-set' }),
  });
  expect(set.status, await set.text()).toBe(200);

  const { browser } = await launchBrowser();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(daemon.url);
  await page.goto(`${daemon.url}/#/conversations/${conversationId}`);
  await page.getByTestId('conversation').waitFor();
  const bar = page.getByTestId('goal-bar');
  await bar.waitFor();
  const text = await bar.innerText();
  // One line: the objective, the state, the age and the spend.
  expect(text).toContain('整理发布说明');
  // A goal between rounds is being reviewed - both are "running", and the bar is
  // read at whatever moment the page happens to load.
  expect(['进行中', '验收中']).toContain(await page.getByTestId('goal-status').innerText());
  expect(text).toMatch(/(刚刚开始|\d+ 分钟|\d+ 小时)/);
  expect(text).toMatch(/[\d.]+[kM]? tokens/);
  // The bar runs the goal inside the conversation, and it carries no link to any
  // graph or task - there is nothing in the chat to click through to.
  expect(await bar.getAttribute('data-runner')).toBe('conversation');
  expect(await bar.locator('a').count()).toBe(0);
  // The card this replaced is gone: the bar is the whole of the goal's presence.
  expect(await page.getByTestId('goal-card').count()).toBe(0);
  await page.screenshot({ path: join(evidenceDir(root, 'console-goal-bar'), 'running.png'), fullPage: false });

  // Pause is a click, not a command line, and it works while the goal is between
  // rounds being reviewed - a person clicking pause means stop, whatever the goal
  // is doing at that instant.
  //
  // The bar says so before and after.
  await page.getByTestId('goal-pause').click();
  await expect.poll(async () => await page.getByTestId('goal-status').innerText(), { timeout: 15_000 })
    .toBe('已暂停')
    .catch(async (failure: Error) => {
      // A click that does not take is a defect, so the failure has to say which
      // leg broke: the request the bar sent, or the state it painted afterwards.
      const shown = await page.getByTestId('goal-error').innerText().catch(() => '(no error shown)');
      const stored = await (await daemon.request(`/api/conversations/${conversationId}/goal`)).text();
      throw new Error(`${failure.message}\nbar error: ${shown}\ndaemon goal: ${stored}`);
    });
  expect(await page.getByTestId('goal-pause').count()).toBe(0);
  await page.getByTestId('goal-resume').waitFor();
  await page.screenshot({ path: join(evidenceDir(root, 'console-goal-bar'), 'paused.png'), fullPage: false });

  // Continuing starts it again, from the same bar.
  await page.getByTestId('goal-resume').click();
  await expect.poll(async () => await page.getByTestId('goal-status').innerText(), { timeout: 15_000 })
    .toMatch(/^(进行中|验收中)$/);
  await page.getByTestId('goal-pause').waitFor();
  // The spend is the goal's own count, so it grows with the rounds it ran.
  const spent = await (await daemon.request(`/api/conversations/${conversationId}/goal`)).json() as { goal: { usedTokens: number } };
  expect(spent.goal.usedTokens).toBeGreaterThan(0);
  await expect.poll(async () => await page.getByTestId('goal-usage').innerText(), { timeout: 15_000 })
    .toMatch(/[\d.]+[kM]? tokens/);

  // Leave it stopped: a paused goal is not worked on, which is what the person
  // asked for when they clicked pause.
  await page.getByTestId('goal-pause').click();
  await expect.poll(async () => await page.getByTestId('goal-status').innerText(), { timeout: 15_000 }).toBe('已暂停');
}, 180_000);
