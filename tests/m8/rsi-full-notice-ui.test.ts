// graph:table-writes-exempt: this test seeds the async-full report the runtime writes, so the console has one to render
/**
 * A background full-suite report is a transcript boundary, not a chat message.
 *
 * It sits in the same place as a compaction notice and must read the same way:
 * one rule-framed line naming what happened, and one small summary block with
 * the facts. Dumping every unmatched assertion into the transcript and boxing
 * the file list and the log path separately turns a boundary into a wall of
 * text the reader scrolls past.
 *
 * The report is seeded where the runtime writes it (the message table); above
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
  '判定: 回归；未匹配: tests/m8/app-shell-ux.part-02.test.ts / tests/e2e/harness-eval-lifecycle.test.ts',
  '摘要:',
  'FAIL  tests/m8/app-shell-ux.part-02.test.ts > the context chip shows a share',
  'AssertionError: expected 1 to be 2',
  '完整日志: /tmp/state/rsi/reports/async-full-49201d4-6fb4-4769-aa19-5b71fa38aa8b.log',
].join('\n');

test('an async-full report reads as one boundary line and one summary block, like a compaction', async () => {
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
  db.prepare(
    `INSERT INTO messages(id,conversation_id,role,kind,text,data,state,operation_id,turn,created_at,updated_at)
     VALUES(?,?,'user','chat',?,?,'done',NULL,0,?,?)`,
  ).run(
    randomUUID(), created.conversationId, REPORT,
    JSON.stringify({ source: { kind: 'rsi_async_full', activationId: 'activation-1', commit: '0a6b15ce690933caa853db9090454bfe30315b87' }, environment: false }),
    stamp, stamp,
  );
  db.close();

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);

  const notice = page.getByTestId('rsi-full-notice');
  await notice.waitFor({ timeout: 60_000 });
  expect(await notice.getAttribute('data-role')).toBe('system');
  expect(await notice.getAttribute('data-verdict')).toBe('regression');

  // The head line names the event; the raw report lives in its tooltip, not in the transcript.
  expect(await notice.innerText()).toContain('后台全量确认 · 回归');

  // Exactly one summary block, styled as a compaction summary - not one box per fact.
  expect(await notice.getByTestId('rsi-full-summary').count()).toBe(1);
  expect(await notice.getByTestId('rsi-full-files').count(), 'the file list must not be its own box').toBe(0);
  expect(await notice.locator('.compaction-notice-details').count(), 'the raw failure dump must not be rendered').toBe(0);
  const summary = notice.getByTestId('rsi-full-summary');
  const style = await summary.evaluate(node => {
    const computed = getComputedStyle(node);
    return { fontSize: computed.fontSize, whiteSpace: computed.whiteSpace, border: computed.borderLeftWidth };
  });
  expect(style).toEqual({ fontSize: '12px', whiteSpace: 'pre-wrap', border: '2px' });
  expect(await summary.innerText()).not.toContain('AssertionError');

  // The facts a reader needs stay in that one block.
  const text = await summary.innerText();
  expect(text).toContain('tests/m8/app-shell-ux.part-02.test.ts');
  expect(text).toContain('/tmp/state/rsi/reports/async-full-49201d4-6fb4-4769-aa19-5b71fa38aa8b.log');
}, 120_000);
