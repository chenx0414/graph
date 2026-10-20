import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * A conversation is created over HTTP with the model and the thinking level
 * the user picked, and the conversation carries that choice.
 *
 * The choice is not a display detail: it decides which model answers and at
 * which reasoning effort. The proof drives the real Go process over real HTTP
 * and reads the choice back from the conversation the backend keeps.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-conversation-http-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await openaiServer(Array.from({ length: 8 }, () => ({ text: 'Answering.' })));
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_CONVERSATION_KEY' } },
    models: { entries: [
      { id: 'm1', provider: 'graph-openai', grade: 'medium', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' },
      { id: 'm2', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local',
        reasoning: true, defaultThinkingLevel: 'low' },
    ] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_CONVERSATION_KEY: 'synthetic-conversation-key' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  return { root, provider, daemon, request };
}

test('a conversation created over HTTP keeps the model and thinking level the user picked', async () => {
  const f = await fixture();

  const created = await f.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', text: 'Pick a model for me', model: 'm2', thinkingLevel: 'high', requestId: 'conversation-1' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;
  expect(conversationId).toBeTruthy();

  const view = await f.request(`/api/conversations/${conversationId}`);
  expect(view.status).toBe(200);
  const telemetry = (view.body as { telemetry: { model?: string; thinkingLevel?: string } }).telemetry;
  // The model the user picked is the model that answers, and the thinking
  // level is the one the user asked for.
  expect(telemetry.model).toBe('m2');
  expect(telemetry.thinkingLevel).toBe('high');
}, 60_000);

test('the request that carries the model reaches the provider that model points at', async () => {
  const f = await fixture();

  const created = await f.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', text: 'Answer with the second model', model: 'm2', requestId: 'conversation-2' }),
  });
  const conversationId = (created.body as { conversationId: string }).conversationId;

  // The turn has to reach the provider on its own: the choice is proven by the
  // request that leaves the process, not by the projection alone.
  await expect.poll(async () => {
    const view = await f.request(`/api/conversations/${conversationId}`);
    return (view.body as { master?: { status?: string } }).master?.status;
  }, { timeout: 30_000, interval: 250 }).toBe('succeeded');

  const sent = f.provider.requests.find(request => {
    const body = request as { messages?: { role: string; content: unknown }[] };
    return body.messages?.some(message => message.role === 'user'
      && JSON.stringify(message.content).includes('Answer with the second model'));
  });
  expect(sent, 'the master turn never reached the provider').toBeTruthy();
}, 60_000);
