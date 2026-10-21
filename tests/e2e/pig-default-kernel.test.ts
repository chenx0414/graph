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

// The default kernel is the decision this migration has been making its way
// towards. A daemon that is started without `--kernel` must run its Agent
// sessions on the PiG kernel: the TypeScript sidecar must not be started, the
// durable namespace must be the PiG one, and the session must really work.
//
// The sidecar itself is retired with the protocol layer that carried it, so
// the old kernel is no longer a choice: `--kernel node` is refused by name.
test('a daemon started without --kernel runs its Agent session on the PiG kernel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-default-'));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const sentinel = 'PIG_DEFAULT_SEED_7C42';
  await writeFile(join(project, 'seed.txt'), sentinel);
  const provider = await openaiServer([
    { tools: [{ id: 'read-seed', name: 'read', arguments: JSON.stringify({ path: join(project, 'seed.txt') }) }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
    { text: 'The seed says PIG_DEFAULT_SEED_7C42.', usage: { prompt_tokens: 30, completion_tokens: 8 } },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_PIG_DEFAULT_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));

    // No `--kernel`: this is the way the desktop app and every operator start
    // the daemon.
    daemon = await launchCli(root, { configPath, env: { GRAPH_PIG_DEFAULT_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });

    // The TypeScript sidecar is the old kernel's carrier. The default kernel
    // must not start it: two kernels over one durable namespace would fight
    // over the same tables.
    expect(await sidecarProcesses(daemon.child.pid!)).toEqual([]);

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
    // Still no sidecar after the turn: the session ran inside the daemon.
    expect(await sidecarProcesses(daemon.child.pid!)).toEqual([]);

    // The durable namespace is the PiG one: PiG ships schema version 2 and
    // migrates the namespace in place when it opens the database. The
    // TypeScript sidecar wrote version 1.
    const database = join(root, 'state/tasks.sqlite');
    const db = new DatabaseSync(database, { readOnly: true });
    let schemaVersion: number;
    let conversations: { id: number }[];
    try {
      schemaVersion = (db.prepare('SELECT version FROM graph_durable_durable_schema WHERE singleton=1').get() as { version: number }).version;
      conversations = db.prepare('SELECT id FROM graph_durable_conversations ORDER BY id').all() as { id: number }[];
    } finally { db.close(); }
    expect(schemaVersion).toBe(2);
    expect(conversations.length).toBeGreaterThan(0);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

// The old kernel is gone with the protocol layer that carried it. A daemon
// asked for it must say so by name: two kernels over one durable namespace
// would fight over the same tables, so the refusal is the safe answer.
test('--kernel node is refused: the TypeScript durable sidecar is retired', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-node-kernel-'));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  await writeFile(join(project, 'seed.txt'), 'NODE_KERNEL_SEED_5B18');
  const provider = await openaiServer([
    { text: 'The node kernel answered.', usage: { prompt_tokens: 20, completion_tokens: 5 } },
  ]);
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_NODE_KERNEL_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
    // The sidecar is gone: the daemon must say so rather than start a second
    // kernel over the same durable namespace.
    const failure = await launchCli(root, { configPath, env: { GRAPH_NODE_KERNEL_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'node'] })
      .then(() => undefined, (error: Error) => error);
    expect(failure).toBeDefined();
    expect(failure!.message).toMatch(/sidecar/i);
    expect(failure!.message).toMatch(/retired|only kernel|no longer/i);
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

// sidecarProcesses are the TypeScript durable sidecars the daemon started.
//
// The durable sidecar was a child process, so its absence is the evidence
// that the session really ran inside the daemon.
async function sidecarProcesses(pid: number): Promise<string[]> {
  const listing = await run('ps', ['-o', 'pid=,ppid=,command=', '-ax'], { timeout: 20000 });
  const children = listing.stdout.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const parts = line.split(/\s+/);
      return { pid: Number(parts[0]), ppid: Number(parts[1]), command: parts.slice(2).join(' ') };
    })
    .filter(entry => entry.ppid === pid);
  return children.map(entry => entry.command).filter(command => command.includes('durable-service'));
}
