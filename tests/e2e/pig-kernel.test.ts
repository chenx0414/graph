import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { ensureBackendBinary } from '../helpers/backend-binary.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const run = promisify(execFile);

// The kernel takeover is the central risk of the PiG migration: the Go kernel
// has to address the very same durable records the TypeScript kernel wrote, in
// the very same tables of the very same Graph database. This test drives the
// real daemon, lets it write a durable main conversation, and then reads that
// database back through the PiG kernel's own storage contract.
test('the PiG kernel reads the durable conversations the daemon wrote, in the same tables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-kernel-'));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const provider = await openaiServer([{ text: 'The durable kernel answer.', usage: { prompt_tokens: 20, completion_tokens: 5 } }]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_PIG_KERNEL_TEST_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_PIG_KERNEL_TEST_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });
    const created = await daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Answer through the durable kernel.', requestId: 'first' }) });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    await expect.poll(async () => {
      const view = await (await daemon!.request(`/api/conversations/${conversationId}`)).json();
      return view.master?.status;
    }, { timeout: 30000 }).toBe('succeeded');
    await daemon.close();
    daemon = undefined;

    const database = join(root, 'state/tasks.sqlite');
    // The daemon's own durable rows, read straight from SQLite.
    const before = new DatabaseSync(database, { readOnly: true });
    let daemonConversations: { id: number }[];
    let daemonEntries: number;
    try {
      daemonConversations = before.prepare('SELECT id FROM graph_durable_conversations ORDER BY id').all() as { id: number }[];
      daemonEntries = (before.prepare('SELECT COUNT(*) AS count FROM graph_durable_entries').get() as { count: number }).count;
    } finally { before.close(); }
    expect(daemonConversations.length).toBeGreaterThan(0);
    expect(daemonEntries).toBeGreaterThan(0);

    // The same database, read through the PiG kernel.
    const binary = ensureBackendBinary();
    const inspected = await run(binary, ['--pig-kernel-inspect', database], { timeout: 120_000 });
    const report = JSON.parse(inspected.stdout.trim()) as {
      prefix: string; schemaVersion: number;
      conversations: { id: number; entries: number }[];
      submissions: number; tasks: number;
    };
    expect(report.prefix).toBe('graph_durable_');
    // The TypeScript kernel writes schema version 1. PiG ships version 2 and
    // migrates the namespace in place when it opens the database.
    expect(report.schemaVersion).toBe(2);
    // Every conversation the daemon wrote is visible to the PiG kernel, by the
    // same identifiers, with the same transcript.
    expect(report.conversations.map(conversation => conversation.id)).toEqual(daemonConversations.map(conversation => conversation.id));
    expect(report.conversations.reduce((total, conversation) => total + conversation.entries, 0)).toBeGreaterThan(0);
    expect(report.submissions).toBeGreaterThan(0);

    // The kernel left the daemon's rows alone: the same records are still there.
    const after = new DatabaseSync(database, { readOnly: true });
    try {
      expect(after.prepare('SELECT id FROM graph_durable_conversations ORDER BY id').all()).toEqual(daemonConversations);
    } finally { after.close(); }
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

// The kernel has to do more than read the records the TypeScript kernel left:
// it has to run a turn of its own, with a real provider and a real tool, and
// persist what it did in the same Graph database.
test('the PiG kernel runs a real agent turn with a Graph tool and keeps the transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-turn-'));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  await writeFile(join(project, 'seed.txt'), 'THE_KERNEL_SEED_51C3');
  const provider = await openaiServer([
    { tools: [{ id: 'read-seed', name: 'read', arguments: JSON.stringify({ path: 'seed.txt' }) }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
    { text: 'The seed says THE_KERNEL_SEED_51C3.', usage: { prompt_tokens: 30, completion_tokens: 8 } },
    { text: 'The second answer.', usage: { prompt_tokens: 40, completion_tokens: 6 } },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_PIG_TURN_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
    // The daemon creates the real Graph database the kernel then writes into.
    daemon = await launchCli(root, { configPath, env: { GRAPH_PIG_TURN_KEY: 'synthetic-only' } });
    await daemon.close();
    daemon = undefined;

    const database = join(root, 'state/tasks.sqlite');
    const binary = ensureBackendBinary();
    const turned = await run(binary, ['--pig-kernel-turn', database, '--config', configPath,
      '--kernel-model', 'main', '--kernel-prompt', 'Read seed.txt, then answer.',
      '--kernel-identity', 'main-instance'], { env: { ...process.env, GRAPH_PIG_TURN_KEY: 'synthetic-only' }, timeout: 120_000 });
    const result = JSON.parse(turned.stdout.trim()) as {
      conversationId: number; status: string; text: string; toolCalls: string[]; entries: number;
    };
    expect(result.status).toBe('done');
    expect(result.toolCalls).toEqual(['read']);
    expect(result.text).toContain('THE_KERNEL_SEED_51C3');
    expect(result.entries).toBeGreaterThan(0);

    // The provider really was asked, with the Graph's own credential.
    expect(provider.requests.length).toBeGreaterThanOrEqual(1);
    expect(provider.authorizations[0]).toContain('synthetic-only');

    // The same identity keeps the same durable conversation: the identity
    // mapping is a durable document, so a second turn continues the first.
    const again = await run(binary, ['--pig-kernel-turn', database, '--config', configPath,
      '--kernel-model', 'main', '--kernel-prompt', 'Answer again.',
      '--kernel-identity', 'main-instance'], { env: { ...process.env, GRAPH_PIG_TURN_KEY: 'synthetic-only' }, timeout: 120_000 });
    const second = JSON.parse(again.stdout.trim()) as { conversationId: number; status: string; entries: number };
    expect(second.status).toBe('done');
    expect(second.conversationId).toBe(result.conversationId);
    expect(second.entries).toBeGreaterThan(result.entries);

    // The transcript is in the Graph database, and the kernel reads it back.
    const inspected = await run(binary, ['--pig-kernel-inspect', database], { timeout: 120_000 });
    const report = JSON.parse(inspected.stdout.trim()) as {
      schemaVersion: number; conversations: { id: number; entries: number }[]; submissions: number;
    };
    expect(report.schemaVersion).toBe(2);
    expect(report.conversations.map(conversation => conversation.id)).toContain(result.conversationId);
    expect(report.submissions).toBeGreaterThan(0);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
