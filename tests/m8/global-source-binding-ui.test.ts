/**
 * The main Agent is bound to the source tree it runs from, not to a project.
 *
 * A global supervisor coordinates every project, so the store forbids a project
 * binding on it (the conversations trigger aborts). What the user sees instead is
 * the fixed source root, read-only: no project picker, nothing to change.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chromium } from 'playwright';
import { cleanup, temp, gitProject, consoleServer, scriptedProvider } from './app-shell-ux.fixture.ts';

test('the global conversation is fixed to the app source root and offers no project picker', async () => {
  const root = await temp('global-source');
  const project = join(root, 'alpha');
  await mkdir(project, { recursive: true });
  await gitProject(project);
  const provider = await scriptedProvider(() => []);
  cleanup.push(() => provider.close());
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root: project }], model: provider.baseUrl, execute: true });

  // The global supervisor thread is created on demand, the way the console opens it.
  const thread = await server.request('/api/orchestration/global', { method: 'POST', body: JSON.stringify({ requestId: 'global-source' }) });
  expect(thread.status, await thread.clone().text()).toBe(200);
  const created = await thread.json() as { conversationId?: string; id?: string };
  const conversationId = created.conversationId ?? created.id;
  expect(conversationId, 'the console created no global conversation').toBeTruthy();

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${conversationId}`);
  await page.locator('[data-testid="conversation"]:visible').waitFor({ timeout: 60_000 });

  await page.locator('[data-testid=drawer-entry]:visible').first().click();
  const fixed = page.locator('[data-testid=bound-source]:visible');
  await fixed.waitFor({ timeout: 20_000 });
  expect(await fixed.innerText(), 'the drawer names the fixed source root').toContain(process.cwd());
  expect(await page.locator('[data-testid=bind-project]').count(), 'the project picker came back').toBe(0);
  expect(await page.locator('[data-testid=bind-select]').count(), 'the project picker came back').toBe(0);
}, 240_000);
