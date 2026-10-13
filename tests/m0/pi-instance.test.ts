import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model, type ToolResultMessage } from '@earendil-works/pi-ai';
import type { ControlledStream as StreamFn } from '../../src/runtime/controlled-openai.ts';
import { externallyGated } from '../../src/runtime/tool-gating.ts';
import { openDurableAgent } from '../fixtures/durable-agent.ts';
import { modelA, reply, respond, testModelRuntime } from '../fixtures/models.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** An assistant message that asks for exactly one tool call, like a real turn. */
function toolCallMessage(model: Model<Api>, name: string): AssistantMessage {
  const message = reply(model, '');
  message.content = [{ type: 'toolCall', id: `call-${name}`, name, arguments: {} }];
  message.stopReason = 'toolUse';
  return message;
}

const toolResults = (messages: unknown[]) => messages.filter((message): message is ToolResultMessage =>
  Boolean(message && typeof message === 'object' && 'role' in message && message.role === 'toolResult'));

test('the session constructor uses the exact tool allowlist instead of activating built-ins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-instance-tools-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const probe = externallyGated({
    name: 'probe',
    label: 'Probe',
    description: 'Probe the exact allowlist.',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
  });
  const instance = await openDurableAgent({
    binding: { instanceId: 'agent-tools', nodeId: 'node-tools', definitionVersion: 'coder@1' },
    workspace,
    stateDir: join(root, 'state'),
    model: modelA,
    modelRuntime: await testModelRuntime(),
    stream: respond,
    tools: [probe],
  });
  try {
    const inspect = instance.inspect();
    expect(inspect.activeTools).toEqual(['probe']);
    expect(inspect.registeredTools).toContain('probe');
    expect(inspect.activeTools).not.toContain('read');
    expect(inspect.activeTools).not.toContain('bash');
  } finally {
    await instance.close();
  }
});

test('stop soft-stops the running turn: the in-flight tool finishes and no further model request is sent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-instance-stop-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  let instance: Awaited<ReturnType<typeof openDurableAgent>> | undefined;
  let modelRequests = 0;
  let toolRuns = 0;
  const probe = externallyGated({
    name: 'probe', label: 'Probe', description: 'Stop the turn while this call is in flight.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      toolRuns += 1;
      await instance!.stop();
      return { content: [{ type: 'text' as const, text: 'probe finished' }], details: {} };
    },
  });
  const stream: StreamFn = model => {
    modelRequests += 1;
    const output = createAssistantMessageEventStream();
    const message = modelRequests === 1 ? toolCallMessage(model, 'probe') : reply(model, 'Resumed response');
    output.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
    return output;
  };
  instance = await openDurableAgent({
    binding: { instanceId: 'agent-stop', nodeId: 'node-stop', definitionVersion: 'coder@1' },
    workspace, stateDir: join(root, 'state'), model: modelA, modelRuntime: await testModelRuntime(),
    stream, tools: [probe],
  });
  try {
    const sessionId = instance.inspect().sessionId;
    await instance.prompt('Run the probe');
    // The in-flight tool call finished, but the turn ended instead of asking the model again.
    expect(toolRuns).toBe(1);
    expect(modelRequests).toBe(1);
    expect(instance.inspect().messages.at(-1)).toMatchObject({ role: 'toolResult', toolName: 'probe' });
    // The soft stop retained the session (no dispose), so the next prompt continues it.
    await instance.prompt('Continue after the stop');
    expect(modelRequests).toBe(2);
    expect(instance.inspect().sessionId).toBe(sessionId);
    expect(instance.inspect().messages.at(-1)).toMatchObject({
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Resumed response' }],
    });
  } finally {
    await instance.close();
  }
});

test('stop with no running turn is idempotent and leaves the session usable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-instance-stop-idle-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const instance = await openDurableAgent({
    binding: { instanceId: 'agent-stop-idle', nodeId: 'node-stop-idle', definitionVersion: 'coder@1' },
    workspace, stateDir: join(root, 'state'), model: modelA, modelRuntime: await testModelRuntime(), stream: respond,
  });
  try {
    await expect(instance.stop()).resolves.toBeUndefined();
    await expect(instance.stop()).resolves.toBeUndefined();
    await instance.prompt('After an idle stop');
    expect(instance.inspect().messages.at(-1)).toMatchObject({
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Saved response' }],
    });
  } finally {
    await instance.close();
  }
});

test('a large tool result reaches the model in full twice and as a readable summary with a handle afterwards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-instance-tool-results-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const big = `head-marker\n${'line\n'.repeat(4_000)}tail-marker`;
  let modelRequests = 0;
  const probe = externallyGated({
    name: 'probe', label: 'Probe', description: 'Return a large result every time.',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text' as const, text: big }], details: {} }),
  });
  const stream: StreamFn = model => {
    modelRequests += 1;
    const output = createAssistantMessageEventStream();
    const message = modelRequests <= 3 ? toolCallMessage(model, 'probe') : reply(model, 'Done');
    output.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
    return output;
  };
  const instance = await openDurableAgent({
    binding: { instanceId: 'agent-tool-results', nodeId: 'node-tool-results', definitionVersion: 'coder@1' },
    workspace, stateDir: join(root, 'state'), model: modelA, modelRuntime: await testModelRuntime(),
    stream, tools: [probe],
  });
  try {
    await instance.prompt('Run the probe three times');
    expect(modelRequests).toBe(4);
    const results = toolResults(instance.inspect().messages);
    expect(results).toHaveLength(3);
    const textOf = (message: (typeof results)[number]) =>
      (message.content as { type: string; text?: string }[]).map(part => part.text ?? '').join('');

    // The first two views are the tool's own result, byte for byte.
    expect(textOf(results[0]!)).toBe(big);
    expect(textOf(results[1]!)).toBe(big);

    // The third is bounded, still shows the head, and names a readable handle.
    const third = textOf(results[2]!);
    expect(third.length).toBeLessThanOrEqual(1_024);
    expect(third).toContain('head-marker');
    expect(third).toContain('omitted');
    const handle = /handle: (\S+)/.exec(third)?.[1];
    expect(handle).toBeTruthy();
    expect(await readFile(handle!, 'utf8')).toBe(big);
  } finally {
    await instance.close();
  }
});

test('the occurrence count for a repeated large result survives an instance reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-instance-tool-results-persist-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const stateDir = join(root, 'state');
  const big = `head-marker\n${'line\n'.repeat(4_000)}tail-marker`;
  const probe = externallyGated({
    name: 'probe', label: 'Probe', description: 'Return a large result every time.',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text' as const, text: big }], details: {} }),
  });
  // A stream that asks for the probe a fixed number of times, then answers.
  const streamWithCalls = (calls: number): StreamFn => {
    let seen = 0;
    return model => {
      seen += 1;
      const output = createAssistantMessageEventStream();
      const message = seen <= calls ? toolCallMessage(model, 'probe') : reply(model, 'Done');
      output.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
      return output;
    };
  };
  const binding = { instanceId: 'agent-tool-results-persist', nodeId: 'node-tool-results-persist', definitionVersion: 'coder@1' };
  const textOf = (message: { content: unknown }) =>
    (message.content as { type: string; text?: string }[]).map(part => part.text ?? '').join('');

  const first = await openDurableAgent({
    binding, workspace, stateDir, model: modelA, modelRuntime: await testModelRuntime(),
    stream: streamWithCalls(2), tools: [probe],
  });
  try {
    await first.prompt('Two large results');
    const results = toolResults(first.inspect().messages);
    expect(results).toHaveLength(2);
    expect(textOf(results[0]!)).toBe(big);
    expect(textOf(results[1]!)).toBe(big);
  } finally {
    await first.close();
  }

  // A fresh instance over the same persisted state must remember that this exact result
  // was already seen twice, so this next view is the bounded one - and its handle, written
  // by the previous instance, is still readable byte for byte.
  const second = await openDurableAgent({
    binding, workspace, stateDir, model: modelA, modelRuntime: await testModelRuntime(),
    stream: streamWithCalls(1), tools: [probe],
  });
  try {
    await second.prompt('One more view');
    const third = toolResults(second.inspect().messages).at(-1)!;
    const text = textOf(third);
    expect(text.length).toBeLessThanOrEqual(1_024);
    expect(text).toContain('omitted');
    const handle = /handle: (\S+)/.exec(text)?.[1];
    expect(handle).toBeTruthy();
    expect(await readFile(handle!, 'utf8')).toBe(big);
  } finally {
    await second.close();
  }
});

// The telemetry seam sits inside every instance, so it has to report what actually happened: the
// tool that ran, how long it took, and whether its result was an error. Both outcomes are covered
// here, because a table that only ever sees successes would report a 100% success rate forever.
test('the tool seam reports every call with its duration and its outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-instance-tool-calls-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const calls: { tool: string; ms: number; isError: boolean }[] = [];
  const good = externallyGated({
    name: 'probe', label: 'Probe', description: 'Succeed.',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
  });
  const bad = externallyGated({
    name: 'boom', label: 'Boom', description: 'Fail.',
    parameters: { type: 'object', properties: {} },
    execute: async () => { throw new Error('boom failed'); },
  });
  let modelRequests = 0;
  const stream: StreamFn = model => {
    modelRequests += 1;
    const output = createAssistantMessageEventStream();
    const message = modelRequests === 1 ? toolCallMessage(model, 'probe')
      : modelRequests === 2 ? toolCallMessage(model, 'boom')
        : reply(model, 'Done');
    output.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
    return output;
  };
  const instance = await openDurableAgent({
    binding: { instanceId: 'agent-tool-calls', nodeId: 'node-tool-calls', definitionVersion: 'coder@1' },
    workspace, stateDir: join(root, 'state'), model: modelA, modelRuntime: await testModelRuntime(),
    stream, tools: [good, bad],
    onToolCall: call => calls.push(call),
  });
  try {
    await instance.prompt('Run both probes');
    expect(calls.map(call => call.tool)).toEqual(['probe', 'boom']);
    expect(calls.every(call => call.ms >= 0)).toBe(true);
    expect(calls[0]!.isError).toBe(false);
    expect(calls[1]!.isError).toBe(true);
  } finally {
    await instance.close();
  }
});
