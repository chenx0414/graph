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
  await page.goto(daemon.url);
  await page.getByTestId('model-control').click();
  await page.getByTestId('model-option-fast').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('new-conversation-input').fill('Help me manage my projects');
  await page.getByTestId('new-conversation-start').click();
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('#/conversations/');
  const globalURL = page.url();
  await expect.poll(() => page.getByTestId('message-list').locator('visible=true').innerText(), { timeout: 30_000 }).toContain('Global supervisor reply.');
  const globalID = globalURL.split('/').at(-1);
  if (!globalID) throw new Error('Global conversation ID missing from URL');
  const globalView: unknown = await (await daemon.request(`/api/conversations/${globalID}`)).json();
  expect(globalView).toMatchObject({ master: { model: 'fast' }, telemetry: { thinkingLevel: 'medium' } });
  await expect.poll(() => page.getByTestId('conversation-list').innerText()).toContain('Earlier conversation');
  const sidebar = page.getByTestId('conversation-list');
  for (const label of ['项目', '最近']) {
    const toggle = sidebar.getByRole('button', { name: label, exact: true });
    await toggle.click();
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    await toggle.click();
    expect(await toggle.getAttribute('aria-expanded')).toBe('true');
  }
  const projectEntry = page.getByTestId('new-conversation-project-p');
  await projectEntry.focus();
  expect(await projectEntry.evaluate(element => element === document.activeElement)).toBe(true);
  expect(await projectEntry.getAttribute('aria-label')).toContain('主管');
  expect(await page.locator('a[href="#/inbox"]').getAttribute('aria-label')).toBe('问题');
  expect(await page.locator('a[href="#/catalog"]').getAttribute('aria-label')).toBe('资源库');
  expect(await page.locator('a[href="#/settings"]').getAttribute('aria-label')).toBe('设置');
  expect(await page.locator('a').filter({ hasText: '概览' }).count()).toBe(0);
  expect(await page.locator('a').filter({ hasText: '向导' }).count()).toBe(0);
  await page.getByTestId('sidebar-toggle').click();
  await expect.poll(() => sidebar.isHidden()).toBe(true);
  await page.getByTestId('sidebar-toggle').click();
  await sidebar.waitFor({ state: 'visible' });
  expect(await page.getByTestId(`archive-conversation-${priorID}`).count()).toBe(1);
  expect(await page.getByTestId(`archive-conversation-${globalID}`).count()).toBe(0);

  await page.getByTestId('new-conversation-project-p').click();
  await expect.poll(() => page.url(), { timeout: 30_000 }).not.toBe(globalURL);
  const projectURL = page.url();
  expect(projectURL).toContain('#/conversations/');
  const projectID = projectURL.split('/').at(-1);
  if (!projectID) throw new Error('Project conversation ID missing from URL');
  await page.getByTestId('chat-input').locator('visible=true').fill('Review this project');
  await page.getByTestId('chat-send').locator('visible=true').click();
  await expect.poll(() => page.getByTestId('message-list').locator('visible=true').innerText(), { timeout: 30_000 }).toContain('Project supervisor reply.');
  expect(await page.getByTestId(`archive-conversation-${projectID}`).count()).toBe(0);

  await page.getByTestId('conversation-list').getByRole('link', { name: 'Main', exact: true }).click();
  await expect.poll(() => page.url()).toBe(globalURL);
  await page.getByTestId('new-conversation-project-p').click();
  await expect.poll(() => page.url()).toBe(projectURL);
  await expect.poll(() => page.getByTestId('message-list').locator('visible=true').innerText()).toContain('Review this project');
}, 180_000);

test('the browser previews migration before selecting a project supervisor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-migration-preview-browser-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  const webDir = join(root, 'web');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
  const provider = await openaiServer([{ text: 'First reply.' }, { text: 'Second reply.' }]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }], credentials: { local: { secretRef: 'GRAPH_BROWSER_TEST_KEY' } }, models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
  const daemon = await launchCli(root, { configPath, webDir, extraArgs: ['--execute'], env: { GRAPH_BROWSER_TEST_KEY: 'synthetic-browser-key' } });
  cleanup.push(() => daemon.close());
  async function legacy(title: string, requestId: string, reply: string) {
    const response = await daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', title, text: title, requestId }) });
    expect(response.status).toBe(200);
    const id = field(await response.json(), 'conversationId');
    await expect.poll(async () => JSON.stringify(await (await daemon.request(`/api/conversations/${id}`)).json()), { timeout: 30_000 }).toContain(reply);
    return id;
  }
  const selected = await legacy('First project conversation', 'preview-first', 'First reply.');
  const source = await legacy('Second project conversation', 'preview-second', 'Second reply.');
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(daemon.url);
  await page.getByTestId(`select-project-thread-${selected}`).click();
  const preview = page.getByTestId('project-thread-migration-preview');
  await expect.poll(() => preview.innerText()).toContain('Second project conversation');
  expect(await preview.innerText()).toContain('未完成 graph：0');
  await preview.getByRole('button', { name: '取消' }).click();
  const unchanged: unknown = await (await daemon.request(`/api/conversations/${source}`)).json();
  expect(unchanged).toMatchObject({ role: 'legacy' });
  await page.getByTestId(`select-project-thread-${selected}`).click();
  await expect.poll(() => preview.innerText()).toContain('Second project conversation');
  await preview.getByRole('button', { name: '确认选择' }).click();
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain(`#/conversations/${selected}`);
  const history: unknown = await (await daemon.request(`/api/conversations/${source}`)).json();
  expect(history).toMatchObject({ role: 'history' });
}, 180_000);
