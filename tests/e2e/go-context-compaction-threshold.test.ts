import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// Compaction starts at a configured threshold, not when the window is already
// full: the daemon reserves 30% of the window, and the kernel compacts itself
// once the next request would cross the remaining 70%. The proof is a second
// turn whose message grows the context past the threshold: the kernel
// summarizes before the model call, the session keeps working, and no context
// is replaced.
//
// The daemon's own pre-send check cannot fire here: it measures the last billed
// request (30k tokens), while the message that grows the context arrives after
// that measurement.

const SUMMARY_REQUEST = 'context summarization assistant';

interface Event { type?: string; data?: { data?: { reason?: string } } }

test('the kernel compacts at the configured threshold before the context is full', async () => {
  const provider = await openaiServer([
    { text: 'The first turn is done.', usage: { prompt_tokens: 30_000, completion_tokens: 10 } },
    { text: '## Goal\nContinue the work.\n\n## Next Steps\n(none)' },
    { text: 'The work is done.', usage: { prompt_tokens: 500, completion_tokens: 10 } },
  ]);
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-compaction-threshold-'));
  await mkdir(join(root, 'project'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div>Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: join(root, 'project') }],
    credentials: { local: { secretRef: 'GRAPH_THRESHOLD_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 60000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_THRESHOLD_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });
  try {
    const created = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Start the work.', requestId: 'threshold-first' }),
    });
    const createdText = await created.text();
    expect(created.status, createdText).toBe(200);
    const { taskId, conversationId } = JSON.parse(createdText) as { taskId: string; conversationId: string };

    await expect.poll(async () => {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as { master?: { status?: string } };
      return view.master?.status;
    }, { timeout: 30_000, interval: 100 }).toBe('succeeded');

    // 50k characters is about 14.3k estimated tokens: measured 30k is below the
    // 42k threshold, this turn crosses it, and the whole request stays below
    // the 60k window.
    const second = await daemon.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: `Continue the work. ${'context '.repeat(6_250)}`, requestId: 'threshold-second' }),
    });
    expect(second.status, await second.text()).toBe(200);

    await expect.poll(async () => {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as {
        messages?: { role?: string; text?: string }[]; master?: { status?: string };
      };
      return view.messages?.filter(message => message.role === 'assistant').length === 2 ? view.master?.status : undefined;
    }, { timeout: 30_000, interval: 100 }).toBe('succeeded');

    // The summary was asked for: the kernel compacted before the model call.
    expect(provider.requests.some(request => JSON.stringify(request).includes(SUMMARY_REQUEST))).toBe(true);

    const events = await (await daemon.request(`/api/tasks/${taskId}/events?after=0&limit=500`)).json() as Event[];
    const compacted = events.filter(event => event.type === 'session.compacted');
    expect(compacted.length, `no compaction:\n${JSON.stringify(events.map(event => event.type)).slice(0, 800)}`).toBeGreaterThan(0);
    expect(compacted[0]?.data?.data?.reason).toBe('threshold');
    // Nothing was replaced: the threshold compaction is the mechanism that
    // keeps the session below the window.
    expect(events.map(event => event.type)).not.toContain('session.context_reset');
  } finally {
    await daemon.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
