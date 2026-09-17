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
