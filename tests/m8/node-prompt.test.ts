import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openGraphServer } from '../../src/server/host.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { createDurableSessionTransport } from '../../src/runtime/durable-session.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

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
    sessionTransport: createDurableSessionTransport,
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    limits: { defaultBudgetTokens: 20_000_000 },
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime,
      credentialFor: () => ({ credentialId: 'cred', apiKey: 'scripted-local-key' }),
    },

  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const begun = await server.runtime.user.begin({ projectId: 'p', request: '看清 subagent 读到的提示词', requestId: 'begin' });
  const main = server.runtime.supervisor(begun.taskId);
  const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Node prompt', protocols: { data: { type: 'object' } },
    nodes: { work: { recipe: 'coder@1', model: 'local', task: '写下结果', acceptance: ['有产出'], inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} } },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } }, edges: {},
  }) }) as { graphId: string };
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { files: ['src/a.ts'], focus: '写下结果' } });
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
  const response = await fetch(`${server.url}/api/tasks/${graphId}/nodes/work/prompt`, { headers });
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

  // The console briefing is the same input the real provider received, and its
  // stable session reference names the node's durable conversation.
  expect(view.briefing?.sessionFile).toBe(server.runtime.nodeRun(graphId, 'work').session?.sessionFile);
  expect(view.briefing?.sessionFile).toMatch(/^durable:/);
  const firstUser = body.messages?.find(message => message.role === 'user');
  expect(firstUser, JSON.stringify(body)).toBeDefined();
  // A user message carries either a string or text blocks; read whichever this session used.
  const content = firstUser?.content;
  const text = typeof content === 'string'
    ? content
    : (content as { text?: string }[] | undefined ?? []).map(part => part.text ?? '').join('');
  expect(text.length, JSON.stringify(firstUser)).toBeGreaterThan(0);
  expect(view.briefing?.text).toBe(text);
  expect(view.briefing?.text).toContain('写下结果');
  expect(view.briefing?.text).toContain('src/a.ts');

  // A host module has no Agent session; the Agent prompt endpoint refuses it.
  const module = await fetch(`${server.url}/api/tasks/${graphId}/nodes/check/prompt`, { headers });
  expect(module.status).toBeGreaterThanOrEqual(400);
  expect(await module.json()).toMatchObject({ code: 'not_found' });

  // Unknown nodes are a not_found, not an empty panel.
  const missing = await fetch(`${server.url}/api/tasks/${graphId}/nodes/nope/prompt`, { headers });
  expect(missing.status).toBeGreaterThanOrEqual(400);
}, 120_000);
