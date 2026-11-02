import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * An ask_user question nobody came back to takes the asker's recommended option.
 *
 * The person is often away, and a question that blocks the work for ever is
 * worse than one that proceeds the way the asker said it would. What this case
 * pins down: only ask_user questions with options take part, the choice is the
 * recommended one, it happens once, the conversation says who chose what, and
 * the turn resumes with that answer in front of it.
 */

const askingProvider = () => {
  const requests: { lastUser: string }[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    let messages: { role?: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }[] = [];
    try {
      messages = (JSON.parse(Buffer.concat(chunks).toString()) as { messages?: typeof messages }).messages ?? [];
    } catch { /* a request we cannot parse still counts */ }
    const users = messages.filter(message => message.role === 'user');
    const last = users[users.length - 1];
    requests.push({ lastUser: typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '') });
    const asked = messages.some(message => (message.tool_calls ?? []).some(call => call.function?.name === 'ask_user'));
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!asked) {
      response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'ask-1', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({
        prompt: '用哪个数据库？', why: '决定后面所有取数代码。',
        options: ['Postgres（推荐）', 'SQLite'], recommended: 'Postgres（推荐）', requestId: 'ask-db',
      }) } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 8 } }));
    } else {
      response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: '收到，按这个继续。' }, finish_reason: null }] }));
      response.write(frame({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
    }
    response.end('data: [DONE]\n\n');
  });
  return {
    requests,
    baseUrl: new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`))),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
};

test('an unanswered ask_user takes the recommended option once, and says so', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-auto-answer-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = askingProvider();
  const baseUrl = await provider.baseUrl;
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [],
      credentials: { local: { secretRef: 'GRAPH_AUTO_ANSWER_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-auto-answer', grade: 'high',
        api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_AUTO_ANSWER_KEY: 'synthetic-auto-answer-key' }, extraArgs: ['--execute'] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    const dbPath = join(root, 'state/tasks.sqlite');
    const readDb = <T>(read: (db: DatabaseSync) => T): T => {
      const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
      try { return read(db); } finally { db.close(); }
    };

    const created = await request('/api/conversations', 'POST', { model: 'local', text: '帮我选个数据库', requestId: 'auto-answer-conversation' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;
    const asked = async () => readDb(db => db.prepare(
      "SELECT id,status,answer,data,asked_at FROM questions WHERE status='open' AND kind='waiting' ORDER BY rowid LIMIT 1",
    ).get() as { id: string; status: string; answer: string | null; data: string; asked_at: number } | undefined);
    await expect.poll(async () => (await asked())?.id, { timeout: 90_000, interval: 250 }).toBeTruthy();
    const question = (await asked())!;

    // The question waited longer than the deadline; nothing has answered it yet.
    const write = new DatabaseSync(dbPath);
    write.exec('PRAGMA busy_timeout=5000');
    write.prepare('UPDATE questions SET asked_at=? WHERE id=?').run(Date.now() - 6 * 60 * 1000, question.id);
    write.close();

    const resolved = async () => readDb(db => db.prepare('SELECT status,answer,data FROM questions WHERE id=?').get(question.id) as { status: string; answer: string | null; data: string });
    await expect.poll(async () => (await resolved()).status, { timeout: 120_000, interval: 500 }).toBe('resolved');
    const answered = await resolved();
    expect(JSON.parse(answered.answer ?? '{}')).toMatchObject({ type: 'respond', value: 'Postgres（推荐）' });
    expect(answered.data, 'the question does not record that it answered itself').toContain('autoAnsweredAt');

    // The turn resumed with that answer, and the conversation says who chose it.
    await expect.poll(() => provider.requests.length, { timeout: 60_000, interval: 250 }).toBeGreaterThan(1);
    const resumedRequest = provider.requests[provider.requests.length - 1];
    expect(resumedRequest, 'no follow-up request was made').toBeTruthy();
    expect(resumedRequest!.lastUser, 'the resumed turn did not carry the auto answer').toContain('Postgres（推荐）');
    const messages = readDb(db => db.prepare("SELECT text FROM messages WHERE conversation_id=? AND role='system' ORDER BY seq DESC LIMIT 3").all(conversationId) as { text: string }[]);
    expect(messages.map(message => message.text).join('\n')).toContain('已按推荐选项「Postgres（推荐）」继续');
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
