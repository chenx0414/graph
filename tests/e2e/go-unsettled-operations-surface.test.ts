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

    // "Acknowledge" closes the problem without pretending anything ran: the
    // operation stays unknown, no new operation appears, and no message is
    // re-queued for a turn nobody asked for.
    const before = readDb(db => Number((db.prepare('SELECT COUNT(*) AS count FROM operations WHERE task_id=?').get(anchor) as { count: number }).count));
    const acknowledged = await request(`/api/tasks/${anchor}/answer`, 'POST', {
      questionId: question!.id, answer: { type: 'acknowledge' }, requestId: 'acknowledge-unsettled',
    });
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
    const after = await surfaced();
    expect(after[0]?.status).toBe('resolved');
    expect(after[0]?.data, 'acknowledging rewrote the record').toContain('unsettled-probe-operation');
    expect(readDb(db => (db.prepare("SELECT state FROM operations WHERE id='unsettled-probe-operation'").get() as { state: string }).state)).toBe('unknown');
    expect(readDb(db => Number((db.prepare('SELECT COUNT(*) AS count FROM operations WHERE task_id=?').get(anchor) as { count: number }).count))).toBe(before);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
