import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// A turn that survives a restart still owns its conversation.
//
// The daemon comes back with the kernel still running the turn that was in
// flight when it died. A message the user sends at that moment belongs behind
// that turn, like any message sent while the master is busy. It must not be
// submitted into a conversation that is still running one, because that is
// refused as busy and the user sees a turn that failed for no reason they can
// see.
//
// The proof is the real daemon and the real kernel: the recovered turn is held
// at the provider, the second message is posted into that window, and the
// second answer arrives only after the recovered one, with its context.

const cleanup: (() => Promise<void> | void)[] = [];
test.afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ConversationView {
  messages: { role: string; kind: string; text?: string; state?: string }[];
}

test('a message sent while a recovered turn is still running waits for it instead of being refused as busy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-recovery-busy-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');

  let releaseRecovered = () => {};
  const recoveredHeld = new Promise<void>(resolve => { releaseRecovered = resolve; });
  const provider = await openaiServer([
    // The turn the daemon dies under: it never reaches the point of answering.
    { text: 'The first answer nobody hears.', holdBeforeUsage: true },
    // The kernel resumes that turn after the restart and is held here, so the
    // second message provably arrives while a turn is still running.
    { beforeReply: () => recoveredHeld, text: 'The recovered answer.', usage: { prompt_tokens: 40, completion_tokens: 10 } },
    // The second message's own turn. It may only run after the first settled.
    { text: 'The second answer.', usage: { prompt_tokens: 60, completion_tokens: 10 } },
  ]);
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: join(root, 'project') }],
    credentials: { local: { secretRef: 'GRAPH_RECOVERY_BUSY_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const start = () => launchCli(root, { configPath, env: { GRAPH_RECOVERY_BUSY_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'pig'] });
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    daemon = await start();
    const created = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Start a turn the restart will interrupt.', requestId: 'first' }),
    });
    const createdText = await created.text();
    expect(created.status, createdText).toBe(200);
    const { conversationId } = JSON.parse(createdText) as { conversationId: string };
    await expect.poll(() => provider.requests.length, { timeout: 30_000, interval: 100 }).toBe(1);

    daemon.child.kill('SIGKILL');
    await daemon.close();
    daemon = await start();

    const posted = await daemon.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: 'Wait for the turn that was already running.', requestId: 'second' }),
    });
    expect(posted.status, await posted.text()).toBe(200);

    const view = async () => await (await daemon!.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
    // While the recovered turn is held, the second one neither answers nor
    // fails: it is queued behind the turn that owns the conversation.
    await expect.poll(async () => {
      const messages = (await view()).messages;
      if (messages.some(message => (message.text ?? '').includes('is busy'))) return 'refused';
      if (messages.some(message => (message.text ?? '').includes('The second answer.'))) return 'answered';
      return 'waiting';
    }, { timeout: 8_000, interval: 250 }).toBe('waiting');

    // The recovered turn is what the second one waits for, and it reaches the
    // provider again before the second input may run.
    await expect.poll(() => provider.requests.length, { timeout: 30_000, interval: 100 }).toBe(2);
    releaseRecovered();
    await expect.poll(async () => (await view()).messages.some(message => (message.text ?? '').includes('The second answer.')),
      { timeout: 30_000, interval: 250 }).toBe(true);
    // The second turn ran after the recovered one and carries its answer.
    expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(provider.requests[2])).toContain('The recovered answer.');
    const messages = (await view()).messages;
    expect(messages.some(message => (message.text ?? '').includes('is busy'))).toBe(false);
  } finally {
    await daemon?.close();
    await provider.close();
  }
}, 120_000);
