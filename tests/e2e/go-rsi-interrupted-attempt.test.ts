import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A self-improvement call that is interrupted has to be answerable afterwards.
 *
 * Measured 2026-11-02: apply_rsi_change was interrupted while its gate ran and
 * answered only "may have partially run". The commit had in fact landed, the
 * gate had passed and the reload was confirmed later - and the only way to learn
 * that was to read Git by hand, while the gate ran a second time.
 *
 * This drives the real daemon against a real checkout. The interrupted call
 * cannot be produced by killing a process inside a test, so its only lasting
 * trace is reproduced the way the product leaves it: the attempt file it writes
 * before starting. What is asserted is the answer the Agent needs - did it
 * commit, and which commit - derived from the repository itself.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ToolCall { id: string; name: string; arguments: string }

/**
 * The provider that plays the master, one script per conversation marker.
 *
 * A turn and the follow-up request that reads its tool result carry the same
 * user text, so the script is keyed by the marker in that text: the first
 * request of a turn runs the call, the follow-up finishes the turn. Keying by
 * request order instead lets one turn's follow-up consume the next turn's call,
 * and the next turn then reads a status nothing has written yet.
 */
async function masterProvider(scripts: Record<string, ToolCall[][]>) {
  const observed = new Map<string, string>();
  const stage = new Map<string, number>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      tools?: { function: { name: string; description: string } }[];
      messages: { role: string; content: unknown; tool_call_id?: string }[];
    };
    const main = body.tools?.some(tool => tool.function.name === 'apply_rsi_change')
      && body.messages.some(message => message.role === 'user'
        && JSON.stringify(message.content).includes('RSI workflow'));
    let calls: ToolCall[] = [];
    if (main) {
      for (const message of body.messages) {
        if (message.role === 'tool' && message.tool_call_id) {
          observed.set(message.tool_call_id, typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content));
        }
      }
      const user = [...body.messages].reverse().find(message => message.role === 'user');
      const marker = /RSI workflow ([a-z-]+)/.exec(JSON.stringify(user?.content ?? ''))?.[1] ?? '';
      const index = stage.get(marker) ?? 0;
      stage.set(marker, index + 1);
      calls = (scripts[marker] ?? [])[index] ?? [];
    }
    const delta = calls.length
      ? {
        role: 'assistant',
        tool_calls: calls.map((call, position) => ({
          index: position, id: call.id, type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      }
      : { role: 'assistant', content: main ? 'RSI workflow completed' : 'No suggestion' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    observed, port,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

const inspect = (id: string): ToolCall => ({ id, name: 'inspect_rsi_status', arguments: '{}' });

test('an interrupted change can be read back as committed or not, and a finished one leaves nothing behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-rsi-attempt-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  await mkdir(checkout, { recursive: true });
  const git = (args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'rsi-attempt-fixture', scripts: { check: 'node -e ""' } }));
  await writeFile(join(checkout, 'base.txt'), 'base\n');
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@local']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'initial']);
  const baseHead = git(['rev-parse', 'HEAD']);

  await mkdir(join(root, 'project'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await masterProvider({
    none: [[inspect('no-attempt')]],
    landed: [[inspect('landed')]],
    'not-landed': [[inspect('not-landed')]],
    apply: [[{
      id: 'apply', name: 'apply_rsi_change', arguments: JSON.stringify({
        title: 'Finished attempt', problem: 'A call that finishes must not leave an attempt behind',
        activate: false,
        changes: [{ path: 'written.txt', action: 'write', content: 'done\n' }],
        checks: [{ command: 'node', args: ['-e', ''] }],
      }),
    }]],
    'after-apply': [[inspect('after-apply')]],
  });
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: join(root, 'project') }],
    credentials: { local: { secretRef: 'GRAPH_RSI_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      contextWindow: 32000, maxTokens: 4096, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath,
    env: { GRAPH_RSI_ROOT: checkout, GRAPH_RSI_KEY: 'rsi-synthetic' },
    extraArgs: ['--execute', '--kernel', 'pig'],
  });
  cleanup.push(() => daemon.close());

  const turn = async (marker: string) => {
    const created = await daemon.request('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p', model: 'local', text: 'RSI workflow ' + marker, requestId: 'rsi-attempt-' + marker }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
  };
  const attemptPath = join(root, 'state/rsi/attempt.json');
  const writeAttempt = async (title: string, base: string) => {
    await mkdir(join(root, 'state/rsi'), { recursive: true });
    await writeFile(attemptPath, JSON.stringify({
      id: 'attempt-' + title.toLowerCase().replace(/\s+/g, '-'),
      title, root: checkout, branch: 'main', baseHead: base,
      paths: ['written.txt'], startedAt: Date.now(),
    }, null, 2) + '\n');
  };

  // 1. Nothing in flight: the status says so instead of inventing an attempt,
  await turn('none');
  await expect.poll(() => provider.observed.has('no-attempt'), { timeout: 90_000, interval: 250 }).toBe(true);
  expect(JSON.parse(provider.observed.get('no-attempt')!).interruptedAttempt).toBeNull();

  // 2. An interrupted call whose commit did land: the answer names the commit,
  // and says what the checkout is on now.
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-q', '--allow-empty', '-m', 'rsi: Landed attempt']);
  const landedCommit = git(['rev-parse', 'HEAD']);
  await writeAttempt('Landed attempt', baseHead);
  await turn('landed');
  await expect.poll(() => provider.observed.has('landed'), { timeout: 90_000, interval: 250 }).toBe(true);
  const landed = JSON.parse(provider.observed.get('landed')!).interruptedAttempt;
  expect(landed, 'the interrupted attempt is not reported at all').toBeTruthy();
  expect(landed.title).toBe('Landed attempt');
  expect(landed.committed).toBe(true);
  expect(landed.commit).toBe(landedCommit);
  expect(landed.head).toBe(landedCommit);

  // 3. An interrupted call whose commit never landed: committed is false and no
  // commit is named - the difference that costs a model call to get wrong.
  await writeAttempt('Never landed', landedCommit);
  await turn('not-landed');
  await expect.poll(() => provider.observed.has('not-landed'), { timeout: 90_000, interval: 250 }).toBe(true);
  const missing = JSON.parse(provider.observed.get('not-landed')!).interruptedAttempt;
  expect(missing.committed).toBe(false);
  expect(missing.commit).toBeNull();

  // 4. A call that finishes clears the file it wrote before starting, so an
  // attempt is only ever "in flight" while a call really is.
  await turn('apply');
  await expect.poll(() => provider.observed.has('apply'), { timeout: 120_000, interval: 250 }).toBe(true);
  expect(provider.observed.get('apply')).toContain('"status":"applied"');
  expect(await readFile(join(checkout, 'written.txt'), 'utf8')).toBe('done\n');
  await expect(access(attemptPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await turn('after-apply');
  await expect.poll(() => provider.observed.has('after-apply'), { timeout: 90_000, interval: 250 }).toBe(true);
  expect(JSON.parse(provider.observed.get('after-apply')!).interruptedAttempt).toBeNull();
}, 300_000);
