import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { git } from '../../src/git/git.ts';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * The bound on a provider that stops answering.
 *
 * The daemon builds the provider request itself, so it reads the answer
 * itself, and the read had no bound: a provider that accepted the connection
 * and then stopped talking held the turn, the credential slot and the node
 * for ever. The shared HTTP client carried no timeout either, because the
 * comment claimed the timeouts were the caller's, and the caller had none.
 *
 * The bound counts events, not bytes on the wire: a keepalive comment is
 * transport, not an answer, and a provider that only pings is a provider that
 * stopped answering.
 */

async function projectFixture(root: string): Promise<string> {
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Provider idle project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  return project;
}

/** A daemon whose provider bound is short enough for a test to wait for. */
async function daemonWithBound(root: string, project: string, provider: Awaited<ReturnType<typeof openaiServer>>) {
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_PROVIDER_IDLE_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high',
      api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 512,
      credentialId: 'local' }] },
  }));
  return launchCli(root, {
    configPath,
    env: { GRAPH_PROVIDER_IDLE_KEY: 'synthetic-provider-idle-key', GRAPH_PROVIDER_STREAM_IDLE_TIMEOUT: '2s' },
    extraArgs: ['--execute'],
  });
}

test('a provider that only sends keepalives fails the turn instead of holding it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-provider-idle-'));
  const project = await projectFixture(root);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  // The provider holds the connection open and says nothing but keepalive
  // comments: it accepted the request and stopped answering.
  const provider = await openaiServer([{ keepalive: true, keepaliveEveryMs: 100 }]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    daemon = await daemonWithBound(root, project, provider);
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Answer me.', requestId: 'idle-1',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    // The turn ends with the failure the silent provider earned, and it ends
    // inside the bound rather than never.
    let view: unknown = {};
    await expect.poll(async () => {
      const reply = await request(`/api/conversations/${conversationId}`);
      view = reply.body;
      const messages = (reply.body as { messages?: { role?: string; kind?: string }[] }).messages ?? [];
      return messages.some(message => message.role === 'system' && message.kind === 'error');
    }, { timeout: 60000, interval: 250 }).toBe(true);
    const messages = (view as { messages?: { role?: string; kind?: string; text?: string }[] }).messages ?? [];
    const failure = messages.find(message => message.role === 'system' && message.kind === 'error');
    expect(failure?.text ?? '', 'the failure does not name the provider').toMatch(/provider/i);
    const status = (view as { master?: { status?: string } }).master?.status ?? '';
    expect(status, `the silent provider was reported as ${status}\nstderr: ${daemon?.stderr ?? ''}`).not.toBe('succeeded');
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180000);

test('a provider that keeps sending events is not cut off by the idle bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-provider-active-'));
  const project = await projectFixture(root);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  // Six events, half a second apart: the whole answer takes longer than the
  // two second bound, but the provider is talking the whole time.
  const provider = await openaiServer([{ chunks: ['One ', 'slow ', 'answer ', 'that ', 'takes ', 'a while.'], pace: 500 }]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    daemon = await daemonWithBound(root, project, provider);
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Answer me.', requestId: 'active-1',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    let view: unknown = {};
    await expect.poll(async () => {
      const reply = await request(`/api/conversations/${conversationId}`);
      view = reply.body;
      const messages = (reply.body as { messages?: { role?: string; kind?: string; text?: string }[] }).messages ?? [];
      return messages.some(message => message.role === 'assistant' && (message.text ?? '').includes('takes a while'));
    }, { timeout: 60000, interval: 250 }).toBe(true);
    const status = (view as { master?: { status?: string } }).master?.status ?? '';
    expect(status, `the answer arrived but the turn was reported as ${status}\nstderr: ${daemon?.stderr ?? ''}`).toBe('succeeded');
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
