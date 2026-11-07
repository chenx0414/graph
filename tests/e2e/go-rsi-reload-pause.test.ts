import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A reload stops the work it would wait for, and the next daemon puts it back.
 *
 * Measured 2026-11-03: activating a harness change queued behind a project
 * supervisor's in-flight turn, and the user asked why a reload should wait for
 * somebody else's long tool call at all. The product answer: interrupt the live
 * turns, pause their tasks, remember which ones this reload paused, and resume
 * exactly those after the new daemon is up. Work a person paused stays paused.
 *
 * This drives the real activation path against a real checkout: one
 * conversation is held inside the model call, a second one is paused by its
 * user, and the activation turn must interrupt the first, record only it, and
 * leave the second alone across a real daemon restart.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ToolCall { id: string; name: string; arguments: string }

/** One provider: holds HOLD_ME, plays the RSI master for its own turn. */
async function provider() {
  let held = 0;
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      tools?: { function: { name: string } }[];
      messages: { role: string; content: unknown }[];
    };
    const lastUser = [...body.messages].reverse().find(message => message.role === 'user');
    const text = JSON.stringify(lastUser?.content ?? '');
    requests.push(text.slice(0, 60));
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const answer = (content: string, finish: string) => {
      response.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }));
      response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
    };
    const call = (calls: ToolCall[]) => {
      response.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls.map((item, index) => ({ index, id: item.id, type: 'function', function: { name: item.name, arguments: item.arguments } })) }, finish_reason: null }] }));
      response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
    };
    if (text.includes('HOLD_ME')) {
      // Keep the turn in flight until the daemon is replaced under it.
      held += 1;
      await new Promise<void>(() => { /* never answers */ });
      return;
    }
    const hasApply = (body.tools ?? []).some(tool => tool.function.name === 'apply_rsi_change');
    const spoken = body.messages.some(message => message.role === 'tool');
    if (hasApply && text.includes('RSI workflow') && !spoken) {
      call([{ id: 'apply-once', name: 'apply_rsi_change', arguments: JSON.stringify({
        title: 'Reload pause harness', problem: 'Prove the reload pauses what it would wait for',
        activate: true,
        changes: [{ path: 'probe.txt', action: 'write', content: 'one\n' }],
        checks: [{ command: 'node', args: ['-e', ''] }],
      }) }]);
      return;
    }
    answer('收到。', 'stop');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    held: () => held,
    requests,
    port: (server.address() as AddressInfo).port,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

test('an activation interrupts and records the live work, and the next daemon resumes only that', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-reload-pause-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  await mkdir(checkout, { recursive: true });
  const git = (args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'reload-pause', scripts: { check: 'node -e ""' } }));
  await writeFile(join(checkout, 'base.txt'), 'base\n');
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@local']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'initial']);
  await mkdir(join(root, 'project'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const model = await provider();
  cleanup.push(() => model.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: join(root, 'project') }],
    credentials: { local: { secretRef: 'GRAPH_RELOAD_PAUSE_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${model.port}/v1`, contextWindow: 32000, maxTokens: 1024, credentialId: 'local' }] },
  }));
  const start = () => launchCli(root, { configPath, env: { GRAPH_RSI_ROOT: checkout, GRAPH_RELOAD_PAUSE_KEY: 'reload-pause' }, extraArgs: ['--execute'] });
  let daemon = await start();
  cleanup.push(() => daemon.close());
  const request = async (path: string, body?: object) => {
    const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };

  // The work this reload must not wait for, and work a person already paused.
  const victim = await request('/api/conversations', { projectId: 'p', model: 'local', text: 'HOLD_ME', requestId: 'victim' });
  expect(victim.status, JSON.stringify(victim.body)).toBe(200);
  const victimConversation = String(victim.body.conversationId);
  await expect.poll(() => model.held(), { timeout: 60_000, interval: 100 }).toBe(1);
  const paused = await request('/api/conversations', { projectId: 'p', model: 'local', text: 'idle one', requestId: 'idle' });
  expect(paused.status, JSON.stringify(paused.body)).toBe(200);
  const pausedConversation = String(paused.body.conversationId);
  const pauseReceipt = await request(`/api/conversations/${pausedConversation}/pause`, { requestId: 'pause-by-person' });
  expect(pauseReceipt.status, JSON.stringify(pauseReceipt.body)).toBe(200);

  // The activation turn: it must interrupt the held turn before requesting the reload.
  const opened = await request('/api/orchestration/global', { requestId: 'rsi-open' });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  const rsi = await request(`/api/conversations/${String(opened.body.conversationId)}/messages`, { text: 'RSI workflow', requestId: 'rsi' });
  expect(rsi.status, JSON.stringify(rsi.body)).toBe(200);
  const restartPath = join(root, 'state', 'rsi', 'restart.json');
  try {
    await expect.poll(async () => access(restartPath).then(() => true).catch(() => false), { timeout: 120_000, interval: 250 }).toBe(true);
  } catch (error) {
    const view = await request(`/api/conversations/${String(rsi.body.conversationId)}`);
    console.log('REQUESTS', JSON.stringify(model.requests));
    console.log('TRANSCRIPT', JSON.stringify((view.body.messages ?? []).slice(-4)).slice(0, 1200));
    throw error;
  }

  const resumePath = join(root, 'state', 'rsi', 'resume.json');
  const resumed = JSON.parse(await readFile(resumePath, 'utf8')) as string[];
  expect(resumed.length, `resume list: ${JSON.stringify(resumed)}`).toBe(1);

  // A real restart: the new daemon consumes the list and nothing else.
  await daemon.close();
  daemon = await start();
  cleanup.push(() => daemon.close());
  // Until the desktop acknowledges the reload, dispatch stays closed and the
  // paused work stays paused on purpose.
  await expect(access(resumePath)).resolves.toBeUndefined();
  expect((await request(`/api/conversations/${victimConversation}`)).body.paused,
    'the reload-paused conversation must wait for the ack').toBe(true);

  // The desktop acknowledges the reload once the new daemon runs the commit:
  // that ack is also when dispatch opens again (a pending restart blocks every
  // turn), and therefore when the paused work is continued.
  const restart = JSON.parse(await readFile(restartPath, 'utf8')) as { id: string };
  const appToken = (await readFile(join(root, 'state', 'app-token'), 'utf8')).trim();
  const ack = await daemon.request('/api/app/rsi/restart-ack', {
    method: 'POST',
    headers: { 'x-graph-app-token': appToken },
    body: JSON.stringify({ id: restart.id }),
  });
  expect(ack.status, await ack.clone().text()).toBe(200);

  await expect.poll(async () => access(resumePath).then(() => true).catch(() => false), { timeout: 30_000, interval: 200 }).toBe(false);
  expect((await request(`/api/conversations/${victimConversation}`)).body.paused,
    'the reload-paused conversation was not resumed by the ack').toBe(false);
  // Resuming re-dispatches the turn the reload cut: the fixture sees the same
  // request a second time, which is the Agent being asked to carry on.
  await expect.poll(() => model.requests.filter(text => text.includes('HOLD_ME')).length, { timeout: 60_000, interval: 250 }).toBe(2);
}, 300_000);
