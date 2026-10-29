import { chromium } from 'playwright';
import { expect, test } from 'vitest';
import { cleanup, configFile, session, start, temp } from './settings-ui.fixture.ts';

// A compaction is a command turn, not something the user typed. It must read as
// one system action line with its time, so the transcript never shows a person's
// bubble saying "压缩当前会话上下文".
test('a compaction renders as one system action line, not as a user bubble', async () => {
  const dir = await temp('compact-command');
  const path = await configFile(dir, 'http://127.0.0.1:1/v1');
  const daemon = await start(dir, path);
  const api = await session(daemon.url);
  const created = await api.post('/api/conversations', { projectId: 'sample', model: 'local', text: '先聊一句。', requestId: 'first' });
  const createdText = await created.text();
  expect(created.status, createdText).toBe(200);
  const { conversationId } = JSON.parse(createdText) as { conversationId: string };
  const compact = await api.post(`/api/conversations/${conversationId}/compact`, { requestId: 'compact-1' });
  const compactText = await compact.text();
  expect(compact.status, compactText).toBe(200);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/conversations/${conversationId}`);
  await page.getByTestId('conversation').waitFor();

  // The command shows up as the action line, with a clock, and never as a user message.
  await expect.poll(async () => await page.getByTestId('message-command').count(), { timeout: 15_000 }).toBeGreaterThan(0);
  const action = page.getByTestId('message-command').last();
  expect(await action.getAttribute('data-command')).toBe('compact');
  expect(await action.innerText()).toContain('已压缩上下文');
  expect(await action.innerText()).toMatch(/\d{1,2}:\d{2}/);
  const userBubbles = await page.getByTestId('message-user').allInnerTexts();
  expect(userBubbles.some(text => text.includes('压缩当前会话上下文'))).toBe(false);
}, 120_000);
