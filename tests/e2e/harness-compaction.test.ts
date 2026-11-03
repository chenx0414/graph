import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * What the daemon's compaction settings mean to the kernel.
 *
 * The daemon decides when a context is compacted and how much room the
 * summary is written in. The kernel writes the summary into that room and
 * keeps the recent window the daemon chose. Neither of them reached the
 * kernel: the thresholds the daemon computed were never handed over, the
 * summary was asked for with the model's whole output limit instead of the
 * summary's own budget, and the events that say how the compaction ended
 * never reached the daemon at all - so a compaction that compacted nothing
 * was reported as a compaction that did.
 */

// The preamble the kernel's summarization request carries.
const SUMMARY_REQUEST = 'context summarization assistant';

interface ProviderRequest {
  max_tokens?: number;
  messages?: { role?: string; content?: unknown }[];
}

test('the compaction the daemon asked for is written in the room it reserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-compaction-budget-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  // The window is small enough that the daemon reserves a small room for the
  // summary: 30% of 4000 tokens is 1200, and the kernel writes the summary into
  // four fifths of it.
  const provider = await openaiServer([
    { text: 'The work is done. ' + 'context '.repeat(400) },
    { text: '## Goal\nThe work is done.\n\n## Next Steps\n(none)' },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const configPath = join(root, 'graph.config.json');
  try {
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_COMPACTION_KEY' } },
      models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high',
        api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 4000, maxTokens: 4096,
        credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_COMPACTION_KEY: 'synthetic-compaction-key' }, extraArgs: ['--execute'] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Do the work.', requestId: 'compaction-1',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      return (view.body as { master?: { status?: string } }).master?.status;
    }, { timeout: 60000, interval: 250 }).toBe('succeeded');

    // The user asks for the context to be compacted.
    const compacted = await request(`/api/conversations/${conversationId}/compact`, 'POST', { requestId: 'compaction-2' });
    expect(compacted.status, JSON.stringify(compacted.body)).toBe(200);
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      const messages = (view.body as { messages?: { role?: string; kind?: string; text?: string }[] }).messages ?? [];
      return messages.some(message => message.role === 'assistant' && (message.text ?? '').includes('压缩'));
    }, { timeout: 60000, interval: 250 }).toBe(true);

    // The summary was asked for in the room the daemon reserved, not in the
    // model's whole output limit: a summary written into the model's limit
    // is written until it is cut off. The daemon reserves 1200 tokens of a
    // 4000-token window (compaction starts at 70%), and the kernel writes the
    // summary into four fifths of the reserve.
    const summary = (provider.requests as ProviderRequest[]).find(entry =>
      JSON.stringify(entry.messages ?? []).includes(SUMMARY_REQUEST));
    expect(summary, `no summary request:\n${JSON.stringify(provider.requests).slice(0, 1500)}`).toBeTruthy();
    expect(summary!.max_tokens, 'the summary was asked for with the model output limit').toBe(960);

    // The compaction is reported as a compaction: the daemon keeps the record
    // of a context that really was compacted.
    const events = await request(`/api/conversations/${conversationId}/events?after=0&limit=400`);
    const types = (Array.isArray(events.body) ? events.body : []).map((event: { type?: string }) => event.type ?? '');
    expect(types, `the compaction was not reported:\n${types.join(', ')}`).toContain('session.compacted');
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
