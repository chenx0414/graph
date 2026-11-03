import { chromium } from 'playwright';
import { expect, test } from 'vitest';

import { cleanup, consoleServer, gitProject, temp } from './app-shell-ux.fixture.ts';
import { PROPOSAL } from '../e2e/go-graph-confirmation.fixture.ts';

// The conversation used to carry an always-on "工作草稿 / 刷新" strip under the
// transcript: a supervisor conversation sees the work of its projects, and a
// work with no draft has nothing to confirm, so the panel stood there empty.
test('a conversation whose work has no draft shows no 工作草稿 panel', async () => {
  const root = await temp('work-drafts-panel');
  await gitProject(root);
  const server = await consoleServer(root);
  // A work belongs to a supervisor thread, so the panel is judged there.
  const global = await server.request('/api/orchestration/global', { method: 'POST', body: JSON.stringify({ requestId: 'global' }) });
  expect(global.status, await global.clone().text()).toBe(200);
  const conversationId = (await global.json() as { conversationId: string }).conversationId;

  const message = await server.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ requestId: 'message', text: '把导出做成 CSV' }),
  });
  expect(message.status).toBe(200);
  const messageId = (await message.json() as { messageId: string }).messageId;
  const work = await server.request('/api/orchestration/work', {
    method: 'POST',
    body: JSON.stringify({
      requestId: 'work', conversationId, projectId: 'alpha', sourceMessageId: messageId,
      brief: '把导出做成 CSV', acceptance: ['导出可用'],
    }),
  });
  expect(work.status, await work.clone().text()).toBe(200);
  const workId = (await work.json() as { id: string }).id;
  const drafts = await server.request(`/api/orchestration/work/${workId}/drafts`);
  expect(drafts.status).toBe(200);
  expect((await drafts.json() as { items: unknown[] }).items).toHaveLength(0);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${conversationId}`);
  await page.getByTestId('message-list').waitFor();
  // The work exists and has no draft: the panel must not stand there empty.
  // The panel reads after its own refresh settles, so an empty one would have
  // had every chance to appear.
  await expect.poll(() => page.getByTestId('work-drafts').count(), { timeout: 10_000, interval: 200 }).toBe(0);
  expect(await page.locator('text=工作草稿').count()).toBe(0);
});

// A work delegated from the global supervisor is confirmed there, by the Agent
// that dispatched it, not by the person a second time. Measured 2026-11-03: the
// project conversation drew a confirm card for a draft the user had already
// delegated, so the same decision was asked twice - once when delegating and
// once when the plan came back.
test('a delegated draft is not drawn as a card the person must confirm', async () => {
  const root = await temp('work-drafts-delegated');
  await gitProject(root);
  const server = await consoleServer(root);
  const global = await server.request('/api/orchestration/global', { method: 'POST', body: JSON.stringify({ requestId: 'global' }) });
  expect(global.status, await global.clone().text()).toBe(200);
  const conversationId = (await global.json() as { conversationId: string }).conversationId;
  const message = await server.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ requestId: 'message', text: '把导出做成 CSV' }),
  });
  expect(message.status).toBe(200);
  const messageId = (await message.json() as { messageId: string }).messageId;
  const work = await server.request('/api/orchestration/work', {
    method: 'POST',
    body: JSON.stringify({ requestId: 'work', conversationId, projectId: 'alpha', sourceMessageId: messageId, brief: '把导出做成 CSV', acceptance: ['导出可用'] }),
  });
  expect(work.status, await work.clone().text()).toBe(200);
  const workId = (await work.json() as { id: string }).id;
  const draft = await server.request(`/api/orchestration/work/${workId}/drafts`, {
    method: 'POST',
    body: JSON.stringify({ requestId: 'draft', workRevision: 1, proposal: { ...PROPOSAL, summary: '把导出做成 CSV 的计划' } }),
  });
  expect(draft.status, await draft.clone().text()).toBe(200);
  const project = await server.request('/api/projects/alpha/thread', { method: 'POST', body: JSON.stringify({ requestId: 'project' }) });
  expect(project.status, await project.clone().text()).toBe(200);
  const projectConversation = (await project.json() as { conversationId: string }).conversationId;

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  for (const id of [conversationId, projectConversation]) {
    await page.goto(`${server.url}/#/conversations/${id}`);
    // The console keeps the previous thread mounted, so only the visible one counts.
    await page.locator('[data-testid="message-list"]:visible').waitFor();
    // The draft exists - the panel would have had every chance to appear.
    await expect.poll(() => page.locator('[data-testid="work-drafts"]:visible').count(), { timeout: 10_000, interval: 200 }).toBe(0);
    expect(await page.locator('text=工作草稿:visible').count()).toBe(0);
  }
});
