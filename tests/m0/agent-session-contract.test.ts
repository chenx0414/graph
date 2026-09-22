import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  createInProcessAgentSessionTransport,
  createRestrictedProcessAgentSessionTransport,
  type AgentSessionRequest,
} from '../../src/runtime/agent-session.ts';
import { CallBroker } from '../../src/runtime/call-broker.ts';
import { controlledOpenAIStream } from '../../src/runtime/controlled-openai.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

function bounded<T>(promise: Promise<T>, milliseconds: number, label: string) {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${label} did not settle within ${milliseconds}ms`)), milliseconds);
      timeout.unref?.();
    }),
  ]);
}

test.each([
  ...(['in-process', 'restricted-process'] as const).flatMap(kind =>
    (['continue', 'failed-summary', 'close-and-resume'] as const).map(scenario => ({ kind, scenario }))),
  { kind: 'restricted-process', scenario: 'worker-exit' } as const,
])('the $kind transport settles compaction ($scenario)', async ({ kind, scenario }) => {
  const root = await mkdtemp(join(tmpdir(), `graph-agent-compact-${kind}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  const provider = await openaiServer([
    { text: 'A previous response. '.repeat(300) },
    {
      text: 'Summary of the previous turn.', finishReason: scenario === 'failed-summary' ? 'length' : 'stop',
      beforeReply: () => {
        if (scenario === 'worker-exit') process.kill(session.inspect().processId!, 'SIGKILL');
      },
    },
    { text: 'Continued successfully.' },
  ]);
  cleanup.push(() => provider.close());
  const broker = new CallBroker(join(root, 'calls.sqlite'), `compaction-${kind}`);
  cleanup.push(() => broker.close());
  const transport = kind === 'in-process'
    ? createInProcessAgentSessionTransport({ modelRuntime: provider.runtime })
    : createRestrictedProcessAgentSessionTransport();
  const request: AgentSessionRequest = {
    binding: { instanceId: `compact-${kind}`, nodeId: 'master', definitionVersion: 'master@1' },
    workspace, stateDir: join(root, 'state'), model: provider.model,
    stream: controlledOpenAIStream(broker, 'host-only-compaction-key'),
    tools: [], bundleDigest: 'a'.repeat(64), toolPolicyDigest: 'b'.repeat(64),
    runtimePolicyDigest: 'c'.repeat(64), readOnly: true, broker,
    compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 1 },
  };
  let session = await transport.open(request);
  cleanup.push(() => session.close());
  await session.prompt('Prepare history for a follow-up. '.repeat(100));
  const original = session.inspect();
  await session.close();
  session = await transport.open(request);

  const compact = bounded(session.compact('Summarize briefly.'), 15_000, 'compaction');
  if (scenario === 'worker-exit') {
    await expect(compact).rejects.toThrow('SIGKILL');
    await bounded(session.close(), 15_000, 'exited worker close');
    expect(provider.requests).toHaveLength(2);
    return;
  }
  if (scenario === 'failed-summary') await expect(compact).rejects.toThrow('token cap');
  else {
    await compact;
    expect(JSON.stringify(session.inspect().messages)).toContain('Summary of the previous turn.');
  }
  if (scenario === 'close-and-resume') {
    // A manual /compact finishes without a prompt and releases the worker.
    await bounded(session.close(), 15_000, 'manual compaction close');
    session = await transport.open(request);
  }
  const turn = await bounded(session.prompt('Continue after compaction.'), 15_000, 'continuation');
  expect(turn).toMatchObject({
    finalAssistantText: 'Continued successfully.', stopReason: 'stop',
    inspect: { sessionId: original.sessionId, sessionFile: original.sessionFile },
  });
  expect(provider.requests).toHaveLength(3);
  const continuation = JSON.stringify(provider.requests[2]);
  expect(continuation).toContain(scenario === 'failed-summary' ? 'A previous response.' : 'Summary of the previous turn.');
  await bounded(session.close(), 15_000, 'session close');
}, 60_000);

test.each(['in-process', 'restricted-process'] as const)(
  'the %s transport follows the Agent session contract',
  async kind => {
    const root = await mkdtemp(join(tmpdir(), `graph-agent-session-${kind}-`));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'project');
    await mkdir(workspace);
    const provider = await openaiServer([
      { text: 'first response' },
      { status: 400, error: 'scripted provider failure', usage: { prompt_tokens: 0, completion_tokens: 0 } },
      { text: 'fresh response' },
    ]);
    cleanup.push(() => provider.close());
    const gate = new CallBroker(join(root, 'calls.sqlite'), `agent-contract-${kind}`);
    cleanup.push(() => gate.close());
    const transport = kind === 'in-process'
      ? createInProcessAgentSessionTransport({ modelRuntime: provider.runtime })
      : createRestrictedProcessAgentSessionTransport();
    const request: AgentSessionRequest = {
      binding: { instanceId: `agent-${kind}`, nodeId: 'work', definitionVersion: 'coder@1' },
      workspace,
      stateDir: join(root, 'state'),
      model: provider.model,
      stream: controlledOpenAIStream(gate, 'host-only-contract-key'),
      tools: [],
      bundleDigest: 'a'.repeat(64),
      toolPolicyDigest: 'b'.repeat(64),
      runtimePolicyDigest: 'c'.repeat(64),
      readOnly: true,
      broker: gate,
    };

    const events: string[] = [];
    const first = await transport.open({ ...request, onEvent: event => events.push(event.type) });
    const ready = first.inspect();
    const firstTurn = await first.prompt('first turn');
    expect(firstTurn).toMatchObject({
      finalAssistantText: 'first response',
      stopReason: 'stop',
      inspect: { sessionId: ready.sessionId, model: provider.model.id },
    });
    expect(JSON.stringify(firstTurn.inspect.messages)).toContain('first response');
    expect(events.length).toBeGreaterThan(0);
    await expect(first.steer('too late')).rejects.toThrow('not accepting steering');
    await first.close();
    await first.close();
    await expect(first.prompt('after close')).rejects.toThrow('closed');
    await expect(first.steer('after close')).rejects.toThrow('closed');

    const failed = await transport.open(request);
    const failedTurn = await failed.prompt('provider failure');
    expect(failedTurn.stopReason).toBe('error');
    expect(failedTurn.errorMessage).toContain('scripted provider failure');
    await failed.close();

    const fresh = await transport.open({ ...request, freshSession: true });
    const freshTurn = await fresh.prompt('fresh turn');
    expect(freshTurn.finalAssistantText).toBe('fresh response');
    expect(freshTurn.inspect.sessionId).not.toBe(ready.sessionId);
    await fresh.close();
  },
  120_000,
);

test.each(['in-process', 'restricted-process'] as const)(
  'the %s transport settles a reasoning-only output-limit response without hanging',
  async kind => {
    const root = await mkdtemp(join(tmpdir(), `graph-agent-session-length-${kind}-`));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'project');
    await mkdir(workspace);
    const provider = await openaiServer([{
      thinking: 'I keep reasoning without producing a tool call or answer. '.repeat(800),
      finishReason: 'length',
      usage: {
        prompt_tokens: 128,
        completion_tokens: 256,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 256 },
      },
    }]);
    cleanup.push(() => provider.close());
    const gate = new CallBroker(join(root, 'calls.sqlite'), `agent-length-${kind}`);
    cleanup.push(() => gate.close());
    const transport = kind === 'in-process'
      ? createInProcessAgentSessionTransport({ modelRuntime: provider.runtime })
      : createRestrictedProcessAgentSessionTransport();
    const session = await transport.open({
      binding: { instanceId: `agent-length-${kind}`, nodeId: 'master', definitionVersion: 'master@1' },
      workspace,
      stateDir: join(root, 'state'),
      model: provider.model,
      stream: controlledOpenAIStream(gate, 'host-only-length-key'),
      tools: [],
      bundleDigest: 'd'.repeat(64),
      toolPolicyDigest: 'e'.repeat(64),
      runtimePolicyDigest: 'f'.repeat(64),
      readOnly: true,
      broker: gate,
    });

    const turn = await bounded(session.prompt('Keep thinking.'), 15_000, 'truncated prompt');
    expect(turn).toMatchObject({ stopReason: 'length', finalAssistantText: '' });
    await bounded(session.close(), 15_000, 'truncated session close');
  },
  40_000,
);
