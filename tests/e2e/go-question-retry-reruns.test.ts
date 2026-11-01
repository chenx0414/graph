import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * Answering "retry" on a failed turn has to run that turn again.
 *
 * Measured 2026-11-01: answering retry on a failed *master* turn returned 200,
 * resolved the question, put the node back to pending - and nothing ever called
 * the provider again. The retry a person can click and the retry the product
 * performs were two different things, which is worse than having no button.
 *
 * Two failures sat behind that one symptom: the retry never re-queued the turn's
 * own message, so the next turn had nothing to answer; and the unattended sweep
 * re-owning the question to the person stopped the master looking parked, so it
 * took a turn of its own and its failure parked the retry the person had asked
 * for. Both are asserted here through the real daemon.
 */

interface ProviderMessage { role?: string; content?: unknown }

const flakyProvider = () => {
  const requests: { messages: ProviderMessage[] }[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    let messages: ProviderMessage[] = [];
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages?: ProviderMessage[] };
      messages = body.messages ?? [];
    } catch { /* a request we cannot parse still counts as a request */ }
    requests.push({ messages });
    if (requests.length === 1) {
      // A content failure: the harness must not retry it on its own, the
      // decision belongs to the person.
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'the model refused this task', type: 'invalid_request_error' } }));
      return;
    }
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: '收到，继续。' }, finish_reason: null }] }));
    response.write(frame({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } }));
    response.end('data: [DONE]\n\n');
  });
  return {
    requests,
    baseUrl: new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`))),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
};

function userTexts(request: { messages: ProviderMessage[] }): string[] {
  return request.messages
    .filter(message => message.role === 'user')
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''));
}

test('answering retry on a failed turn runs that turn again, once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-question-retry-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = flakyProvider();
  const baseUrl = await provider.baseUrl;
  const asked = '把这句话原样再答一次：RETRY_ME_901';
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [],
      credentials: { local: { secretRef: 'GRAPH_RETRY_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-retry', grade: 'high',
        api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_RETRY_KEY: 'synthetic-retry-key' }, extraArgs: ['--execute'] });
    async function request(path: string, method = 'GET', data?: unknown) {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }
    const dbPath = join(root, 'state/tasks.sqlite');
    const readDb = <T>(read: (db: DatabaseSync) => T): T => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { return read(db); } finally { db.close(); }
    };

    const created = await request('/api/conversations', 'POST', { model: 'local', text: asked, requestId: 'retry-conversation' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    const problem = async () => readDb(db => db.prepare(
      "SELECT id,kind,owner,status FROM questions WHERE status='open' AND owner='main' ORDER BY rowid LIMIT 1",
    ).get() as { id: string; kind: string } | undefined);
    await expect.poll(async () => (await problem())?.kind, { timeout: 90_000, interval: 250 }).toBe('execution_failed');
    const failure = await problem();

    // Let any duplicate of the failed turn land before measuring, so the count
    // below describes the retry and not a repeated delivery.
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const baseline = provider.requests.length;
    expect(baseline, 'the first turn never reached the provider').toBeGreaterThan(0);

    const anchor = ((await request(`/api/conversations/${conversationId}`)).body as { anchorTaskId: string }).anchorTaskId;
    const answered = await request(`/api/tasks/${anchor}/answer`, 'POST', {
      questionId: failure!.id, answer: { type: 'retry' }, requestId: 'retry-answer',
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);

    // The user-visible promise of the button: the same request is answered
    // again. A wake-only turn would arrive with no user message at all.
    await expect.poll(() => provider.requests.length, { timeout: 60_000, interval: 250 }).toBe(baseline + 1);
    const retried = provider.requests[provider.requests.length - 1];
    expect(retried, 'the retried turn never reached the provider').toBeTruthy();
    expect(userTexts(retried!), 'the retried turn carried no user message').toContainEqual(expect.stringContaining('RETRY_ME_901'));

    // One retry is one turn: nothing may loop on the answered question.
    await new Promise(resolve => setTimeout(resolve, 3_000));
    expect(provider.requests.length, 'the retry kept calling the provider').toBe(baseline + 1);
    const resolved = readDb(db => db.prepare('SELECT status,answer FROM questions WHERE id=?').get(failure!.id) as { status: string; answer: string });
    expect(resolved.status).toBe('resolved');
    expect(JSON.parse(resolved.answer).type).toBe('retry');
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);

test('answering retry on an escalated problem also runs that turn again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-question-retry-escalated-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = flakyProvider();
  const baseUrl = await provider.baseUrl;
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [],
      credentials: { local: { secretRef: 'GRAPH_RETRY_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-retry', grade: 'high',
        api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_RETRY_KEY: 'synthetic-retry-key' }, extraArgs: ['--execute'] });
    async function request(path: string, method = 'GET', data?: unknown) {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }
    const dbPath = join(root, 'state/tasks.sqlite');
    const readDb = <T>(read: (db: DatabaseSync) => T): T => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { return read(db); } finally { db.close(); }
    };
    const created = await request('/api/conversations', 'POST', { model: 'local', text: '第二件会被拒绝的事：RETRY_ME_902', requestId: 'retry-escalated' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;
    const problem = async () => readDb(db => db.prepare(
      "SELECT id,kind,owner,status FROM questions WHERE status='open' ORDER BY rowid LIMIT 1",
    ).get() as { id: string; kind: string; owner: string } | undefined);
    await expect.poll(async () => (await problem())?.kind, { timeout: 90_000, interval: 250 }).toBe('execution_failed');
    const failure = await problem();
    const write = new DatabaseSync(dbPath);
    write.exec('PRAGMA busy_timeout=5000');
    write.prepare('UPDATE questions SET asked_at=? WHERE id=?').run(Date.now() - 90 * 60 * 1000, failure!.id);
    write.close();
    await expect.poll(async () => (await problem())?.owner, { timeout: 120_000, interval: 500 }).toBe('user');
    // The escalation must not release the master: nothing may run between the
    // hand-over and the person's answer.
    const quiet = provider.requests.length;
    await new Promise(resolve => setTimeout(resolve, 3_000));
    expect(provider.requests.length, 'the escalated turn ran without the person answering').toBe(quiet);
    const anchor = ((await request(`/api/conversations/${conversationId}`)).body as { anchorTaskId: string }).anchorTaskId;
    const answered = await request(`/api/tasks/${anchor}/answer`, 'POST', {
      questionId: failure!.id, answer: { type: 'retry' }, requestId: 'retry-answer-escalated',
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await expect.poll(() => provider.requests.length, { timeout: 60_000, interval: 250 }).toBe(quiet + 1);
    const retried = provider.requests[provider.requests.length - 1];
    expect(retried, 'the retried turn never reached the provider').toBeTruthy();
    expect(userTexts(retried!)).toContainEqual(expect.stringContaining('RETRY_ME_902'));
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);

test('a problem card can also keep waiting and stop the task, recoverably', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-problem-actions-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = flakyProvider();
  const baseUrl = await provider.baseUrl;
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [],
      credentials: { local: { secretRef: 'GRAPH_RETRY_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-retry', grade: 'high',
        api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_RETRY_KEY: 'synthetic-retry-key' }, extraArgs: ['--execute'] });
    async function request(path: string, method = 'GET', data?: unknown) {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }
    const dbPath = join(root, 'state/tasks.sqlite');
    const readDb = <T>(read: (db: DatabaseSync) => T): T => {
      const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
      try { return read(db); } finally { db.close(); }
    };
    const created = await request('/api/conversations', 'POST', { model: 'local', text: '第三件会被拒绝的事：ACTIONS_903', requestId: 'problem-actions' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;
    const problem = async () => readDb(db => db.prepare(
      "SELECT id,kind,asked_at FROM questions WHERE status='open' ORDER BY rowid LIMIT 1",
    ).get() as { id: string; kind: string; asked_at: number } | undefined);
    await expect.poll(async () => (await problem())?.kind, { timeout: 90_000, interval: 250 }).toBe('execution_failed');
    const failure = await problem();
    const anchor = ((await request(`/api/conversations/${conversationId}`)).body as { anchorTaskId: string }).anchorTaskId;
    const before = provider.requests.length;

    // Keep waiting: the problem stays open, the clock starts over, and nothing
    // runs behind the person's back.
    const waited = await request(`/api/tasks/${anchor}/answer`, 'POST', {
      questionId: failure!.id, answer: { type: 'wait' }, requestId: 'answer-wait',
    });
    expect(waited.status, JSON.stringify(waited.body)).toBe(200);
    const afterWait = await problem();
    expect(afterWait?.id, 'keep-waiting closed the question').toBe(failure!.id);
    expect(afterWait!.asked_at, 'keep-waiting did not restart the wait').toBeGreaterThan(failure!.asked_at);
    expect(provider.requests.length, 'keep-waiting ran a turn').toBe(before);

    // Stop the task: the question closes, the task is paused, and the pause is
    // the recoverable one - resuming works.
    const paused = await request(`/api/tasks/${anchor}/answer`, 'POST', {
      questionId: failure!.id, answer: { type: 'pause' }, requestId: 'answer-pause',
    });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    const resolved = readDb(db => db.prepare('SELECT status,answer FROM questions WHERE id=?').get(failure!.id) as { status: string; answer: string });
    expect(resolved.status).toBe('resolved');
    expect(JSON.parse(resolved.answer).type).toBe('pause');
    const pausedFlag = async () => (((await request(`/api/tasks/${anchor}`)).body as { paused?: boolean }).paused ?? false);
    await expect.poll(pausedFlag, { timeout: 30_000, interval: 200 }).toBe(true);

    const resumed = await request(`/api/tasks/${anchor}/resume`, 'POST', { requestId: 'resume-after-pause' });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    await expect.poll(pausedFlag, { timeout: 30_000, interval: 200 }).toBe(false);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
