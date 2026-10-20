import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const run = promisify(execFile);

// The product switch is the point of this migration: the daemon's own Agent
// session must run on the PiG kernel, not in a TypeScript sidecar.
//
// The proof is a real daemon, a real provider and a real Graph tool, and it
// ends with the facts only the kernel can produce: the durable namespace
// carries the PiG schema, the identity document keeps the shape the old
// kernel wrote, and no TypeScript process was started to carry the session.
test('the daemon runs its Agent session on the PiG kernel, without the TypeScript sidecar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-session-'));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const sentinel = 'PIG_SESSION_SEED_4D8E';
  await writeFile(join(project, 'seed.txt'), sentinel);
  const provider = await openaiServer([
    { tools: [{ id: 'read-seed', name: 'read', arguments: JSON.stringify({ path: join(project, 'seed.txt') }) }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
    { text: 'The seed says PIG_SESSION_SEED_4D8E.', usage: { prompt_tokens: 30, completion_tokens: 8 } },
    { text: 'The same kernel conversation continued.', usage: { prompt_tokens: 40, completion_tokens: 8 } },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_PIG_SESSION_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
    const start = () => launchCli(root, { configPath, env: { GRAPH_PIG_SESSION_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'pig'] });
    daemon = await start();

    // The TypeScript sidecar is the old kernel's carrier. On the PiG kernel
    // the daemon must not start it: two kernels over one durable namespace
    // would fight over the same tables.
    expect(await childProcesses(daemon.child.pid!)).toEqual([]);

    const created = await daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Read seed.txt, then answer.', requestId: 'first' }) });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    const view = async () => await (await daemon!.request(`/api/conversations/${conversationId}`)).json();
    await expect.poll(async () => (await view()).master?.status, { timeout: 30000 }).toBe('succeeded');
    const answers = (await view()).messages.filter((message: { role: string }) => message.role === 'assistant');
    expect(answers.at(-1)?.text).toContain(sentinel);
    // The Graph tool really ran: the provider asked for the file and the
    // answer carries what the file holds.
    expect(JSON.stringify(provider.requests[0])).toContain('seed.txt');
    expect(JSON.stringify(provider.requests[1])).toContain(sentinel);
    expect(await childProcesses(daemon.child.pid!)).toEqual([]);

    // The durable namespace is the PiG one: PiG ships schema version 2 and
    // migrates the namespace in place when it opens the database.
    const database = join(root, 'state/tasks.sqlite');
    const first = new DatabaseSync(database, { readOnly: true });
    let schemaVersion: number;
    let conversations: { id: number }[];
    let identity: string;
    try {
      schemaVersion = (first.prepare('SELECT version FROM graph_durable_durable_schema WHERE singleton=1').get() as { version: number }).version;
      conversations = first.prepare('SELECT id FROM graph_durable_conversations ORDER BY id').all() as { id: number }[];
      identity = first.prepare(`SELECT r.content FROM graph_durable_document_revisions r
        JOIN graph_durable_documents d ON d.id = r.document_id
        WHERE json_extract(d.kind, '$') = 'graph.identities'`).all().map(row => String((row as { content: string }).content)).join('');
    } finally { first.close(); }
    expect(schemaVersion).toBe(2);
    expect(conversations.length).toBeGreaterThan(0);
    // The identity document keeps the shape the TypeScript kernel wrote, so
    // the same database is readable by both kernels.
    expect(identity).toContain('conversations');
    // A restart must find the very same durable conversation: the identity
    // mapping is a durable document, not a process memory.
    await daemon.close();
    daemon = await start();
    expect(await childProcesses(daemon.child.pid!)).toEqual([]);
    const next = await daemon.request(`/api/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Continue the same conversation.', requestId: 'second' }) });
    expect(next.status).toBe(200);
    await expect.poll(async () => {
      const messages = (await view()).messages.filter((message: { role: string }) => message.role === 'assistant');
      return messages.at(-1)?.text;
    }, { timeout: 30000 }).toContain('The same kernel conversation continued.');
    // The second turn continued the same transcript: the provider saw the
    // file the first turn read.
    expect(JSON.stringify(provider.requests.at(-1))).toContain(sentinel);
    const second = new DatabaseSync(database, { readOnly: true });
    try {
      expect(second.prepare('SELECT id FROM graph_durable_conversations ORDER BY id').all()).toEqual(conversations);
    } finally { second.close(); }
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

// childProcesses are the processes the daemon started.
//
// The durable sidecar was a child process, so its absence is the evidence
// that the session really ran inside the daemon.
async function childProcesses(pid: number): Promise<string[]> {
  const listing = await run('ps', ['-o', 'pid=,ppid=,command=', '-ax'], { timeout: 20000 });
  const children = listing.stdout.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const parts = line.split(/\s+/);
      return { pid: Number(parts[0]), ppid: Number(parts[1]), command: parts.slice(2).join(' ') };
    })
    .filter(entry => entry.ppid === pid);
  return children.map(entry => entry.command);
}
