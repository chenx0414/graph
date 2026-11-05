import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// A restart can cut through a tool that was executing. Its side effects are
// unknown, so the kernel will not replay it: the tool task stays pending and
// the generation waiting on it keeps the conversation busy for ever. Every
// later message would wait for an idle that never comes - the supervisor goes
// silent although the daemon is healthy.
//
// The boot recovery aborts that work. The interrupted turn keeps its recovery
// question, the tool is not replayed, and the next message gets an answer.
//
// The proof is a real kill in the middle of a real tool.

const cleanup: (() => Promise<void> | void)[] = [];
test.afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

const longCommand = 'sleep 30';

test('a restart that cuts through a running tool does not silence the supervisor', async () => {
  const provider = await openaiServer([
    { tools: [{ id: 'call_long', name: 'bash', arguments: JSON.stringify({ command: longCommand, timeoutMs: 60000 }) }] },
    { text: 'Recovered after the stalled tool.' },
  ]);
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-stalled-tool-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: join(root, 'project') }],
    credentials: { local: { secretRef: 'GRAPH_STALLED_TOOL_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const start = () => launchCli(root, { configPath, env: { GRAPH_STALLED_TOOL_KEY: 'synthetic-only' }, extraArgs: ['--execute'] });
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;

  interface TaskEvent { type: string; data: { phase?: string; summary?: string } }
  const toolRunning = async () => {
    const events = await (await daemon!.request(`/api/tasks/${taskId}/events?after=0&limit=500`)).json() as TaskEvent[];
    return events.some(event => event.type === 'message.tool' && event.data.phase === 'start'
      && (event.data.summary ?? '').includes(longCommand));
  };
  let taskId = '';
  try {
    daemon = await start();
    const created = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Run the long command.', requestId: 'stalled-first' }),
    });
    const createdText = await created.text();
    expect(created.status, createdText).toBe(200);
    taskId = (JSON.parse(createdText) as { taskId: string }).taskId;
    const conversationId = (JSON.parse(createdText) as { conversationId: string }).conversationId;

    await expect.poll(toolRunning, { timeout: 30_000, interval: 100 }).toBe(true);
    // The user's second message waits behind the running turn. The restart
    // happens between queuing it and the wake that would dispatch it.
    const queued = await daemon.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: 'Are you back?', requestId: 'stalled-second' }),
    });
    expect(queued.status, await queued.text()).toBe(200);

    // The process dies with the tool mid-execution: its checkpoint is
    // "execute" and the side effects are unknown.
    daemon.child.kill('SIGKILL');
    await daemon.close();
    daemon = await start();

    const view = async () => await (await daemon!.request(`/api/conversations/${conversationId}`)).json() as { messages: { role: string; text?: string }[] };
    await expect.poll(async () => (await view()).messages.some(message => (message.text ?? '').includes('Recovered after the stalled tool.')),
      { timeout: 30_000, interval: 100 }).toBe(true);

    // The aborted turn is a recorded fact; the tool never ran a second time.
    const events = await (await daemon.request(`/api/tasks/${taskId}/events?after=0&limit=500`)).json() as TaskEvent[];
    expect(events.map(event => event.type)).toContain('graph.recovery.stalled_turn_aborted');
    expect(provider.requests.length).toBeGreaterThanOrEqual(2);
  } finally {
    await daemon?.close();
    await provider.close();
  }
}, 90_000);
