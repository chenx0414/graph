/**
 * A problem nobody acted on must reach the person, on a card they can read.
 *
 * The backend hands a parked problem over after its deadline (see
 * go-problem-escalation.test.ts). This case is the other half: the card the
 * person actually sees has to say that it waited, keep the problem's own kind so
 * the label is truthful, and not pretend to offer actions the product does not
 * have.
 *
 * It drives the real console in a real browser against a provider that refuses
 * the turn, which is what parks a problem on main in the first place.
 */
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chromium } from 'playwright';
import { cleanup, temp, consoleServer, createConversation } from './app-shell-ux.fixture.ts';

/** A provider that refuses every turn: a content failure, so nothing retries it. */
async function refusingProvider() {
  const server: Server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'the model refused this task', type: 'invalid_request_error' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

interface SeenQuestion { id: string; kind: string; owner?: string; data?: Record<string, unknown> }

// The sweep rides a 60s drive tick, so this case needs a budget of its own
// rather than the suite's 15s default.
test('an escalated problem shows up on a readable card', async () => {
  const root = await temp('problem-escalation-ui');
  const model = await refusingProvider();
  const server = await consoleServer(root, { projects: [{ id: 'alpha', root }], model, execute: true });
  const created = await createConversation(server, { projectId: 'alpha', text: '做一件会被拒绝的事。', requestId: 'problem-ui' });

  const questionIn = async (role: 'main' | 'user') => {
    const response = await server.request(`/api/conversations/${created.conversationId}`);
    const view = await response.json() as { questions?: SeenQuestion[] };
    return (view.questions ?? []).find(question => question.kind === 'execution_failed' && (question.owner ?? 'main') === role);
  };
  await expect.poll(async () => Boolean(await questionIn('main')), { timeout: 90_000, interval: 250 }).toBe(true);
  const parked = await questionIn('main');
  expect(parked).toBeTruthy();

  // Past the deadline the harness re-owns it: same question, same kind, now the
  // person's to decide.
  const db = new DatabaseSync(join(root, 'state/tasks.sqlite'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare('UPDATE questions SET asked_at=? WHERE id=?').run(Date.now() - 90 * 60 * 1000, parked!.id);
  db.close();
  await expect.poll(async () => (await questionIn('user'))?.id, { timeout: 120_000, interval: 500 }).toBe(parked!.id);

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  const card = page.getByTestId(`question-reply-${parked!.id}`);
  await card.waitFor({ timeout: 60_000 });
  const text = await card.innerText();
  // The wait is stated, the problem keeps its own label, and the card does not
  // invent a "stop" action the product does not have.
  expect(text).toContain('已经等了');
  expect(text).toContain('执行失败');
  // The label separates "a failure nobody acted on" from "a fresh incident",
  // and the only action on the card says what it really does: re-running that
  // turn costs a model call and may repeat the tool calls it already made.
  expect(text).toContain('无人处理');
  expect(text).toContain('重试这一轮');
  expect(text).toContain('再花一次模型调用');
  expect(text).not.toContain('回“停”');
}, 300_000);
