import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

function field(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null || !(key in value)) throw new Error(`Missing ${key}`);
  const entries = Object.fromEntries(Object.entries(value));
  const result = entries[key];
  if (typeof result !== 'string' || !result) throw new Error(`Invalid ${key}`);
  return result;
}

test('the browser returns to the same global and project supervisors while retaining old conversations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-orchestration-browser-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  const webDir = join(root, 'web');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
  const provider = await openaiServer([
    { text: 'Previous conversation reply.' },
    { text: 'Next question.' },
    { text: 'Global supervisor reply.' },
    { text: 'Next question.' },
    { text: 'Project supervisor reply.' },
  ]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_BROWSER_TEST_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' },
    { id: 'fast', provider: 'graph-openai', grade: 'medium', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath, webDir, extraArgs: ['--execute'], env: { GRAPH_BROWSER_TEST_KEY: 'synthetic-browser-key' },
  });
  cleanup.push(() => daemon.close());

  const prior = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ title: 'Earlier conversation', text: 'Earlier work', requestId: 'prior' }),
  });
  expect(prior.status).toBe(200);
  const priorID = field(await prior.json(), 'conversationId');
  await expect.poll(async () => {
    const response = await daemon.request(`/api/conversations/${priorID}`);
    const body: unknown = await response.json();
    return JSON.stringify(body).includes('Previous conversation reply.');
  }, { timeout: 30_000 }).toBe(true);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  // There is no new-conversation page: the console opens the global Agent's thread,
  // and the model is chosen on that conversation before the first message.
  await page.goto(daemon.url);
  await page.getByTestId('open-global-agent').click();
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('#/conversations/');
  await page.getByTestId('chat-input').waitFor({ timeout: 30_000 });
  await page.getByTestId('model-control').click();
  await page.getByTestId('model-option-fast').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('chat-input').fill('Help me manage my projects');
  await page.getByTestId('chat-send').click();
  const globalURL = page.url();
  await expect.poll(() => page.getByTestId('message-list').locator('visible=true').innerText(), { timeout: 30_000 }).toContain('Global supervisor reply.');
  const globalID = globalURL.split('/').at(-1);
  if (!globalID) throw new Error('Global conversation ID missing from URL');
  const globalView: unknown = await (await daemon.request(`/api/conversations/${globalID}`)).json();
  // The model chosen in the console is the one the created conversation carries.
  // Thinking strength is the composer's own persisted selection, covered by the
  // model-control keeper; here the conversation simply has a level of its own.
  expect(globalView).toMatchObject({ master: { model: 'fast' } });
  expect(String((globalView as { telemetry?: { thinkingLevel?: string } }).telemetry?.thinkingLevel ?? '')).not.toBe('');
  await expect.poll(() => page.getByTestId('conversation-list').innerText()).toContain('Earlier conversation');
  const sidebar = page.getByTestId('conversation-list');
  for (const label of ['项目', '最近']) {
    const toggle = sidebar.getByRole('button', { name: label, exact: true });
    await toggle.click();
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    await toggle.click();
    expect(await toggle.getAttribute('aria-expanded')).toBe('true');
  }
  // The main Agent entry is one row, not a heading plus a conversation row.
  const globalEntry = page.getByTestId('open-global-agent');
  expect(await globalEntry.evaluate(el => el.tagName)).toBe('BUTTON');
  expect(await page.getByTestId('conversation-list').getByRole('link', { name: 'Main', exact: true }).count()).toBe(0);
  expect(await page.getByTestId('conversation-list').getByRole('button', { name: '主 Agent', exact: true }).count()).toBe(0);
  expect(await page.getByTestId('conversation-list').locator('.sidebar-label', { hasText: '主 Agent' }).count()).toBe(0);
  await page.getByTestId('open-global-agent').click();
  await expect.poll(() => page.url()).toContain('#/conversations/');
  const projectEntry = page.getByTestId('open-project-p');
  await projectEntry.focus();
  expect(await projectEntry.evaluate(element => element === document.activeElement)).toBe(true);
  expect(await projectEntry.getAttribute('aria-label')).toContain('主管');
  // A project owns exactly one supervisor Agent, so the row is the whole control:
  // no second button beside it and no list to unfold before the conversation opens.
  // The console has no new-conversation page at all: no composer outside a conversation.
  expect(await page.getByTestId('new-conversation-input').count()).toBe(0);
  expect(await page.locator('details.sidebar-project').count()).toBe(0);
  expect(await page.getByTestId('open-project-p').locator('svg').count()).toBe(1);
  expect(await page.getByTestId('open-project-p').getByRole('button').count()).toBe(0);
  expect(await page.locator('a[href="#/catalog"]').getAttribute('aria-label')).toBe('资源库');
  expect(await page.locator('a[href="#/settings"]').getAttribute('aria-label')).toBe('设置');
  expect(await page.locator('a').filter({ hasText: '概览' }).count()).toBe(0);
  expect(await page.locator('a').filter({ hasText: '向导' }).count()).toBe(0);
  // The sidebar has one state: there is no expand/collapse control left to click.
  expect(await page.getByTestId('sidebar-toggle').count()).toBe(0);
  await sidebar.waitFor({ state: 'visible' });
  expect(await page.getByTestId(`archive-conversation-${priorID}`).count()).toBe(1);
  expect(await page.getByTestId(`archive-conversation-${globalID}`).count()).toBe(0);

  await page.getByTestId('open-project-p').click();
  await expect.poll(() => page.url(), { timeout: 30_000 }).not.toBe(globalURL);
  const projectURL = page.url();
  expect(projectURL).toContain('#/conversations/');
  const projectID = projectURL.split('/').at(-1);
  if (!projectID) throw new Error('Project conversation ID missing from URL');
  // A project with no conversation yet used to open onto a blank page: it now shows
  // the same guidance an empty conversation does, aimed at that project's Agent.
  await page.getByTestId('conversation-intro').waitFor();
  await expect.poll(() => page.getByTestId('conversation-intro').innerText()).toContain('与 p 的主管对话');
  await expect.poll(() => page.getByTestId('conversation-intro').innerText()).toContain('这个项目还没有对话');
  expect(await page.getByTestId('conversation-intro').locator('.starter-card').count()).toBe(3);
  await page.getByTestId('conversation-intro').locator('.starter-card').first().click();
  await expect.poll(() => page.getByTestId('chat-input').locator('visible=true').innerText()).toContain('梳理这个项目的结构');
  // The guidance has to fit the transcript area: when it overflows, the thread pins to
  // the bottom and cuts its own top off (measured once at 483px inside 390px).
  expect(await page.getByTestId('message-list').locator('visible=true').evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  expect(await page.getByTestId('message-list').locator('visible=true').evaluate(el => Math.round(el.scrollTop))).toBe(0);
  await page.getByTestId('chat-input').locator('visible=true').fill('Review this project');
  await page.getByTestId('chat-send').locator('visible=true').click();
  await expect.poll(() => page.getByTestId('message-list').locator('visible=true').innerText(), { timeout: 30_000 }).toContain('Project supervisor reply.');
  expect(await page.getByTestId(`archive-conversation-${projectID}`).count()).toBe(0);

  await page.getByTestId('open-global-agent').click();
  await expect.poll(() => page.url()).toBe(globalURL);
  await page.getByTestId('open-project-p').click();
  await expect.poll(() => page.url()).toBe(projectURL);
  await expect.poll(() => page.getByTestId('message-list').locator('visible=true').innerText()).toContain('Review this project');
  // Once the conversation has a message the guidance is gone.
  expect(await page.getByTestId('conversation-intro').count()).toBe(0);
}, 180_000);
