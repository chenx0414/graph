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
