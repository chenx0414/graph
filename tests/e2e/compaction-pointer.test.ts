import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const SUMMARY_REQUEST = 'context summarization assistant';

interface Event { type?: string; data?: { data?: { reason?: string } } }
interface View { messages?: { role?: string; kind?: string; text?: string; data?: { summary?: string } | null }[]; master?: { status?: string } }

function pointer(conversationId: string) {
  return `你正在继续会话 ${conversationId}。一边进行一边从中检索关键上下文。`;
}

async function world(contextWindow: number, turns: { text: string; usage: { prompt_tokens: number; completion_tokens: number } }[]) {
  const provider = await openaiServer([
    ...turns.map(turn => ({ text: turn.text, usage: turn.usage })),
    { text: '## Goal\nContinue the work.\n\n## Next Steps\n(none)' },
    { text: 'After the compaction.', usage: { prompt_tokens: 300, completion_tokens: 10 } },
  ]);
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-compaction-pointer-'));
  await mkdir(join(root, 'project'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div>Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: join(root, 'project') }],
    credentials: { local: { secretRef: 'GRAPH_POINTER_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_POINTER_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });
  const close = async () => { await daemon.close(); await provider.close(); await rm(root, { recursive: true, force: true }); };
  return { daemon, provider, root, close };
}

async function settled(daemon: Awaited<ReturnType<typeof world>>['daemon'], conversationId: string, answers: number) {
  await expect.poll(async () => {
    const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as View;
    return (view.messages ?? []).filter(message => message.role === 'assistant').length === answers ? view.master?.status : undefined;
  }, { timeout: 30_000, interval: 100 }).toBe('succeeded');
}

async function expectPointer(daemon: Awaited<ReturnType<typeof world>>['daemon'], taskId: string, conversationId: string) {
  const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as View;
  const notices = (view.messages ?? []).filter(message => message.kind === 'compaction');
  expect(notices.length, JSON.stringify(notices)).toBe(1);
  expect(notices.at(-1)?.text?.trim().endsWith(pointer(conversationId))).toBe(true);
  // The UI shows the summary itself, so the row has to carry it.
  expect(notices.at(-1)?.data?.summary ?? '').toContain('## Goal');
  const events = await (await daemon.request(`/api/tasks/${taskId}/events?after=0&limit=500`)).json() as Event[];
  expect(events.filter(event => event.type === 'session.compacted').length).toBeGreaterThan(0);
}

test('an automatic threshold compaction ends its summary with the fixed pointer sentence', async () => {
  const w = await world(60_000, [{ text: 'The first turn is done.', usage: { prompt_tokens: 30_000, completion_tokens: 10 } }]);
  try {
    const created = await w.daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Start the work.', requestId: 'auto-first' }),
    });
    const { taskId, conversationId } = JSON.parse(await created.text()) as { taskId: string; conversationId: string };
    await settled(w.daemon, conversationId, 1);
    const second = await w.daemon.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: `Continue the work. ${'context '.repeat(6_250)}`, requestId: 'auto-second' }),
    });
    expect(second.status, await second.text()).toBe(200);
    await settled(w.daemon, conversationId, 2);
    expect(w.provider.requests.some(request => JSON.stringify(request).includes(SUMMARY_REQUEST))).toBe(true);
    await expectPointer(w.daemon, taskId, conversationId);

  } finally {
    await w.close();
  }
}, 90_000);

test('a manual compaction writes the same summary, the same event and the same pointer sentence', async () => {
  const w = await world(60_000, [{ text: `The first turn is done. ${'context '.repeat(6_250)}`, usage: { prompt_tokens: 30_000, completion_tokens: 10 } }]);
  try {
    const created = await w.daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Start the work.', requestId: 'manual-first' }),
    });
    const { taskId, conversationId } = JSON.parse(await created.text()) as { taskId: string; conversationId: string };
    await settled(w.daemon, conversationId, 1);
    const compacted = await w.daemon.request(`/api/conversations/${conversationId}/compact`, {
      method: 'POST', body: JSON.stringify({ requestId: 'manual-compact' }),
    });
    expect(compacted.status, await compacted.text()).toBe(200);
    await expect.poll(async () => {
      const view = await (await w.daemon.request(`/api/conversations/${conversationId}`)).json() as View;
      return (view.messages ?? []).filter(message => message.kind === 'compaction').length;
    }, { timeout: 30_000, interval: 100 }).toBeGreaterThan(0);
    expect(w.provider.requests.some(request => JSON.stringify(request).includes(SUMMARY_REQUEST))).toBe(true);
    await expectPointer(w.daemon, taskId, conversationId);
    // Asking again on an already-tight context says nothing: no "nothing to do"
    // line lands in the chat.
    const again = await w.daemon.request(`/api/conversations/${conversationId}/compact`, {
      method: 'POST', body: JSON.stringify({ requestId: 'manual-compact-again' }),
    });
    expect(again.status, await again.text()).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 1_500));
    const after = await (await w.daemon.request(`/api/conversations/${conversationId}`)).json() as View;
    expect(JSON.stringify(after.messages)).not.toContain('无需再次压缩');
    expect((after.messages ?? []).filter(message => message.kind === 'compaction').length).toBeGreaterThan(0);
  } finally {
    await w.close();
  }
}, 90_000);
