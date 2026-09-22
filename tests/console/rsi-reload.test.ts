import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { git } from '../../src/git/git.ts';
import { RsiService } from '../../src/runtime/rsi.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test.each([
  { mixed: false, mode: 'activate' }, { mixed: true, mode: 'activate' },
  { mixed: false, mode: 'save' }, { mixed: false, mode: 'failed' },
])('RSI handles $mode and reload handoff (mixed tool batch: $mixed)', async ({ mixed, mode }) => {
  const root = await mkdtemp(join(tmpdir(), 'graph-rsi-reload-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  await mkdir(checkout);
  await writeFile(join(checkout, 'package.json'), '{"name":"graph"}\n');
  for (const args of [['init', '-b', 'main'], ['add', '-A'], ['commit', '-m', 'init']]) {
    expect(git(checkout, args).code).toBe(0);
  }
  const stateDir = join(root, 'state');
  const rsi = new RsiService({ root: checkout, stateDir, validate: async () => [{ command: 'fixture check', status: mode === 'failed' ? 'failed' : 'passed', output: '' }] });
  const provider = await openaiServer([
    { text: 'Previous work and decisions. '.repeat(500) },
    { usage: { prompt_tokens: mode === 'activate' ? 40_000 : 40, completion_tokens: 10 }, tools: [
      ...(mixed ? [{ id: 'inspect', name: 'inspect_rsi_status', arguments: '{}' }] : []),
      { id: 'apply', name: 'apply_rsi_change', arguments: JSON.stringify({ title: 'First improvement', problem: 'Needs a helper', activate: mode !== 'save', changes: [{ path: 'helper.ts', action: 'write', content: 'export const helper = 1;\n' }] }) },
      ...(mixed ? [{ id: 'second-apply', name: 'apply_rsi_change', arguments: JSON.stringify({ title: 'Should wait', problem: 'Another improvement', changes: [{ path: 'helper.ts', action: 'write', content: 'export const helper = 2;\n' }] }) }] : []),
    ] },
    { text: 'This response must wait for the reload.' },
  ]);
  cleanup.push(() => provider.close());
  const options = {
    stateDir, rsi, access: () => fullAccessPolicy(),
    projects: [{ id: 'p', root: checkout }],
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    models: { entries: [{ ...provider.model, id: 'local', grade: 'high' as const, credentialId: 'local' }], apiKey: 'local-key', modelRuntime: provider.runtime },
  };
  const runtime = await openTaskRuntime(options);
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  const created = await runtime.conversations.create({ projectId: 'p', text: 'Prepare history.', requestId: 'create' });
  await runtime.host.runReady();
  await runtime.conversations.chat(created.conversationId, { text: 'Improve the harness and activate it. '.repeat(mode === 'activate' ? 400 : 1), requestId: 'improve' });
  await runtime.host.runReady();
  if (mode !== 'activate') {
    expect(provider.requests).toHaveLength(3);
    expect((await rsi.status()).pendingRestart).toBeNull();
    const messages = (await runtime.conversations.view(created.conversationId)).messages;
    expect(messages.find(message => message.kind === 'rsi')?.data).toMatchObject({ status: mode === 'failed' ? 'checks_failed' : 'applied' });
    expect(messages.some(message => message.role === 'assistant' && message.text === 'This response must wait for the reload.')).toBe(true);
    return;
  }
  // Any further provider request after the activation recreates the observed self-blocking loop.
  expect(provider.requests).toHaveLength(2);
  expect(await readFile(join(checkout, 'helper.ts'), 'utf8')).toBe('export const helper = 1;\n');
  const status = await rsi.status();
  expect(status).toMatchObject({ activeOperations: 0, canRestart: true });
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.messages.some(message => message.role === 'assistant' && message.text.includes('等待重载'))).toBe(true);
  expect(view.messages.find(message => message.kind === 'rsi')?.data).toMatchObject({ activation: { state: 'pending_reload' } });
  await runtime.conversations.chat(created.conversationId, { text: 'Continue after reload.', requestId: 'next' });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect(provider.requests).toHaveLength(2);
  await runtime.close();
  // Reopen the same ledger as a fresh daemon; queued messages stay undelivered
  // until the desktop acknowledges this exact restart.
  const restartedRsi = new RsiService({ root: checkout, stateDir });
  const restarted = await openTaskRuntime({ ...options, rsi: restartedRsi });
  cleanup.push(() => restarted.close());
  expect(await restarted.host.runReady()).toEqual({ dispatched: 0 });
  expect((await restarted.host.ackRsiRestart('stale-request')).cleared).toBe(false);
  expect((await restarted.host.ackRsiRestart(status.pendingRestart!.id)).cleared).toBe(true);
  const activated = await restarted.conversations.view(created.conversationId);
  expect(activated.messages.find(message => message.kind === 'rsi')?.data).toMatchObject({ activation: { state: 'active' } });
  expect(await restarted.host.runReady()).toEqual({ dispatched: 1 });
  expect(provider.requests).toHaveLength(3);
  const resumed = await restarted.conversations.view(created.conversationId);
  expect(resumed.messages.some(message => message.role === 'assistant' && message.text === 'This response must wait for the reload.')).toBe(true);
}, 60_000);
