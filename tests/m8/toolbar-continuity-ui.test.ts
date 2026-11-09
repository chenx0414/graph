// graph:table-writes-exempt: this test seeds a tool call, a receipt and another tool call so the console has to group them
/**
 * One toolbar per stretch of work.
 *
 * A self-improvement receipt, a compaction notice or a phase line is something
 * that happens *inside* a run of tool calls, not the end of it. When they split
 * the toolbar, the reader sees two counters ("26 项活动", then "2 项活动") for one
 * continuous piece of work, and the second one looks like the agent restarted.
 *
 * The rows are seeded where the runtime writes them; the projection and Chromium
 * above that are real.
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chromium } from 'playwright';
import { cleanup, temp, gitProject, consoleServer, scriptedProvider, createConversation } from './app-shell-ux.fixture.ts';

test('a receipt and a phase line do not split the toolbar around tool calls', async () => {
  const root = await temp('toolbar-continuity');
  const project = join(root, 'alpha');
  await mkdir(project, { recursive: true });
  await gitProject(project);
  const provider = await scriptedProvider(() => []);
  cleanup.push(() => provider.close());
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root: project }], model: provider.baseUrl, execute: true });
  const created = await createConversation(server, { projectId: 'alpha', text: '做两轮工具调用，中间插一张回执。', requestId: 'toolbar-continuity' });

  const operationId = randomUUID();
  const stamp = Date.now();
  const db = new DatabaseSync(join(root, 'state/tasks.sqlite'));
  db.exec('PRAGMA busy_timeout=5000');
  const insert = db.prepare(
    `INSERT INTO messages(id,conversation_id,role,kind,text,data,state,operation_id,turn,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const tool = (id: string, ordinal: number, name: string) => insert.run(
    randomUUID(), created.conversationId, 'tool', 'tool', `${name}: 完成`, JSON.stringify({ ordinal, tool: name, toolCallId: id }),
    'done', operationId, 0, stamp + ordinal, stamp + ordinal,
  );
  tool('call-first', 1, 'bash');
  insert.run(
    randomUUID(), created.conversationId, 'system', 'rsi', 'rsi: 一条回执',
    JSON.stringify({
      status: 'applied', title: 'A change that is live', problem: 'The harness had a defect.',
      branch: 'rsi/live-1', commit: 'a'.repeat(40), files: ['src/web/App.tsx'],
      validation: [{ command: 'node --run check', status: 'passed' }], restartRequired: false, report: 'applied',
    }),
    'done', operationId, 0, stamp + 2, stamp + 2,
  );
  tool('call-second', 3, 'bash');
  insert.run(
    randomUUID(), created.conversationId, 'activity', 'activity', '先看看契约，再跑一遍检查。',
    JSON.stringify({ ordinal: 4 }), 'done', operationId, 0, stamp + 4, stamp + 4,
  );
  tool('call-third', 5, 'bash');
  db.close();

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('conversation').waitFor();

  // The turn folds its activity behind one line; open it to reach the toolbar.
  const turn = page.getByTestId('collapsed-turn');
  if (await turn.count() > 0) await turn.first().getByRole('button').first().click();

  const groups = page.getByTestId('tool-activity-group');
  await groups.first().waitFor({ timeout: 30_000 });
  // Only a phase line separates toolbars: the receipt does not, so the two calls
  // around it share one toolbar, and the call after the phase line gets its own.
  expect(await groups.count(), 'one toolbar per stretch, split only by a phase line').toBe(2);
  const first = (await groups.nth(0).getAttribute('data-tool-calls'))!.split(' ');
  expect(first).toContain('call-first');
  expect(first).toContain('call-second');
  expect(first).not.toContain('call-third');
  expect((await groups.nth(1).getAttribute('data-tool-calls'))!.split(' ')).toEqual(['call-third']);
  // The receipt stays readable, inside the toolbar it interrupted before.
  expect(await groups.nth(0).getByTestId('tool-group-notices').innerText()).toContain('A change that is live');
}, 120_000);
