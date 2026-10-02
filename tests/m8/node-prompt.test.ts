import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { openGraphServer } from '../../src/server/host.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import type { Proposal } from '../../src/core/types.ts';
import { withLiftedDefinition } from '../fixtures/v2-lift.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0)) await action(); });

async function temp(name: string) {
  return mkdtemp(join(tmpdir(), `graph-${name}-`));
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting');
}

/**
 * One subagent node, seen the way the console shows it: the system prompt the provider
 * really received, and the briefing that opened the node's own session.
 */
test('a subagent node reports the system prompt and briefing it really sent', async () => {
  const root = await temp('node-prompt');
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer([{ text: 'work done' }, { text: 'extra' }]);
  cleanup.push(() => provider.close());
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    limits: { defaultBudgetTokens: 20_000_000 },
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime,
      credentialFor: () => ({ credentialId: 'cred', apiKey: 'scripted-local-key' }),
    },
    actions: {
      check: {
        kind: 'program',
        prepare: async () => async () => ({
          outcome: 'completed', output: { passed: true },
          evidence: [{ acceptanceId: 'ok', summary: 'synthetic observing check', artifact: { path: join(root, 'ok'), digest: 'a'.repeat(64) } }],
        }),
      },
    },
  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const begun = await server.runtime.user.begin({ projectId: 'p', request: '看清 subagent 读到的提示词', requestId: 'begin' });
  const userTask = server.runtime.user.task(begun.taskId);
  await server.runtime.supervisor(begun.taskId).propose(withLiftedDefinition({
    requirementVersion: 1, summary: 'node prompt',
    acceptance: [{ id: 'ok', description: '有产出', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local', input: { files: ['src/a.ts'], focus: '写下结果' } },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  } as Proposal), 'proposal');
  await userTask.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await server.runtime.host.drive();
  await waitFor(() => provider.requests.length >= 1, 30_000);

  // The truth is the request the provider received, not a preview of it.
  const body = provider.requests[0] as { messages?: { role?: string; content?: unknown }[] };
  // The transport sends the system prompt as the leading developer message.
  const system = body.messages?.find(message => message.role === 'developer' || message.role === 'system');
  expect(typeof system?.content, JSON.stringify(body).slice(0, 600)).toBe('string');

  // The console API is same-origin and cookie-scoped, exactly as the page calls it.
  const home = await fetch(server.url, { headers: { origin: server.url } });
  const headers = { origin: server.url, cookie: home.headers.get('set-cookie') ?? '' };
  const response = await fetch(`${server.url}/api/tasks/${begun.taskId}/nodes/work/prompt`, { headers });
  expect(response.status).toBe(200);
  const view = await response.json() as {
    role: string | null; definitionVersion: string | null; kind: string; notes: string[];
    recorded: { operationId: string; text: string; tools: string | null } | null;
    briefing: { text: string; sessionFile: string } | null;
  };
  expect(view.kind).toBe('agent');
  expect(view.role).toBe('worker');
  expect(view.definitionVersion).toBe('coder@1');
  // Byte for byte: the panel shows the send, not a lookalike.
  expect(view.recorded?.text).toBe(system?.content);
  expect((view.recorded?.tools ?? '').length).toBeGreaterThan(0);
  expect(view.recorded?.operationId).toBeTruthy();

  // The briefing is the first user message of the node's own session file, read back here
  // from that same file so the assertion is about the record rather than the renderer.
  const database = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
  const row = database.prepare('SELECT session_file FROM node_sessions').get() as { session_file: string };
  database.close();
  expect(view.briefing?.sessionFile).toBe(row.session_file);
  const firstUser = (await readFile(row.session_file, 'utf8')).split('\n').filter(line => line.trim())
    .map(line => JSON.parse(line) as { message?: { role?: string; content?: unknown } })
    .find(entry => entry.message?.role === 'user');
  // A user message carries either a string or text blocks; read whichever this session used.
  const content = firstUser?.message?.content;
  const text = typeof content === 'string'
    ? content
    : (content as { text?: string }[] | undefined ?? []).map(part => part.text ?? '').join('');
  expect(text.length).toBeGreaterThan(0);
  expect(view.briefing?.text).toBe(text);
  expect(view.briefing?.text).toContain('Your node: work (agent work)');

  // A program node is never sent a prompt, and the panel says so rather than guessing.
  const program = await (await fetch(`${server.url}/api/tasks/${begun.taskId}/nodes/check/prompt`, { headers })).json() as { recorded: unknown; role: unknown; notes: string[] };
  expect(program.recorded).toBeNull();
  expect(program.role).toBeNull();
  expect(program.notes.join(' ')).toContain('程序节点');

  // Unknown nodes are a not_found, not an empty panel.
  const missing = await fetch(`${server.url}/api/tasks/${begun.taskId}/nodes/nope/prompt`, { headers });
  expect(missing.status).toBeGreaterThanOrEqual(400);
}, 120_000);
