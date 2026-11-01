import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A problem nobody acted on must not stay invisible for ever.
 *
 * The product deliberately never retries a failure nobody asked about: a retry
 * spends model calls the failure did not earn. That rule is right, and on its
 * own it means a problem can sit in main's own list for ever - measured
 * 2026-11-01, three execution failures had been parked since the morning with
 * nothing but "owner: main" to distinguish them from work in progress.
 *
 * This case drives the real daemon: the Agent's own turn fails in a way that is
 * not an environment problem (so nothing retries it), the failure is parked on
 * the very Agent that cannot act on it, and after the deadline the harness hands
 * the decision to the person. The test then proves the harness's own retry never
 * fired: handing the problem over is not a retry.
 */

interface ProviderTool { function?: { name?: string } }
interface ProviderBody { tools?: ProviderTool[]; messages?: { role?: string; content?: unknown }[] }

const failingProvider = () => {
  const requests: { master: boolean }[] = [];
  const server: Server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    requests.push({ master: true });
    // A turn that fails for a reason that is not the environment: the harness
    // must not retry it, it has to hand the decision to someone.
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'the model refused this task', type: 'invalid_request_error' } }));
  });
  return {
    requests,
    baseUrl: new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`))),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
};

test('a problem nobody acted on reaches the person, and nothing is retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-problem-escalation-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = failingProvider();
  const baseUrl = await provider.baseUrl;
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [],
      credentials: { local: { secretRef: 'GRAPH_PROBLEM_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-problem', grade: 'high',
        api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_PROBLEM_KEY: 'synthetic-problem-key' }, extraArgs: ['--execute'] });
    async function request(path: string, method = 'GET', data?: unknown) {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }
    const dbPath = join(root, 'state/tasks.sqlite');
    const readDb = <T>(read: (db: DatabaseSync) => T): T => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { return read(db); } finally { db.close(); }
    };

    const created = await request('/api/conversations', 'POST', { model: 'local', text: '做一件会被拒绝的事。', requestId: 'problem-conversation' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    // The Agent's own turn failed, so the problem is parked on main: nothing can
    // retry it on its own, and nothing puts it in front of the person either.
    const problem = async () => readDb(db => db.prepare(
      "SELECT id,kind,owner,status,asked_at FROM questions WHERE status='open' AND owner='main' ORDER BY rowid LIMIT 1",
    ).get() as { id: string; kind: string; owner: string; asked_at: number } | undefined);
    try {
      await expect.poll(async () => (await problem())?.kind, { timeout: 90_000, interval: 250 }).toBe('execution_failed');
    } catch {
      const events = await request(`/api/conversations/${conversationId}/events?after=0&limit=200`);
      const lines = (Array.isArray(events.body) ? events.body : []).slice(-25)
        .map((event: { cursor?: number; type?: string; data?: unknown }) => `${event.cursor ?? '?'} ${event.type ?? '?'} ${JSON.stringify(event.data ?? {}).slice(0, 200)}`);
      const questions = readDb(db => db.prepare('SELECT id,kind,owner,status FROM questions').all());
      expect(false, `questions: ${JSON.stringify(questions)}\nevents:\n${lines.join('\n')}\ndaemon:\n${daemon?.stderr ?? ''}`).toBe(true);
    }
    const failure = await problem();

    // Past the deadline the harness hands it to the person.
    const write = new DatabaseSync(dbPath);
    write.exec('PRAGMA busy_timeout=5000');
    write.prepare('UPDATE questions SET asked_at=? WHERE id=?').run(Date.now() - 90 * 60 * 1000, failure!.id);
    write.close();

    const escalated = async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      const questions = ((view.body as { questions?: { id: string; kind: string; owner?: string; data?: Record<string, unknown> }[] }).questions) ?? [];
      return questions.find(question => question.kind === 'waiting' && question.data?.escalatedFrom === 'execution_failed');
    };
    let reached = false;
    try {
      await expect.poll(async () => Boolean(await escalated()), { timeout: 120_000, interval: 500 }).toBe(true);
      reached = true;
    } catch { reached = false; }
    if (!reached) {
      const events = await request(`/api/conversations/${conversationId}/events?after=0&limit=200`);
      const lines = (Array.isArray(events.body) ? events.body : []).slice(-25)
        .map((event: { cursor?: number; type?: string; data?: unknown }) => `${event.cursor ?? '?'} ${event.type ?? '?'} ${JSON.stringify(event.data ?? {}).slice(0, 160)}`);
      const questions = readDb(db => db.prepare('SELECT id,kind,owner,status,asked_at FROM questions').all());
      expect(reached, `questions: ${JSON.stringify(questions)}\nevents:\n${lines.join('\n')}\ndaemon:\n${daemon?.stderr ?? ''}`).toBe(true);
    }

    // The decision is the person's, and the harness's own retry never fired:
    // handing the problem over is not a retry.
    const question = await escalated();
    expect(question?.data?.requestType).toBe('noncompliance_decision');
    expect(String(question?.data?.prompt ?? '')).toMatch(/已经等了 \d+ 分钟/);
    expect(question?.owner ?? 'user').toBe('user');
    const events = await request(`/api/conversations/${conversationId}/events?after=0&limit=300`);
    expect(JSON.stringify(events.body)).not.toContain('node.transient_retry');
    const original = readDb(db => db.prepare('SELECT status,answer FROM questions WHERE id=?').get(failure!.id) as { status: string; answer: string });
    expect(original.status).toBe('resolved');
    expect(JSON.parse(original.answer).type).toBe('escalated');
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300000);
