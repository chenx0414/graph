import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * An unanswered question must say how long it has waited.
 *
 * Measured before this: a question waiting for the person and a working agent
 * were indistinguishable - the console could only say "open", so a conversation
 * that had stood still since the morning still read as work in progress. The
 * wait is the fact that separates the two, and past the published deadline it
 * has to stop looking like a note.
 *
 * This case drives the real daemon: the master asks, nobody answers, and the
 * view the console reads must report the wait and the deadline. Backdating the
 * row through the daemon's own database is what makes a fifteen-minute question
 * observable in a test that cannot wait fifteen minutes; the wait itself is
 * still computed by the product, not by the test.
 */

interface ProviderTool { function?: { name?: string } }
interface ProviderBody { tools?: ProviderTool[]; messages?: { role?: string; content?: unknown }[] }

// Several choices at once: the harness has no single recommendation to take, so
// this question keeps the plain wait and the published deadlines. A question with
// one answer would be answered by the harness after five minutes instead, and
// could never reach the states asserted here.
const QUESTION = {
  prompt: '这一轮先做哪几件？',
  why: '两件都会改动唤醒链路，先做哪些决定我接下来改哪个文件。',
  options: ['先做提问期限', '先做节点落定后的重试'],
  multiple: true,
  requestId: 'ask-wait-1',
};

function questionProvider() {
  const requests: { master: boolean; body: ProviderBody }[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body: ProviderBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody : {};
    const master = (body.tools ?? []).some(tool => tool.function?.name === 'ask_user');
    requests.push({ master, body });
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const asked = requests.filter(entry => entry.master).length > 1;
    if (master && !asked) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{
        index: 0, id: 'call-ask', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify(QUESTION) } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Waiting for your answer.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  return {
    requests,
    baseUrl: new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`))),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

interface WaitedQuestion {
  id: string; kind: string; status: string;
  askedAt?: number | null; waitedMs?: number | null; overdueAfterMs?: number; overdue?: boolean;
  suspendedAfterMs?: number; suspended?: boolean;
}

test('an open question reports how long it has waited and when it is overdue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-question-wait-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = questionProvider();
  const baseUrl = await provider.baseUrl;
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [],
      credentials: { local: { secretRef: 'GRAPH_QUESTION_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-question', grade: 'high',
        api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_QUESTION_KEY: 'synthetic-question-key' }, extraArgs: ['--execute'] });
    async function request(path: string, method = 'GET', data?: unknown) {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }
    const created = await request('/api/conversations', 'POST', { model: 'local', text: '问我一个问题。', requestId: 'wait-1' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    const openQuestion = async (): Promise<WaitedQuestion | undefined> => {
      const view = await request(`/api/conversations/${conversationId}`);
      const questions = (view.body as { questions?: (WaitedQuestion & { data?: Record<string, unknown> })[] }).questions ?? [];
      return questions.find(question => question.kind === 'waiting' && question.status === 'open');
    };
    await expect.poll(async () => Boolean(await openQuestion()), { timeout: 60000, interval: 250 }).toBe(true);
    const asked = await openQuestion();
    // The wait is measured from when the person was asked, not from page load.
    expect(typeof asked?.askedAt, JSON.stringify(asked)).toBe('number');
    expect(asked?.overdueAfterMs).toBe(15 * 60 * 1000);
    expect(typeof asked?.waitedMs, JSON.stringify(asked)).toBe('number');
    expect(asked?.waitedMs ?? -1).toBeGreaterThanOrEqual(0);
    expect(asked?.overdue).toBe(false);

    // A question asked twenty minutes ago has outlived the deadline. Only the
    // clock moves: nothing answers the question, so it is still open and still
    // the person's to answer.
    const db = new DatabaseSync(join(root, 'state/tasks.sqlite'));
    db.exec('PRAGMA busy_timeout=5000');
    db.prepare('UPDATE questions SET asked_at=? WHERE id=?').run(Date.now() - 20 * 60 * 1000, asked!.id);
    db.close();

    await expect.poll(async () => (await openQuestion())?.overdue, { timeout: 20000, interval: 250 }).toBe(true);
    const overdue = await openQuestion();
    expect(overdue?.status).toBe('open');
    expect(overdue?.waitedMs ?? 0).toBeGreaterThanOrEqual(20 * 60 * 1000);
    expect(overdue?.overdue).toBe(true);

    // Past the suspend deadline the conversation stops reporting a blocking
    // problem and starts reporting the truth: it is waiting for a person.
    // Nothing answers the question - the status is the only thing that changes.
    const suspendedDb = new DatabaseSync(join(root, 'state/tasks.sqlite'));
    suspendedDb.exec('PRAGMA busy_timeout=5000');
    suspendedDb.prepare('UPDATE questions SET asked_at=? WHERE id=?').run(Date.now() - 60 * 60 * 1000, asked!.id);
    suspendedDb.close();

    const listStatus = async (conversation: string) => {
      const list = await request('/api/conversations');
      const rows = (Array.isArray(list.body) ? list.body : []) as { id: string; status: string }[];
      return rows.find(row => row.id === conversation)?.status;
    };
    await expect.poll(async () => listStatus(conversationId), { timeout: 20000, interval: 250 }).toBe('awaiting_user');
    const stillOpen = await openQuestion();
    expect(stillOpen?.status).toBe('open');
    expect(stillOpen?.suspended).toBe(true);

    // A person answering is still the only thing that ends the wait, and the
    // conversation leaves the suspended status without any other help.
    const view = (await request(`/api/conversations/${conversationId}`)).body as { anchorTaskId: string };
    const answered = await request(`/api/tasks/${view.anchorTaskId}/answer`, 'POST', {
      questionId: asked!.id, answer: { type: 'respond', value: '先做提问期限' }, requestId: 'answer-question-wait',
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await expect.poll(async () => listStatus(conversationId), { timeout: 30000, interval: 250 }).not.toBe('awaiting_user');
    await expect.poll(async () => Boolean(await openQuestion()), { timeout: 30000, interval: 250 }).toBe(false);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
