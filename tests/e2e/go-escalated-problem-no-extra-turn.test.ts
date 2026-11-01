import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * Handing a problem to the person must not run the failed turn a second time.
 *
 * Measured 2026-11-01: after a master turn failed and the unattended sweep
 * handed the problem over, the provider sometimes received the same request
 * again - the last user message was identical. The cause was the sweep itself:
 * re-owning the question to the person made the master stop looking parked, so
 * it took a turn with nothing to answer, and that turn re-sent the whole
 * transcript. The fix keys "parked" on the question kind instead of its owner;
 * this case is the keeper that would have caught it: with the owner-keyed
 * version restored it fails with two identical requests.
 *
 * The provider refuses every turn (a content failure, so nothing retries on its
 * own) and records each request, so a second request is impossible to miss.
 */

const refusingProvider = () => {
  const requests: { at: number; lastUser: string }[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    let lastUser = '';
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages?: { role?: string; content?: unknown }[] };
      const mine = (body.messages ?? []).filter(message => message.role === 'user');
      const last = mine[mine.length - 1];
      lastUser = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    } catch { /* a request we cannot parse still counts */ }
    requests.push({ at: Date.now(), lastUser });
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'the model refused this task', type: 'invalid_request_error' } }));
  });
  return {
    requests,
    baseUrl: new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`))),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
};

test('an escalated problem never re-runs the failed turn by itself', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-escalated-no-rerun-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = refusingProvider();
  const baseUrl = await provider.baseUrl;
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [],
      credentials: { local: { secretRef: 'GRAPH_ESCALATED_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-escalated', grade: 'high',
        api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_ESCALATED_KEY: 'synthetic-escalated-key' }, extraArgs: ['--execute'] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    const dbPath = join(root, 'state/tasks.sqlite');
    const readDb = <T>(read: (db: DatabaseSync) => T): T => {
      const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
      try { return read(db); } finally { db.close(); }
    };

    const asked = '把这句话原样再答一次：ESCALATED_911';
    const created = await request('/api/conversations', 'POST', { model: 'local', text: asked, requestId: 'escalated-conversation' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    const problem = async () => readDb(db => db.prepare(
      "SELECT id,kind,owner,status FROM questions WHERE task_id=(SELECT anchor_task_id FROM conversations WHERE id=?) AND status='open' ORDER BY rowid LIMIT 1",
    ).get(conversationId) as { id: string; kind: string; owner: string; status: string } | undefined);
    await expect.poll(async () => (await problem())?.kind, { timeout: 90_000, interval: 250 }).toBe('execution_failed');
    const failure = await problem();
    expect(provider.requests.length, 'the first turn did not reach the provider').toBe(1);

    // Past the deadline the harness hands the problem to the person.
    const write = new DatabaseSync(dbPath);
    write.exec('PRAGMA busy_timeout=5000');
    write.prepare('UPDATE questions SET asked_at=? WHERE id=?').run(Date.now() - 90 * 60 * 1000, failure!.id);
    write.close();
    await expect.poll(async () => (await problem())?.owner, { timeout: 120_000, interval: 500 }).toBe('user');

    // The hand-over is not a retry: nothing runs until the person answers.
    await new Promise(resolve => setTimeout(resolve, 5_000));
    expect(provider.requests.length, `the escalation re-ran the turn: ${JSON.stringify(provider.requests.map(r => r.lastUser.slice(0, 40)))}`).toBe(1);
    const first = provider.requests[0];
    expect(first, 'no request was recorded at all').toBeTruthy();
    expect(first!.lastUser).toContain('ESCALATED_911');
    expect((await problem())?.status).toBe('open');
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
