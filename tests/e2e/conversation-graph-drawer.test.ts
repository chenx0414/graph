import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chromium } from 'playwright';
import { cleanup, temp, gitProject, consoleServer, scriptedProvider, workerProposal, createConversation, conversationView } from '../m8/app-shell-ux.fixture.ts';

test('the conversation drawer displays graph state, one legend and selectable node details', async () => {
  const root = await temp('graph-drawer');
  const project = join(root, 'project');
  await mkdir(project);
  await gitProject(project);
  const provider = await scriptedProvider(body => (body.tools ?? []).some(tool => tool.function?.name === 'propose_graph') ? [
    { id: 'proposal', name: 'propose_graph', args: { proposal: workerProposal('Drawer graph'), requestId: 'drawer-proposal' } },
  ] : []);
  cleanup.push(() => provider.close());
  const daemon = await consoleServer(root, { projects: [{ id: 'alpha', root: project }], model: provider.baseUrl, execute: true });
  const created = await createConversation(daemon, { projectId: 'alpha', text: 'Create the drawer graph', requestId: 'drawer-create' });
  await expect.poll(async () => (await conversationView(daemon, created.conversationId)).proposal?.version, { timeout: 60000 }).toBe(1);
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${daemon.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('drawer-entry-graph').click();
  await page.getByTestId('graph-state-summary').waitFor();
  const board = page.getByTestId('draft-graph-detail');
  await board.waitFor();
  await board.locator('.react-flow__node[data-id="work"]').press('Enter');
  await page.getByTestId('conversation-node-detail').waitFor();
  expect(await page.getByTestId('conversation-node-detail').innerText()).toContain('work');
  expect(pageErrors).toEqual([]);
  expect(await page.getByTestId('legend').count()).toBe(1);
  expect(await page.getByTestId('graph-board-legend').count()).toBe(0);
}, 90000);
