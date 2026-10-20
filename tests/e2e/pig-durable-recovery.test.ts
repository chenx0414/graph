import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// The PiG kernel has to carry the recovery the TypeScript sidecar used to
// carry, because the default kernel cannot move until it does.
//
// Two facts decide whether a crashed turn can be recovered, and they are the
// facts the kernel keeps: whether the kernel finished the turn, and whether
// the Graph ever heard about it. A turn the kernel finished but the Graph did
// not confirm is settled from the kernel's own receipt, without asking the
// model again. A turn that never reached the model is sent again, with the
// configuration it was admitted with, not the configuration the catalog
// happens to hold now.
//
// A turn that was already at the provider when the daemon died is neither:
// replaying it would spend the credential twice and repeat the side effects.
test('the PiG kernel settles a completed turn whose Graph acknowledgement died', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-recovery-ack-'));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const provider = await openaiServer([
    { text: 'The first answer.', usage: { prompt_tokens: 20, completion_tokens: 5 } },
    { text: 'Completed before the Graph acknowledgement.', usage: { prompt_tokens: 60, completion_tokens: 10 } },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const configPath = join(root, 'graph.config.json');
  try {
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_PIG_RECOVERY_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
    const start = () => launchCli(root, { configPath, env: { GRAPH_PIG_RECOVERY_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'pig'] });
    daemon = await start();
    const created = await daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Answer the first question.', requestId: 'first' }) });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    const view = async () => await (await daemon!.request(`/api/conversations/${conversationId}`)).json();
    await expect.poll(async () => (await view()).master?.status, { timeout: 30000 }).toBe('succeeded');

    // The Graph cannot record the outcome of the next turn. The kernel still
    // finishes it: the turn is the kernel's, and only the acknowledgement is
    // the Graph's.
    const database = join(root, 'state/tasks.sqlite');
    const fault = new DatabaseSync(database);
    fault.exec("PRAGMA busy_timeout=5000; CREATE TRIGGER reject_graph_ack BEFORE UPDATE OF result ON operations WHEN NEW.result IS NOT NULL BEGIN SELECT RAISE(ABORT, 'E2E storage acknowledgement failure'); END");
    fault.close();
    const pending = await daemon.request(`/api/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Finish this reply despite an interrupted acknowledgement.', requestId: 'second' }) });
    expect(pending.status).toBe(200);
    // The kernel finished the turn even though the Graph could not hear it.
    await expect.poll(() => {
      const db = new DatabaseSync(database, { readOnly: true });
      try { return db.prepare("SELECT COUNT(*) AS count FROM graph_durable_submissions WHERE status='done'").get()!.count; }
      finally { db.close(); }
    }, { timeout: 30000 }).toBe(2);
    daemon.child.kill('SIGKILL');
    await daemon.close();
    const repair = new DatabaseSync(database);
    repair.exec('PRAGMA busy_timeout=5000; DROP TRIGGER reject_graph_ack');
    repair.close();

    daemon = await start();
    // The daemon settles the operation from the kernel's own receipt. The
    // model is not asked again: the answer already exists.
    await expect.poll(async () => (await view()).messages.filter((message: { role: string }) => message.role === 'assistant').at(-1)?.text, { timeout: 30000 })
      .toContain('Completed before the Graph acknowledgement.');
    expect(provider.requests).toHaveLength(2);
    await expect.poll(async () => (await view()).master?.status, { timeout: 30000 }).toBe('succeeded');
    // The recovery settles the interrupted turn; it does not add a turn.
    const answers = (await view()).messages.filter((message: { role: string }) => message.role === 'assistant');
    expect(answers).toHaveLength(2);
    expect(answers.at(-1)?.text).toContain('Completed before the Graph acknowledgement.');
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

test('the PiG kernel restores an admitted input before its first send and leaves other conversations usable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-recovery-unsent-'));
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<div>Graph</div>');
  const provider = await openaiServer([
    { text: 'In flight when the owner died', holdBeforeUsage: true },
    { text: 'Original admitted input recovered', usage: { prompt_tokens: 25, completion_tokens: 5 } },
    { text: 'Another conversation remains usable', usage: { prompt_tokens: 30, completion_tokens: 5 } },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }],
      credentials: { local: { secretRef: 'GRAPH_PIG_RECOVERY_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local',
        headers: { Authorization: 'Bearer durable-header-only' } }] } }));
    const start = () => launchCli(root, { configPath, env: { GRAPH_PIG_RECOVERY_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'pig'] });
    daemon = await start();
    const create = async (text: string, requestId: string) => {
      const reply = await daemon!.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text, requestId }) });
      expect(reply.status).toBe(200);
      return (await reply.json()).conversationId as string;
    };
    const uncertain = await create('Keep this model request open.', 'occupy-slot');
    await expect.poll(() => provider.requests.length, { timeout: 20000 }).toBe(1);
    const waiting = await create('Recover this original input.', 'admit-original');
    const inspect = () => {
      const db = new DatabaseSync(join(root, 'state/tasks.sqlite'), { readOnly: true });
      try {
        const row = db.prepare(`SELECT o.id,json_extract(o.spec,'$.attempt') AS attempt,o.state FROM operations o JOIN conversations c ON c.anchor_task_id=o.task_id WHERE c.id=? AND json_extract(o.spec,'$.kind')='agent' ORDER BY o.rowid DESC LIMIT 1`).get(waiting)! as { id: string; attempt: number; state: string };
        return { ...row, calls: db.prepare('SELECT COUNT(*) AS n FROM invocations WHERE operation_id=?').get(row.id)!.n,
          accepted: db.prepare("SELECT COUNT(*) AS n FROM graph_durable_submissions WHERE json_extract(record,'$.type')='input'").get()!.n };
      } finally { db.close(); }
    };
    await expect.poll(() => inspect().accepted, { timeout: 20000 }).toBe(2);
    const original = inspect();
    expect(original.calls).toBe(0);
    // The catalog moves on while the daemon is down. The recovered input
    // keeps the configuration it was admitted with.
    const edited = JSON.parse(await readFile(configPath, 'utf8'));
    edited.models.entries[0].maxTokens = 512;
    await writeFile(configPath, JSON.stringify(edited));
    daemon.child.kill('SIGKILL');
    await daemon.close();

    daemon = await start();
    await expect.poll(async () => {
      const view = await (await daemon!.request(`/api/conversations/${waiting}`)).json();
      return view.messages.filter((message: { role: string }) => message.role === 'assistant').at(-1)?.text;
    }, { timeout: 30000 }).toContain('Original admitted input recovered');
    expect(inspect()).toMatchObject({ id: original.id, attempt: original.attempt, state: 'succeeded', calls: 1 });
    expect(provider.requests).toHaveLength(2);
    const recoveredRequest = provider.requests[1] as { max_tokens?: number; max_completion_tokens?: number };
    expect(recoveredRequest.max_tokens ?? recoveredRequest.max_completion_tokens).toBe(256);
    // The frozen record holds no credential: the recovered request carries the
    // live binding's header, restored by name.
    expect(provider.authorizations[1]).toBe('Bearer durable-header-only');
    // The turn that was already at the provider is not replayed: the
    // credential was spent and the side effects may have happened.
    const uncertainView = await (await daemon.request(`/api/conversations/${uncertain}`)).json();
    expect(uncertainView.messages.filter((message: { role: string }) => message.role === 'assistant')).toEqual([]);
    const evidence = new DatabaseSync(join(root, 'state/tasks.sqlite'), { readOnly: true });
    try { expect(evidence.prepare("SELECT COUNT(*) AS n FROM operations o JOIN conversations c ON c.anchor_task_id=o.task_id WHERE c.id=? AND o.state='unknown'").get(uncertain)!.n).toBe(1); }
    finally { evidence.close(); }
    const other = await create('A separate conversation should still work.', 'separate');
    await expect.poll(async () => (await (await daemon!.request(`/api/conversations/${other}`)).json()).master?.status, { timeout: 20000 }).toBe('succeeded');
    expect(provider.requests).toHaveLength(3);
    const currentRequest = provider.requests[2] as { max_tokens?: number; max_completion_tokens?: number };
    expect(currentRequest.max_tokens ?? currentRequest.max_completion_tokens).toBe(512);
    // The credential never reaches the durable namespace: neither the key nor
    // the header that carries it.
    const secrets = new DatabaseSync(join(root, 'state/tasks.sqlite'), { readOnly: true });
    try {
      expect(secrets.prepare("SELECT COUNT(*) AS n FROM graph_durable_document_revisions WHERE content LIKE '%synthetic-only%'").get()!.n).toBe(0);
      expect(secrets.prepare("SELECT COUNT(*) AS n FROM graph_durable_document_revisions WHERE content LIKE '%durable-header-only%'").get()!.n).toBe(0);
    }
    finally { secrets.close(); }
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
