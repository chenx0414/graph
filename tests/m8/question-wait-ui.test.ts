/**
 * An unanswered question must show how long it has waited.
 *
 * The harm this locks down: a conversation whose agent asked a question and got
 * no answer looked exactly like a conversation whose agent was working - the
 * card said what was asked and nothing about time, so a session that had stood
 * still since the morning still read as "in progress".
 *
 * This drives the real console in a real browser: the master asks through the
 * real ask_user path, nobody answers, the clock is backdated through the
 * daemon's own database (fifteen minutes is not a test budget), and the card
 * the user sees must say both the wait and that it is past the deadline.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chromium } from 'playwright';
import { cleanup, temp, gitProject, consoleServer, scriptedProvider, createConversation } from './app-shell-ux.fixture.ts';

interface SeenQuestion { id: string; kind: string; status: string; waitedMs?: number | null; overdue?: boolean }

test('an unanswered question shows how long it has waited', async () => {
  const root = await temp('question-wait-ui');
  const project = join(root, 'alpha');
  await mkdir(project, { recursive: true });
  await gitProject(project);
  const provider = await scriptedProvider(body => {
    const answered = (body.messages ?? []).some(message => message.role === 'tool' && message.tool_call_id === 'call-ask');
    if (answered) return [];
    return [{
      id: 'call-ask', name: 'ask_user',
      args: { prompt: '这一轮先做哪一件？', why: '先做哪件决定我接下来改哪个文件。', options: ['先做提问期限', '先做重试'], requestId: 'ask-ui' },
    }];
  });
  cleanup.push(() => provider.close());
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root: project }], model: provider.baseUrl, execute: true });
  const created = await createConversation(server, { projectId: 'alpha', text: '问我一个问题，然后停住。', requestId: 'question-wait-ui' });

  const openQuestions = async () => {
    const response = await server.request(`/api/conversations/${created.conversationId}`);
    const view = await response.json() as { questions?: SeenQuestion[] };
    return (view.questions ?? []).filter(question => question.status === 'open' && question.kind === 'waiting');
  };
  await expect.poll(async () => (await openQuestions()).length, { timeout: 90_000, interval: 250 }).toBe(1);
  const [question] = await openQuestions();

  // The wait is the product's own measurement: only the start time is moved,
  // through the same database the daemon reads.
  const db = new DatabaseSync(join(root, 'state/tasks.sqlite'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare('UPDATE questions SET asked_at=? WHERE id=?').run(Date.now() - 20 * 60 * 1000, question!.id);
  db.close();

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const wait = page.getByTestId(`question-waiting-${question!.id}`);
  await wait.waitFor({ timeout: 60_000 });
  expect(await wait.getAttribute('data-overdue')).toBe('true');
  expect(await wait.innerText()).toContain('已等待 20 分钟');
  expect(await wait.innerText()).toContain('超过 15 分钟仍未回答');
});
