import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A project supervisor's own failure reaches the global supervisor, not the
 * person.
 *
 * The person asked for exactly this: problems inside a project must land in the
 * global main's interface first, and only what the global main cannot resolve
 * reaches them. The routing ladder already exists (project → global → user);
 * what was missing was the first rung for an unrouted problem: a failed project
 * supervisor turn went straight to the person after the deadline.
 *
 * This drives the real daemon: the project thread's turn fails for a reason
 * that is not the environment, the problem is parked on the project supervisor
 * (the one Agent that cannot answer it), and past the deadline the harness
 * routes it to the global supervisor and wakes it. The person is not asked.
 */

const failingProvider = () => {
  const requests: { at: number }[] = [];
  const server: Server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    requests.push({ at: Date.now() });
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'the model refused this task', type: 'invalid_request_error' } }));
  });
  return {
    requests,
    baseUrl: new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`))),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
};

test('a project supervisor failure is routed to the global supervisor, not the person', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-problem-global-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await mkdir(join(root, 'project'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = failingProvider();
  const baseUrl = await provider.baseUrl;
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: join(root, 'project') }],
      credentials: { local: { secretRef: 'GRAPH_PROBLEM_GLOBAL_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'main', provider: 'graph-problem', grade: 'high',
        api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_PROBLEM_GLOBAL_KEY: 'synthetic-problem-key' }, extraArgs: ['--execute'] });
    async function request(path: string, method = 'GET', data?: unknown) {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }
    const dbPath = join(root, 'state/tasks.sqlite');
    const readDb = <T>(read: (db: DatabaseSync) => T): T => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { return read(db); } finally { db.close(); }
    };

    // The global supervisor first: it is the target of the routing.
    const global = await request('/api/orchestration/global', 'POST', { requestId: 'global-thread' });
    expect(global.status, JSON.stringify(global.body)).toBe(200);
    const globalTaskId = (global.body as { taskId: string }).taskId;

    // A project supervisor thread, then one turn that fails.
    const thread = await request('/api/projects/p/thread', 'POST', { requestId: 'project-thread' });
    expect(thread.status, JSON.stringify(thread.body)).toBe(200);
    const projectConversation = (thread.body as { conversationId: string }).conversationId;
    const projectTaskId = (thread.body as { taskId: string }).taskId;
    const sent = await request(`/api/conversations/${projectConversation}/messages`, 'POST', {
      text: '做一件会被拒绝的事。', requestId: 'project-first',
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);

    const projectProblem = async () => readDb(db => db.prepare(
      "SELECT id,kind,owner,status,route_stage,asked_at FROM questions WHERE task_id=? AND status='open' AND owner='main' ORDER BY rowid LIMIT 1",
    ).get(projectTaskId) as { id: string; kind: string; owner: string; route_stage?: string; asked_at: number } | undefined);
    await expect.poll(async () => (await projectProblem())?.kind, { timeout: 90_000, interval: 250 }).toBe('execution_failed');
    const failure = await projectProblem();

    // Past the deadline the problem moves up to the global supervisor. The
    // person is not asked: the question stays main-owned and routed to global.
    const write = new DatabaseSync(dbPath);
    write.exec('PRAGMA busy_timeout=5000');
    write.prepare('UPDATE questions SET asked_at=? WHERE id=?').run(Date.now() - 90 * 60 * 1000, failure!.id);
    write.close();

    await expect.poll(async () => (await projectProblem())?.route_stage, { timeout: 120_000, interval: 500 }).toBe('global');
    const routed = await projectProblem();
    expect(routed?.owner, 'the person was asked about a project supervisor failure').toBe('main');
    expect(routed?.kind).toBe('execution_failed');

    // And the global supervisor really was woken for it, with its revision.
    const wake = readDb(db => db.prepare(
      "SELECT kind,dedupe_key,data FROM wake_intents WHERE task_id=? AND kind='supervisor_question' ORDER BY id DESC LIMIT 1",
    ).get(globalTaskId) as { kind: string; dedupe_key: string; data?: string } | undefined);
    expect(wake, 'the global supervisor was not woken').toBeTruthy();
    expect(String(wake?.data ?? '')).toContain(failure!.id);
    expect(String(wake?.dedupe_key ?? '')).toContain(':');

    // The project supervisor is still parked on its own failure: the handoff is
    // a decision for the global supervisor, not a silent retry.
    expect(provider.requests.length).toBeGreaterThan(0);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
