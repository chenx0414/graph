import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * The price of a request is the prefix it carries.
 *
 * The provider's window is the limit a session has to respect, and a session
 * compacts just before it would overflow. The running production conversations
 * reach around half a million tokens before they compact, and every request in
 * between pays for the whole of that prefix again.
 *
 * A ceiling asks for the same compaction earlier. It is off unless the
 * environment names one.
 */

const SUMMARY_REQUEST = 'context summarization assistant';

interface Provider { requests: unknown[]; close(): Promise<void> }

async function conversation(root: string, provider: Provider, ceiling: string | undefined) {
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1, projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_CEILING_TEST_KEY' } },
    models: { entries: [{ id: 'main', modelId: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: (provider as unknown as { model: { baseUrl: string } }).model.baseUrl,
      contextWindow: 512_000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    env: { GRAPH_CEILING_TEST_KEY: 'synthetic-only', ...(ceiling ? { GRAPH_COMPACTION_CONTEXT_CEILING: ceiling } : {}) },
    extraArgs: ['--execute'],
    configPath,
  });
  try {
    const created = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Write the proof file.', requestId: 'ceiling-first' }),
    });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    await expect.poll(async () => {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json();
      return view.master?.status;
    }, { timeout: 30_000 }).toBe('succeeded');

    const second = await daemon.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: 'Now read it back.', requestId: 'ceiling-second' }),
    });
    expect(second.status).toBe(200);
    await expect.poll(async () => {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json();
      return view.master?.status;
    }, { timeout: 30_000 }).toBe('succeeded');
  } finally {
    await daemon.close();
  }
}

function compactionRequests(requests: unknown[]) {
  return requests.filter(request => JSON.stringify(request).includes(SUMMARY_REQUEST));
}

test('a named ceiling compacts the session before the provider window would', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-compaction-ceiling-'));
  const provider = await openaiServer([
    { tools: [{ id: 'write-proof', name: 'bash', arguments: JSON.stringify({ command: 'printf harness-proof > proof.txt' }) }] },
    { text: 'The proof file is ready.' },
    { text: '## Goal\nWrite the proof file.\n\n## Constraints & Preferences\n(none)\n\n## Progress\n### Done\n- [x] Wrote the proof file.\n\n### In Progress\n(none)\n\n## Next Steps\n(none)' },
    { text: 'The proof file says harness-proof.' },
    { text: 'The proof file says harness-proof.' },
  ]);
  try {
    await conversation(root, provider, '20');
    // The session compacted although the provider's window had room for
    // another half a million tokens.
    expect(compactionRequests(provider.requests).length).toBeGreaterThan(0);
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test('without a ceiling the session compacts only when the window is full', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-compaction-ceiling-'));
  const provider = await openaiServer([
    { tools: [{ id: 'write-proof', name: 'bash', arguments: JSON.stringify({ command: 'printf harness-proof > proof.txt' }) }] },
    { text: 'The proof file is ready.' },
    { text: 'The proof file says harness-proof.' },
    { text: 'The proof file says harness-proof.' },
  ]);
  try {
    await conversation(root, provider, undefined);
    // The same conversation, without a ceiling, never compacted.
    expect(compactionRequests(provider.requests).length).toBe(0);
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
