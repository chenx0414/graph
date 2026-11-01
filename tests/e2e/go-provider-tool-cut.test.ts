import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// A tool call whose arguments are cut short never ran, so the turn may be sent
// again. The failure is the environment's - the stream ended before the call
// was complete - not a judgement about the code. It is retried like any other
// transient transport failure; the second attempt produces a complete answer.
//
// A reply that instead hits the output token limit is a different fact: the
// call was too big, and the Agent has to shrink it. That case is not retried.
//
// The proof is the real daemon: a scripted provider cuts the first tool call's
// arguments, the harness retries the turn, and the answer to the retry is what
// the conversation shows.

const cleanup: (() => Promise<void> | void)[] = [];
test.afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ConversationView { messages: { role: string; text?: string }[] }

test('a provider that cuts a tool call before it completes is retried as an environment failure', async () => {
  const provider = await openaiServer([
    // The arguments never become JSON: the call cannot run.
    { tools: [{ id: 'call_cut', name: 'apply_rsi_change', arguments: '{"title":"cut before the end"' }], cut: true },
    { text: 'Recovered after the cut.' },
  ]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-tool-cut-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: join(root, 'project') }],
    credentials: { local: { secretRef: 'GRAPH_TOOL_CUT_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_TOOL_CUT_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());

  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Apply the cut change.', requestId: 'tool-cut' }),
  });
  const body = await created.text();
  expect(created.status, body).toBe(200);
  const { taskId, conversationId } = JSON.parse(body) as { taskId: string; conversationId: string };

  const view = async () => await (await daemon.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
  await expect.poll(async () => (await view()).messages.some(message => (message.text ?? '').includes('Recovered after the cut.')),
    { timeout: 30_000, interval: 100 }).toBe(true);
  expect(provider.requests).toHaveLength(2);

  // The retry is a recorded fact, not a silent second send.
  const events = await (await daemon.request(`/api/tasks/${taskId}/events?after=0&limit=500`)).json() as { type: string; data: { reason?: string } }[];
  const retry = events.find(event => event.type === 'node.transient_retry');
  expect(retry).toBeTruthy();
  expect(retry!.data.reason ?? '').toContain('环境问题');
}, 60_000);
