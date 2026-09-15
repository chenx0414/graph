import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-setup-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterAll(() => rm(webDir, { recursive: true, force: true }));

test('the wizard connects a platform from a clean start, appends a second one and never sends on save alone', async () => {
  const openai = await openaiServer([{ text: 'pong' }, { text: 'hello from the master' }]);
  cleanup.push(() => openai.close());
  const anthropic = await openaiServer([{ text: 'unused' }]);
  cleanup.push(() => anthropic.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-setup-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, revision: 0, projects: [{ id: 'p', root: projectRoot }] }, null, 2));
  const daemon = await startGraphDaemon({
    configPath, stateDir: join(root, 'state'), webDir, port: 0, mode: 'execute', dynamic: true,
    env: { OPENAI_API_KEY: 'env-key-one', ANTHROPIC_API_KEY: 'env-key-two' }, log: () => undefined,
  });
  cleanup.push(() => daemon.close());

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/setup`);
  await page.getByTestId('setup').waitFor();
  await page.getByTestId('setup-provider-openai').click();
  await page.getByTestId('setup-advanced-toggle').click();
  await page.getByTestId('setup-base-url').fill(openai.model.baseUrl);
  const save = page.waitForResponse(response => response.url().endsWith('/api/config') && response.request().method() === 'POST');
  await page.getByTestId('setup-save').click();
  const savedBody = await (await save).json() as { applied: boolean; configured: boolean; effectiveRevision: number };
  expect(savedBody).toMatchObject({ applied: true, configured: true, effectiveRevision: 1 });
  await page.getByTestId('setup-status').waitFor();
  expect(await page.getByTestId('setup-status').innerText()).toContain('已保存并应用');
  // Saving the key/config alone made no provider request.
  expect(openai.requests).toHaveLength(0);

  // The explicit connectivity test uses the chosen protocol and is the only request so far.
  await page.getByTestId('setup-test').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="setup-test-result"]')?.textContent?.includes('连接成功') === true);
  expect(openai.requests).toHaveLength(1);
  expect(JSON.stringify(openai.requests[0])).toContain('gpt-4o');

  // Appending a second platform merges instead of overwriting the first.
  await page.getByTestId('setup-provider-anthropic').click();
  await page.getByTestId('setup-base-url').fill(anthropic.model.baseUrl);
  const second = page.waitForResponse(response => response.url().endsWith('/api/config') && response.request().method() === 'POST');
  await page.getByTestId('setup-save').click();
  expect((await (await second).json()) as { applied: boolean }).toMatchObject({ applied: true });
  const savedDocument = JSON.parse(await readFile(configPath, 'utf8')) as { models: { entries: { provider: string; api: string }[] } };
  const providers = savedDocument.models.entries.map(entry => entry.provider).sort();
  // Two models per template; both platforms present and neither overwritten.
  expect([...new Set(providers)]).toEqual(['anthropic', 'openai']);
  expect(providers.filter(provider => provider === 'openai')).toHaveLength(2);
  expect(providers.filter(provider => provider === 'anthropic')).toHaveLength(2);
  expect(savedDocument.models.entries.find(entry => entry.provider === 'anthropic')?.api).toBe('anthropic-messages');
  expect(savedDocument.models.entries.find(entry => entry.provider === 'openai')?.api).toBe('openai-completions');
  // The first platform's credential is untouched.
  const reloaded = JSON.parse(await readFile(configPath, 'utf8')) as { credentials: Record<string, { secretRef: string }> };
  expect(reloaded.credentials.openai?.secretRef).toBe('OPENAI_API_KEY');

  // Invalid input keeps the form and points at the field.
  await page.getByTestId('setup-secret-ref').fill('1not-a-ref');
  const before = JSON.parse(await readFile(configPath, 'utf8')) as { revision: number };
  await page.getByTestId('setup-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="setup-secret-ref"]')?.getAttribute('data-invalid') === 'true');
  const after = JSON.parse(await readFile(configPath, 'utf8')) as { revision: number };
  expect(after.revision).toBe(before.revision);

  // A configured daemon can already serve a conversation on the same process.
  const created = await page.evaluate(async () => {
    const response = await fetch('/api/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '开始吧', requestId: 'setup-chat' }) });
    return response.json();
  }) as { conversationId: string };
  expect(created.conversationId).toBeTruthy();
  await page.waitForFunction(() => fetch('/api/startup').then(response => response.json()).then((value: { configured?: boolean }) => value.configured === true));
  await page.goto(`${daemon.url}/#/`);
  await page.getByTestId('conversation-list').waitFor({ timeout: 10_000 });
}, 90_000);
