import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-skill-slash-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 90_000);
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});
afterAll(() => rm(webDir, { recursive: true, force: true }));

/**
 * A skill is knowledge the model cannot call: the menu has to offer it under its own token, and
 * picking it has to leave `/skill:<name>` in the composer so the host can inject the body.
 */
test('the slash menu offers bound skills and inserts a /skill token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-skill-slash-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'alpha', root }], webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '先讨论', requestId: 'skill-slash' });

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  let sent: { text?: string } | null = null;
  await page.route('**/api/settings', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      projects: [{ id: 'alpha', root }], defaultModel: 'local',
      models: [{ id: 'local', grade: 'high', credentialId: 'local', contextWindow: 32_000, reasoning: false }],
      definitions: [], capabilities: [],
    }),
  }));
  await page.route('**/api/agent-context*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      root: '/tmp/prompts', docsRoot: '/tmp/docs', definitionVersion: 'main@1', latestDefinitionVersion: 'main@1',
      prompts: [], disabledTools: [], tools: [],
      capabilities: [
        { id: 'mattpocock-skills-skills-engineering-to-spec', version: '1.0.0', kind: 'skill', name: 'to-spec', description: '把讨论沉淀成设计文档。', tools: [] },
        { id: 'some-mcp', version: '2.0.0', kind: 'mcp', name: 'jira', description: '工单。', tools: [] },
      ],
      preview: { sections: [], text: '' }, sent: null,
    }),
  }));
  await page.route(`**/api/conversations/${created.conversationId}/messages`, async route => {
    sent = JSON.parse(route.request().postData() ?? '{}') as { text?: string };
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ conversationId: created.conversationId, messageId: 'message', state: 'pending', cursor: 2, pending: false }),
    });
  });

  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const composer = page.getByTestId('chat-input');
  await composer.waitFor();
  await composer.click();
  await composer.type('/');
  const popover = page.getByTestId('slash-popover');
  await popover.waitFor();
  // Filter to the skill, then pick it the way a person would, and read the token back out.
  await composer.type('to-spec');
  await popover.waitFor();
  await page.keyboard.press('Enter');
  const readInput = () => composer.evaluate((element: HTMLInputElement) => element.value);
  // The composer re-renders with the token; read it after the update, not during it.
  await expect.poll(readInput, { timeout: 5_000 }).toContain('/skill:to-spec');
  // The menu keeps capabilities apart from skills, so a mindless pick cannot inject the wrong thing.
  expect(await page.getByTestId('slash-skill-to-spec').count()).toBe(0);

  await composer.type(' 按它写的做');
  await page.getByTestId('chat-send').click();
  await expect.poll(() => sent?.text ?? '', { timeout: 5_000 }).toContain('/skill:to-spec');

  await page.screenshot({ path: '/tmp/graph-skill-slash-menu.png' });
}, 120_000);
