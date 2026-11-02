import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A turn whose outcome was never settled has to reach the main Agent.
 *
 * Measured 2026-11-01: 98 operations sat in "unknown" - no result, no usage, no
 * question anywhere - the oldest 44 days old. "Parked for review" is the right
 * policy; staying invisible is not, because nobody can review what nobody sees.
 *
 * This case parks one such operation on a live conversation and asserts the
 * harness hands it to main once, with the wait and the operation named, and does
 * not report the same operation again on the next pass.
 */

const replyingProvider = () => {
  const server: Server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: '收到。' }, finish_reason: null }] }));
    response.write(frame({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    response.end('data: [DONE]\n\n');
  });
  return {
    baseUrl: new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`))),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
};

test('an operation whose outcome never settled reaches main once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-unsettled-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = replyingProvider();
  const baseUrl = await provider.baseUrl;
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [],
      credentials: { local: { secretRef: 'GRAPH_UNSETTLED_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-unsettled', grade: 'high',
        api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_UNSETTLED_KEY: 'synthetic-unsettled-key' }, extraArgs: ['--execute'] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    const created = await request('/api/conversations', 'POST', { model: 'local', text: '先正常聊一句：UNSETTLED_922', requestId: 'unsettled-conversation' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;
    const anchor = ((await request(`/api/conversations/${conversationId}`)).body as { anchorTaskId: string }).anchorTaskId;

    // Park one operation the way a crashed turn leaves it: dispatched two hours
    // ago, never settled, no result.
    const dbPath = join(root, 'state/tasks.sqlite');
    const write = new DatabaseSync(dbPath);
    write.exec('PRAGMA busy_timeout=5000');
    write.prepare(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,activation_id,dispatched_at)
      VALUES(?,?,?,1,'{}','unknown',0,'crashed-activation',?)`).run('unsettled-probe-operation', anchor, 'master', Date.now() - 2 * 60 * 60 * 1000);
    write.close();

    const readDb = <T>(read: (db: DatabaseSync) => T): T => {
      const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
      try { return read(db); } finally { db.close(); }
    };
    const surfaced = async () => readDb(db => db.prepare(
      `SELECT id,kind,owner,status,data FROM questions WHERE json_extract(data,'$.operationId')='unsettled-probe-operation' ORDER BY rowid`,
    ).all() as { id: string; kind: string; owner: string; status: string; data: string }[]);

    await expect.poll(async () => (await surfaced()).length, { timeout: 120_000, interval: 500 }).toBe(1);
    const listed = await surfaced();
    const question = listed[0];
    expect(question, 'no problem was raised for the stuck operation').toBeTruthy();
    expect(question!.kind).toBe('recovery');
    expect(question!.owner).toBe('main');
    expect(question!.status).toBe('open');
    // The problem names the operation and how long it has been stuck.
    expect(question!.data).toContain('unsettle');
    expect(question!.data).toContain('2 小时');
    expect(question!.data).toContain('operationId');

    // The next pass must not report the same operation again.
    await new Promise(resolve => setTimeout(resolve, 65_000));
    expect((await surfaced()).length, 'the same operation was reported twice').toBe(1);

    // "Acknowledge" closes the problem without pretending anything ran: no new
    // operation appears and no message is re-queued for a turn nobody asked for.
    // It does end the operation, though. The decision is closed, so the next
    // pass classifies the stuck turn as abandoned instead of leaving it
    // "unknown" - which counts as busy - for ever.
    const before = readDb(db => Number((db.prepare('SELECT COUNT(*) AS count FROM operations WHERE task_id=?').get(anchor) as { count: number }).count));
    const acknowledged = await request(`/api/tasks/${anchor}/answer`, 'POST', {
      questionId: question!.id, answer: { type: 'acknowledge' }, requestId: 'acknowledge-unsettled',
    });
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
    const after = await surfaced();
    expect(after[0]?.status).toBe('resolved');
    expect(after[0]?.data, 'acknowledging rewrote the record').toContain('unsettled-probe-operation');
    const operation = () => readDb(db => db.prepare("SELECT state,settled_at FROM operations WHERE id='unsettled-probe-operation'").get() as { state: string; settled_at: number | null });
    await expect.poll(() => operation().state, { timeout: 120_000, interval: 500 }).toBe('abandoned');
    expect(operation().settled_at, 'the abandoned operation has no settlement time').not.toBeNull();
    const abandonedEvents = () => readDb(db => db.prepare("SELECT data FROM events WHERE task_id=? AND type='operation.abandoned' AND json_extract(data,'$.operationId')='unsettled-probe-operation'").all(anchor) as { data: string }[]);
    expect((await abandonedEvents()).length, 'closing the decision recorded no event').toBe(1);
    expect(readDb(db => Number((db.prepare('SELECT COUNT(*) AS count FROM operations WHERE task_id=?').get(anchor) as { count: number }).count))).toBe(before);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);

/**
 * A stuck turn is only closed after its problem was answered.
 *
 * Closing the problem used to leave the operation "unknown" for ever. Measured
 * 2026-11-02: 98 operations were parked that way, and "unknown" is one of the two
 * states that make a task look busy - the predicate core_execution_nodes.go uses
 * to refuse dispatching a master that has a queued message behind a problem. A
 * turn that died days ago could therefore keep a conversation from ever
 * answering again, and nothing in the product could close it.
 *
 * This case pins the rule in both directions: closing the decision closes the
 * operation (releasing its hold), while an operation with an open problem - or
 * one nobody was ever told about - stays parked, and the untouched one is raised
 * rather than silently closed.
 */
test('an operation is closed only after its problem was answered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-unsettled-classify-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = replyingProvider();
  const baseUrl = await provider.baseUrl;
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [],
      credentials: { local: { secretRef: 'GRAPH_UNSETTLED_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-unsettled', grade: 'high',
        api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_UNSETTLED_KEY: 'synthetic-unsettled-key' }, extraArgs: ['--execute'] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    const created = await request('/api/conversations', 'POST', { model: 'local', text: '先正常聊一句：UNSETTLED_311', requestId: 'unsettled-classify-conversation' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;
    const anchor = ((await request(`/api/conversations/${conversationId}`)).body as { anchorTaskId: string }).anchorTaskId;

    // Three turns parked the way a crashed one leaves them: sent a day and a
    // quarter ago, never settled, holding 900 tokens each. One already has an
    // answered problem, one has a problem nobody answered yet, one was never
    // raised at all.
    const dbPath = join(root, 'state/tasks.sqlite');
    const dispatchedAt = Date.now() - 30 * 60 * 60 * 1000;
    const write = new DatabaseSync(dbPath);
    write.exec('PRAGMA busy_timeout=5000');
    const park = write.prepare(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,activation_id,dispatched_at)
      VALUES(?,?,?,1,'{}','unknown',900,'crashed-activation',?)`);
    for (const id of ['closed-problem-operation', 'open-problem-operation', 'unraised-operation']) {
      park.run(id, anchor, 'master', dispatchedAt);
    }
    const raise = write.prepare(`INSERT INTO questions(id,task_id,node_id,kind,data,status,owner,asked_at)
      VALUES(?,?,?,'recovery',?,?,'main',?)`);
    raise.run('closed-problem-question', anchor, 'master', JSON.stringify({ operationId: 'closed-problem-operation', prompt: '这一轮的结果没有落定' }), 'resolved', dispatchedAt + 60_000);
    raise.run('open-problem-question', anchor, 'master', JSON.stringify({ operationId: 'open-problem-operation', prompt: '这一轮的结果没有落定' }), 'open', dispatchedAt + 60_000);
    write.close();

    const readDb = <T>(read: (db: DatabaseSync) => T): T => {
      const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
      try { return read(db); } finally { db.close(); }
    };
    const operation = (id: string) => readDb(db => db.prepare('SELECT state,reserved,settled_at FROM operations WHERE id=?').get(id) as { state: string; reserved: number; settled_at: number | null });
    const problems = (operationId: string) => readDb(db => db.prepare(`SELECT id,status FROM questions
      WHERE COALESCE(operation_id,json_extract(data,'$.operationId'))=? ORDER BY rowid`).all(operationId) as { id: string; status: string }[]);
    // The exact predicate readyNodesFor uses to decide a task is busy.
    const busy = () => readDb(db => db.prepare("SELECT COUNT(*) AS count FROM operations WHERE task_id=? AND state IN ('dispatched','unknown')").get(anchor) as { count: number }).count;

    expect(busy(), 'the stuck turns never made the task look busy').toBeGreaterThan(0);

    // The answered problem ends its operation: the hold is released and the
    // fact is recorded, not erased.
    await expect.poll(() => operation('closed-problem-operation').state, { timeout: 120_000, interval: 500 }).toBe('abandoned');
    const closed = operation('closed-problem-operation');
    expect(closed.settled_at, 'the abandoned operation has no settlement time').not.toBeNull();
    expect(closed.reserved, 'the abandoned operation still holds its reservation').toBe(0);
    expect(readDb(db => db.prepare("SELECT COUNT(*) AS count FROM events WHERE task_id=? AND type='operation.abandoned' AND json_extract(data,'$.operationId')='closed-problem-operation'").get(anchor) as { count: number }).count).toBe(1);

    // An open problem is still somebody's decision: that operation stays parked.
    expect(operation('open-problem-operation').state, 'an operation was closed while its problem was still open').toBe('unknown');
    // An operation nobody was told about is raised instead of closed.
    expect(operation('unraised-operation').state).toBe('unknown');
    await expect.poll(() => problems('unraised-operation').length, { timeout: 120_000, interval: 500 }).toBe(1);
    expect(problems('unraised-operation')[0]!.status).toBe('open');
    expect(operation('unraised-operation').state, 'raising the problem closed the operation').toBe('unknown');

    // Answering the open problem closes the loop for its operation too.
    const answered = await request(`/api/tasks/${anchor}/answer`, 'POST', {
      questionId: 'open-problem-question', answer: { type: 'acknowledge' }, requestId: 'acknowledge-open-problem',
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await expect.poll(() => operation('open-problem-operation').state, { timeout: 120_000, interval: 500 }).toBe('abandoned');
    const stillBusy = () => readDb(db => db.prepare("SELECT id FROM operations WHERE task_id=? AND state IN ('dispatched','unknown')").all(anchor) as { id: string }[]).map(row => row.id);
    expect(stillBusy(), 'a closed operation still makes the task look busy').not.toContain('closed-problem-operation');
    expect(stillBusy(), 'a closed operation still makes the task look busy').not.toContain('open-problem-operation');
    expect(operation('unraised-operation').state, 'an unraised operation was closed with the others').toBe('unknown');
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
