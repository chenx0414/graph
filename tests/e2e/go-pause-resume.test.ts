import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * A paused conversation holds its work.
 *
 * Pausing is an operator decision that has to survive the moment it is made:
 * a message that arrives while the conversation is paused must not reach the
 * provider, and it must go out when the conversation resumes. The pause is a
 * fact of the task, not a flag in the browser, so it also survives a restart
 * of the daemon.
 *
 * The proof is the real Go process and the real provider: what the provider
 * received is the observation point, not a projection of internal state.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-pause-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await openaiServer(Array.from({ length: 8 }, () => ({ text: 'Working on it.' })));
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_PAUSE_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_PAUSE_KEY: 'synthetic-pause-key' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const conversation = async (text: string, requestId: string) => {
    const created = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text, requestId }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return (created.body as { conversationId: string; taskId: string }).conversationId;
  };
  return { root, configPath, daemon, request, conversation, provider };
}

test('a message that arrives while the conversation is paused waits for the resume', async () => {
  const f = await fixture();

  const conversationId = await f.conversation('Start the work', 'conversation-1');
  // The first turn really goes out: the provider has to have seen it, or the
  // later "nothing was sent" would prove nothing.
  await expect.poll(() => f.provider.requests.length, { timeout: 30_000, interval: 100 }).toBeGreaterThan(0);

  const paused = await f.request(`/api/conversations/${conversationId}/pause`, {
    method: 'POST', body: JSON.stringify({ requestId: 'pause-1' }),
  });
  expect(paused.status, JSON.stringify(paused.body)).toBe(200);

  const view = await f.request(`/api/conversations/${conversationId}`);
  expect((view.body as { paused?: boolean }).paused).toBe(true);

  const sent = f.provider.requests.length;
  const message = await f.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ text: 'Held while paused', requestId: 'message-1' }),
  });
  expect(message.status, JSON.stringify(message.body)).toBe(200);

  // The paused conversation does not reach the provider.
  await new Promise(resolve => setTimeout(resolve, 2000));
  expect(f.provider.requests.length).toBe(sent);

  const resumed = await f.request(`/api/conversations/${conversationId}/resume`, {
    method: 'POST', body: JSON.stringify({ requestId: 'resume-1' }),
  });
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);

  // The held message goes out when the conversation resumes.
  await expect.poll(() => f.provider.requests.length, { timeout: 30_000, interval: 100 }).toBeGreaterThan(sent);
  const after = await f.request(`/api/conversations/${conversationId}`);
  expect((after.body as { paused?: boolean }).paused).toBe(false);
}, 90_000);

test('a paused conversation stays paused across a restart of the daemon', async () => {
  const f = await fixture();

  const conversationId = await f.conversation('Start the work', 'conversation-2');
  const paused = await f.request(`/api/conversations/${conversationId}/pause`, {
    method: 'POST', body: JSON.stringify({ requestId: 'pause-2' }),
  });
  expect(paused.status, JSON.stringify(paused.body)).toBe(200);

  await f.daemon.close();
  const restarted = await launchCli(f.root, {
    configPath: f.configPath,
    env: { GRAPH_PAUSE_KEY: 'synthetic-pause-key' },
    extraArgs: ['--execute'],
  });
  cleanup.push(() => restarted.close());

  const view = await restarted.request(`/api/conversations/${conversationId}`);
  expect(view.status).toBe(200);
  expect((await view.json() as { paused?: boolean }).paused).toBe(true);
}, 90_000);
