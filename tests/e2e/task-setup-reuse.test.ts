import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * The task setup is the description of the environment the task runs in.
 *
 * It is the same text in every operation of a task. The session reads it once,
 * but the operation prompt carries it every time, and the prompt is part of the
 * transcript the session reads again with every request - so a task of sixty
 * operations carried sixty copies of the same text and every request paid for
 * all sixty.
 */

interface Provider {
  model: { baseUrl: string };
  requests: unknown[];
  close(): Promise<void>;
}

/**
 * Two operations of one conversation, and the last user turn each of them sent.
 */
async function lastUserTurns(provider: Provider) {
  return provider.requests.map(entry => {
    const request = entry as { messages?: { role: string; content: unknown }[] };
    const messages = request.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]!.role === 'user') return String(messages[index]!.content);
    }
    return '';
  });
}

async function twoOperations(root: string, provider: Provider, reuse: boolean) {
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1, projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_SETUP_REUSE_KEY' } },
    models: { entries: [{ id: 'main', modelId: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    env: { GRAPH_SETUP_REUSE_KEY: 'synthetic-only', GRAPH_REUSE_TASK_SETUP: reuse ? '1' : '0' },
    extraArgs: ['--execute'],
    configPath,
  });
  try {
    const created = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Write proof.txt.', requestId: 'setup-first' }),
    });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    const settled = async () => {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json();
      return view.master?.status;
    };
    await expect.poll(settled, { timeout: 30_000 }).toBe('succeeded');

    const second = await daemon.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: 'Read proof.txt back.', requestId: 'setup-second' }),
    });
    expect(second.status).toBe(200);
    await expect.poll(settled, { timeout: 30_000 }).toBe('succeeded');
  } finally {
    await daemon.close();
  }
}

test('without the switch the session reads the task setup with every operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-task-setup-'));
  const provider = await openaiServer([
    { tools: [{ id: 'write-proof', name: 'bash', arguments: JSON.stringify({ command: 'printf harness-proof > proof.txt' }) }] },
    { text: 'The proof file is ready.' },
    { text: 'The proof file says harness-proof.' },
  ]);
  try {
    await twoOperations(root, provider, false);
    const turns = await lastUserTurns(provider);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    // The second operation carries the setup again.
    expect(turns[turns.length - 1]).toContain('System context (read-only');
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test('with the switch the session keeps the task setup it already read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-task-setup-'));
  const provider = await openaiServer([
    { tools: [{ id: 'write-proof', name: 'bash', arguments: JSON.stringify({ command: 'printf harness-proof > proof.txt' }) }] },
    { text: 'The proof file is ready.' },
    { text: 'The proof file says harness-proof.' },
  ]);
  try {
    await twoOperations(root, provider, true);
    const turns = await lastUserTurns(provider);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    // The first operation carries the setup: the session has to read it once.
    expect(turns[0]).toContain('System context (read-only');
    // The second operation does not: the session already read it.
    expect(turns[turns.length - 1]).not.toContain('System context (read-only');
    // And the model is told that the setup stands.
    expect(turns[turns.length - 1]).toContain('task setup is unchanged');
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
