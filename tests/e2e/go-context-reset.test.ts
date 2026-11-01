import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// A context that can no longer fit the model's window cannot be compacted: the
// summarizer would have to read the same oversized prefix. The turn must not
// be sent into a provider that can only answer "Input too long", and the agent
// must not be dead for good. The session starts a new context with a handoff
// before the send; the durable transcript stays in history.
//
// The proof is the real daemon: the first turn writes an answer larger than a
// deliberately small window, the second turn is sent a context without that
// answer, and the answer to the second turn still arrives.

const cleanup: (() => Promise<void> | void)[] = [];
test.afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ConversationView { messages: { role: string; text?: string }[] }

test('an oversized context is replaced with a handoff instead of being sent to the provider', async () => {
  const longAnswer = `LONG-ANSWER-MARKER ${'context filler '.repeat(8_000)}`;
  const provider = await openaiServer([
    { text: longAnswer, usage: { prompt_tokens: 40, completion_tokens: 10 } },
    { text: 'After the reset.', usage: { prompt_tokens: 40, completion_tokens: 10 } },
  ]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-context-reset-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: join(root, 'project') }],
    credentials: { local: { secretRef: 'GRAPH_CONTEXT_RESET_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 40000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_CONTEXT_RESET_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());

  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Start a large answer.', requestId: 'reset-first' }),
  });
  const createdText = await created.text();
  expect(created.status, createdText).toBe(200);
  const { taskId, conversationId } = JSON.parse(createdText) as { taskId: string; conversationId: string };
  const view = async () => await (await daemon.request(`/api/conversations/${conversationId}`)).json() as ConversationView;

  await expect.poll(async () => (await view()).messages.some(message => (message.text ?? '').includes('LONG-ANSWER-MARKER')),
    { timeout: 30_000, interval: 100 }).toBe(true);

  const second = await daemon.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ text: 'Continue after the reset.', requestId: 'reset-second' }),
  });
  expect(second.status, await second.text()).toBe(200);

  await expect.poll(async () => (await view()).messages.some(message => (message.text ?? '').includes('After the reset.')),
    { timeout: 30_000, interval: 100 }).toBe(true);

  // The second request carried the handoff, not the oversized answer.
  expect(provider.requests).toHaveLength(2);
  const sent = JSON.stringify(provider.requests[1]);
  expect(sent).not.toContain('LONG-ANSWER-MARKER');
  expect(sent).toContain("no longer fit the model's context window");
  expect(sent).toContain('Continue after the reset.');

  // The history the user can scroll back to is untouched.
  expect((await view()).messages.some(message => (message.text ?? '').includes('LONG-ANSWER-MARKER'))).toBe(true);

  // The replacement is a durable fact of the turn, not a silent loss.
  const events = await (await daemon.request(`/api/tasks/${taskId}/events?after=0&limit=500`)).json() as { type: string }[];
  expect(events.map(event => event.type)).toContain('session.context_reset');
}, 60_000);
