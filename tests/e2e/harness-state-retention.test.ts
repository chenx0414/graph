import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * The daemon reclaims the state it will not need again.
 *
 * The reclaim rules existed, but only as an offline tool: it takes the
 * daemon's owner lock, so it refuses to run against a state a running Graph
 * owns. A daemon that ran for days therefore kept every event it ever
 * wrote, and the state of every run before it grew for ever.
 *
 * The rules are the same ones the offline tool uses, and the environment may
 * narrow them.
 */

interface ProviderMessage { role?: string; content?: unknown }

/** The events one task holds, and how many of them the rules may keep. */
function taskEvents(database: string, taskId: string): { total: number; keepable: number } {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const total = (db.prepare('SELECT COUNT(*) AS n FROM events WHERE task_id=?').get(taskId) as { n: number }).n;
    const keepable = (db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE task_id=? AND type NOT IN ('task.created','requirement.changed')",
    ).get(taskId) as { n: number }).n;
    return { total, keepable };
  } finally { db.close(); }
}

test('the daemon reclaims the state of the runs before it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-state-retention-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), '# State retention\n');
  const provider = await openaiServer([
    { tools: [{ id: 'write-proof', name: 'write', arguments: JSON.stringify({ path: 'proof.txt', content: 'proof' }) }] },
    { text: 'The proof is written.' },
  ]);
  const database = join(root, 'state/tasks.sqlite');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_RETENTION_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high',
      api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 512,
      credentialId: 'local' }] },
  }));
  const env = {
    GRAPH_RETENTION_KEY: 'synthetic-retention-key',
    GRAPH_STATE_RETENTION_MIN_AGE_MS: '0',
    GRAPH_STATE_RETENTION_KEEP_EVENTS: '5',
  };
  const writing = { ...env, GRAPH_STATE_SWEEP_INTERVAL_MS: '600000' };
  const reclaiming = { ...env, GRAPH_STATE_SWEEP_INTERVAL_MS: '500' };
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    daemon = await launchCli(root, { configPath, env: writing, extraArgs: ['--execute'] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Write the proof file.', requestId: 'retention-1',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      return (view.body as { master?: { status?: string } }).master?.status;
    }, { timeout: 60000, interval: 250 }).toBe('succeeded');
    const view = (await request(`/api/conversations/${conversationId}`)).body as { anchorTaskId?: string };
    const taskId = view.anchorTaskId ?? '';
    expect(taskId, 'the conversation has no task').toBeTruthy();

    // The run wrote more events than the rules keep.
    const written = taskEvents(database, taskId);
    expect(written.keepable, `the run wrote ${written.keepable} events, too few to tell a sweep from no sweep`).toBeGreaterThan(5);

    // The next run reclaims what this one left behind.
    daemon.child.kill('SIGKILL');
    await daemon.close();
    daemon = await launchCli(root, { configPath, env: reclaiming, extraArgs: ['--execute'] });
    await expect.poll(() => taskEvents(database, taskId).keepable, { timeout: 30000, interval: 250 }).toBeLessThanOrEqual(5);
    const reclaimed = taskEvents(database, taskId);
    expect(reclaimed.keepable, 'the daemon kept more events than the rules allow').toBeLessThanOrEqual(5);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
