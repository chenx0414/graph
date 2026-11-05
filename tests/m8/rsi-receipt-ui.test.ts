// graph:table-writes-exempt: this test seeds the receipts the runtime writes, so the console has one of every status to render
/**
 * Every self-improvement receipt says what it is.
 *
 * The console has one card for a change that went live, one for a change whose
 * checks failed, one for a rehearsal, one for a rehearsal that failed and one
 * for a rollback - and each of them used to borrow another's words. The harm is
 * concrete: a dry run reading "已提交" is a rehearsal the reader counts as a
 * delivery, and a rollback reading "已生效" is a claim about code that is not
 * running.
 *
 * The receipts are seeded where the runtime writes them (the message table) and
 * everything above that is real: the daemon's own route, the console's own
 * projection, and Chromium. One assertion per status, on the label and on the
 * sentence that goes with it.
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chromium } from 'playwright';
import { cleanup, temp, gitProject, consoleServer, scriptedProvider, createConversation } from './app-shell-ux.fixture.ts';

test('every self-improvement receipt renders its own label and the copy that goes with it', async () => {
  const root = await temp('rsi-receipt-ui');
  const project = join(root, 'alpha');
  await mkdir(project, { recursive: true });
  await gitProject(project);
  const provider = await scriptedProvider(() => []);
  cleanup.push(() => provider.close());
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root: project }], model: provider.baseUrl, execute: true });
  const created = await createConversation(server, { projectId: 'alpha', text: '记一笔自改进。', requestId: 'rsi-receipt-ui' });

  // The titles avoid the words the labels use, so a match can only come from
  // the label itself.
  // One change landed after 1m 5s, one is still waiting. Both are seeded with the
  // timestamps the runtime writes, so the elapsed label is proved against real
  // numbers instead of a fake clock.
  const liveSubmittedAt = Date.now() - 65_000;
  const waitingSubmittedAt = Date.now() - 12_000;
  const receipts: { title: string; data: Record<string, unknown>; createdAt?: number }[] = [
    {
      title: 'A change that is live',
      createdAt: liveSubmittedAt,
      data: {
        status: 'applied', title: 'A change that is live', problem: 'The harness had a defect.',
        branch: 'rsi/live-1', commit: 'a'.repeat(40), files: ['src/web/App.tsx'],
        validation: [{ command: 'node --run check', status: 'passed' }],
        restartRequired: true, activation: { state: 'active', confirmedAt: liveSubmittedAt + 65_000 }, elapsedMs: 46_000, report: 'applied',
      },
    },
    {
      title: 'A change that is still waiting',
      createdAt: waitingSubmittedAt,
      data: {
        status: 'applied', title: 'A change that is still waiting', problem: 'The harness had a defect.',
        branch: 'rsi/waiting-1', commit: 'b'.repeat(40), files: ['src/web/App.tsx'],
        validation: [{ command: 'node --run check', status: 'passed' }],
        restartRequired: true, activation: { state: 'pending_reload' }, elapsedMs: 3_000, report: 'applied',
      },
    },
    {
      title: 'A change that failed its checks',
      data: {
        status: 'checks_failed', title: 'A change that failed its checks', problem: 'The harness had a defect.',
        branch: 'rsi/checks-1', commit: null, files: ['src/web/App.tsx'],
        validation: [{ command: 'node --run check', status: 'failed' }],
        restartRequired: false, report: 'checks failed',
      },
    },
    {
      title: 'A rehearsal that passed',
      data: {
        status: 'dry_run', title: 'A rehearsal that passed', problem: 'Will this pass the gate?',
        branch: null, commit: null, files: ['src/web/App.tsx'],
        validation: [{ command: 'node --run check', status: 'passed' }],
        restartRequired: false, report: 'dry run',
      },
    },
    {
      title: 'A rehearsal that failed',
      data: {
        status: 'dry_run', title: 'A rehearsal that failed', problem: 'Will this pass the gate?',
        branch: null, commit: null, files: ['src/web/App.tsx'],
        validation: [{ command: 'node --run check', status: 'failed' }],
        restartRequired: false, report: 'dry run',
      },
    },
    {
      title: 'A change that rolled back',
      data: {
        status: 'rolled_back', title: 'A change that rolled back', problem: 'The harness had a defect.',
        branch: 'rsi/rollback-1', commit: null, files: ['src/web/App.tsx'],
        validation: [], restartRequired: false, error: 'The change could not be applied', report: 'rolled back',
      },
    },
  ];

  const db = new DatabaseSync(join(root, 'state/tasks.sqlite'));
  db.exec('PRAGMA busy_timeout=5000');
  const insert = db.prepare(
    `INSERT INTO messages(id,conversation_id,role,kind,text,data,state,operation_id,turn,created_at,updated_at)
     VALUES(?,?,'system','rsi',?,?,'done',NULL,0,?,?)`,
  );
  let fallback = Date.now() - receipts.length * 1000;
  for (const receipt of receipts) {
    const stamp = receipt.createdAt ?? fallback;
    insert.run(randomUUID(), created.conversationId, String(receipt.data.report), JSON.stringify(receipt.data), stamp, stamp);
    fallback += 1000;
  }
  db.close();

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);

  const card = (title: string) => page.getByTestId('rsi-report').filter({ hasText: title });

  const live = card('A change that is live');
  await live.waitFor({ timeout: 60_000 });
  expect(await live.getAttribute('data-status')).toBe('applied');
  expect(await live.innerText()).toContain('已生效');
  // The card shows the price of the call the daemon measured (write, gate,
  // commit), not the reload that followed it.
  expect(await live.getByTestId('rsi-report-elapsed').innerText()).toBe('耗时 46s');
  await live.getByRole('button', { name: '展开' }).click();
  expect(await live.innerText()).toContain('宿主已确认重载，改动已生效。');

  const waiting = card('A change that is still waiting');
  expect(await waiting.getAttribute('data-status')).toBe('applied');
  expect(await waiting.innerText()).toContain('等待重载');
  // A change still waiting for its reload already knows what its call cost: the
  // two waits are different facts and are labelled differently.
  expect(await waiting.getByTestId('rsi-report-elapsed').innerText()).toBe('耗时 3s');

  const failedChecks = card('A change that failed its checks');
  expect(await failedChecks.getAttribute('data-status')).toBe('checks_failed');
  expect(await failedChecks.innerText()).toContain('检查未通过');
  await failedChecks.getByRole('button', { name: '展开' }).click();
  expect(await failedChecks.innerText()).toContain('改动已保留在工作区、尚未提交，也不会触发重载。继续修复后再次调用即可。');

  const rehearsal = card('A rehearsal that passed');
  expect(await rehearsal.getAttribute('data-status')).toBe('dry_run');
  expect(await rehearsal.innerText()).toContain('演练通过');
  await rehearsal.getByRole('button', { name: '展开' }).click();
  expect(await rehearsal.innerText()).toContain('演练：改动写进工作区跑过检查后已恢复；没有提交，也不会重载。');

  const failedRehearsal = card('A rehearsal that failed');
  expect(await failedRehearsal.getAttribute('data-status')).toBe('dry_run');
  expect(await failedRehearsal.innerText()).toContain('演练未通过');

  const rolledBack = card('A change that rolled back');
  expect(await rolledBack.getAttribute('data-status')).toBe('rolled_back');
  expect(await rolledBack.innerText()).toContain('已回滚');
  // A rollback is the one receipt that must never read as a delivery: it names
  // the error and says nothing about a running version.
  await rolledBack.getByRole('button', { name: '展开' }).click();
  expect(await rolledBack.innerText()).toContain('The change could not be applied');

  // Exactly the six seeded receipts, so a stray delivery card cannot hide
  // among them.
  expect(await page.getByTestId('rsi-report').count()).toBe(6);
});
