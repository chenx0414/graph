// graph:table-writes-exempt: this test seeds the async-full report and the compaction the runtime writes, so the console has both to keep out of the transcript
/**
 * Machine notices stay out of the chat.
 *
 * A background full-suite report, a compaction and a self-improvement report are
 * all system events: they used to be drawn as ruled cards between the messages and
 * turned a conversation into a wall of boxes. They now leave no visible row, and
 * the conversation itself still reads normally.
 *
 * The events are seeded where the runtime writes them (the message table); above
 * that everything is real - the daemon's own projection and Chromium.
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chromium } from 'playwright';
import { cleanup, temp, gitProject, consoleServer, scriptedProvider, createConversation } from './app-shell-ux.fixture.ts';

const REPORT = [
  '[后台全量确认失败]',
  '提交: 0a6b15ce690933caa853db9090454bfe30315b87',
  '判定: 回归；未匹配: tests/m8/app-shell-ux.part-02.test.ts',
  '摘要:',
  'FAIL  tests/m8/app-shell-ux.part-02.test.ts > the context chip shows a share',
  'AssertionError: expected 1 to be 2',
  '完整日志: /tmp/state/rsi/reports/async-full-49201d4-6fb4-4769-aa19-5b71fa38aa8b.log',
].join('\n');

test('a machine notice leaves no card in the transcript', async () => {
  const root = await temp('rsi-full-notice');
  const project = join(root, 'alpha');
  await mkdir(project, { recursive: true });
  await gitProject(project);
  const provider = await scriptedProvider(() => []);
  cleanup.push(() => provider.close());
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root: project }], model: provider.baseUrl, execute: true });
  const created = await createConversation(server, { projectId: 'alpha', text: '跑一次全量确认。', requestId: 'rsi-full-notice' });

  const db = new DatabaseSync(join(root, 'state/tasks.sqlite'));
  db.exec('PRAGMA busy_timeout=5000');
  const stamp = Date.now();
  const insert = db.prepare(
    `INSERT INTO messages(id,conversation_id,role,kind,text,data,state,operation_id,turn,created_at,updated_at)
     VALUES(?,?,?,?,?,?,'done',NULL,0,?,?)`,
  );
  insert.run(
    randomUUID(), created.conversationId, 'user', 'chat', REPORT,
    JSON.stringify({ source: { kind: 'rsi_async_full', activationId: 'activation-1', commit: '0a6b15ce690933caa853db9090454bfe30315b87' }, environment: false }),
    stamp, stamp,
  );
  insert.run(
    randomUUID(), created.conversationId, 'system', 'compaction', '上下文已压缩',
    JSON.stringify({ tokensAfter: 1200, summary: '前文摘要：PROMPT-SUMMARY-MARKER' }),
    stamp + 1, stamp + 1,
  );
  insert.run(
    randomUUID(), created.conversationId, 'system', 'rsi', '### RSI 已应用：修复超时',
    JSON.stringify({ status: 'applied', title: 'RSI-TITLE-MARKER' }),
    stamp + 2, stamp + 2,
  );
  db.close();

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);

  const thread = page.getByTestId('message-list');
  await expect.poll(async () => thread.innerText(), { timeout: 60_000 }).toContain('跑一次全量确认。');

  expect(await page.getByTestId('rsi-full-notice').count()).toBe(0);
  expect(await page.getByTestId('rsi-report').count()).toBe(0);
  expect(await page.locator('.compaction-notice').count()).toBe(0);
  expect(await page.locator('.compaction-summary').count()).toBe(0);

  const text = await thread.innerText();
  expect(text).not.toContain('完整日志');
  expect(text).not.toContain('AssertionError');
  expect(text).not.toContain('PROMPT-SUMMARY-MARKER');
  expect(text).not.toContain('RSI-TITLE-MARKER');
}, 120_000);
