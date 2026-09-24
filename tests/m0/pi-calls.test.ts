import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { openPiInstance } from '../../src/runtime/pi-instance.ts';
import { CallBroker, type TokenUsage } from '../../src/runtime/call-broker.ts';
import { controlledOpenAIStream, gatedProviderFetch } from '../../src/runtime/controlled-openai.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
async function fixture(plans: ResponsePlan[], tools: (broker: CallBroker, provider: Awaited<ReturnType<typeof openaiServer>>) => ToolDefinition[] = () => [],
  config: { auto?: boolean; systemPrompt?: string; onEvent?: (event: AgentSessionEvent, broker: CallBroker) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graph-pi-calls-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer(plans); cleanup.push(() => provider.close());
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1'); cleanup.push(() => broker.close());
  const instance = await openPiInstance({
    binding: { instanceId: 'agent-1', nodeId: 'node-1', definitionVersion: 'coder@1' },
    workspace: root, stateDir: join(root, 'session'), model: provider.model, modelRuntime: provider.runtime,
    stream: controlledOpenAIStream(broker, 'scripted-local-key'),
    tools: tools(broker, provider), broker,
    compaction: { enabled: config.auto ?? false, reserveTokens: 256, keepRecentTokens: 1 },
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    onEvent: event => config.onEvent?.(event, broker),
  });
  cleanup.push(() => instance.close());
  return { instance, broker, provider };
}

test('Graph owns the final system prompt, so the Pi working-directory line is replaced instead of appended', async () => {
  const composed = '<cwd>\nCurrent working directory: /tmp/graph-worktree\n</cwd>';
  const { instance, provider } = await fixture([{}], () => [], { systemPrompt: composed });
  await instance.prompt('Hello');
  const request = provider.requests[0] as { messages: { role: string; content: string }[] };
  const system = request.messages.find(message => message.role === 'system')!.content;
  // Exact equality is the point: nothing the Pi session builds on its own (the
  // trailing "Current working directory:" line, its coding-assistant preamble)
  // may survive into the request Graph sends.
  expect(system).toBe(composed);
});

test('native Pi HTTP calls pass the gate and raw cache/reasoning totals are charged once', async () => {
  const { instance, broker, provider } = await fixture([{}]);
  await instance.prompt('Hello');
  expect(provider.requests).toHaveLength(1);
  expect(broker.inspect()).toMatchObject({ used: 50, reserved: 0, status: 'ready' });
  broker.pause();
  await instance.prompt('Do not send while paused');
  expect(provider.requests).toHaveLength(1);
  expect(instance.inspect().messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'error' });
});

test('HTTP redirects cannot make hidden requests after the provider response pauses the gate', async () => {
  let gate: CallBroker;
  const { instance, broker, provider } = await fixture([{
    status: 307, redirect: '/v1/redirected', beforeReply: () => { gate.pause(); },
  }, {}]);
  gate = broker;
  await instance.prompt('Redirect this call');
  expect(provider.requests).toHaveLength(1);
  expect(broker.inspect()).toMatchObject({ used: 0, hold: 'unknown usage', status: 'paused' });
});

test.each(['pause', 'missing-usage'] as const)('an in-flight model can finish but its tools cannot start after %s', async trigger => {
  let gate: CallBroker;
  let executed = false;
  const { instance, broker, provider } = await fixture([{
    tools: [{ id: 'effect', name: 'effect', arguments: '{}' }],
    ...(trigger === 'missing-usage' ? { usage: null } : { beforeReply: () => { gate.pause(); } }),
  }], () => [{
    name: 'effect', label: 'Effect', description: 'Side effect', parameters: Type.Object({}),
    execute: async () => { executed = true; return { content: [{ type: 'text', text: 'Effect' }], details: {} }; },
  }]);
  gate = broker;
  await instance.prompt('Perform an action');
  expect(provider.requests).toHaveLength(1);
  expect(executed).toBe(false);
  expect(broker.inspect()).toMatchObject({ status: trigger === 'pause' ? 'paused' : 'blocked', used: trigger === 'pause' ? 50 : 0 });
});

test('an LLM request made inside a tool cannot bypass a pause', async () => {
  let nestedStopReason: string | undefined;
  const { instance, provider } = await fixture([{ tools: [{ id: 'nested', name: 'ask_model', arguments: '{}' }] }], (gate, service) => [{
    name: 'ask_model', label: 'Ask model', description: 'Nested model call', parameters: Type.Object({}),
    execute: async () => {
      gate.pause();
      const stream = await controlledOpenAIStream(gate, 'local-key')(service.model, { messages: [{ role: 'user', content: 'Nested request', timestamp: Date.now() }] });
      nestedStopReason = (await stream.result()).stopReason;
      return { content: [{ type: 'text', text: 'Nested request was stopped' }], details: {} };
    },
  }]);
  await instance.prompt('Use the model tool');
  expect(nestedStopReason).toBe('error');
  expect(provider.requests).toHaveLength(1);
});

test('changing models retains the same instance and cumulative usage account', async () => {
  const { instance, broker, provider } = await fixture([{}, {}]);
  await instance.prompt('Begin');
  const before = instance.inspect();
  await instance.setModel({ ...provider.model, id: 'replacement-model' });
  await instance.prompt('Continue');
  expect(instance.inspect()).toMatchObject({ binding: before.binding, sessionId: before.sessionId, model: 'replacement-model' });
  expect(broker.inspect()).toMatchObject({ used: 100, instanceId: 'agent-1' });
  expect(provider.requests).toMatchObject([{ model: 'local' }, { model: 'replacement-model' }]);
});

test('pausing inside the first tool blocks later tools in the same batch and the next model request', async () => {
  const executed: string[] = [];
  const { instance, broker, provider } = await fixture([{ tools: [
    { id: 'first', name: 'action', arguments: '{"name":"first"}' },
    { id: 'second', name: 'action', arguments: '{"name":"second"}' },
  ] }], broker => [{
    name: 'action', label: 'Action', description: 'Record an action',
    parameters: Type.Object({ name: Type.String() }),
    execute: async (_id, args) => {
      executed.push((args as { name: string }).name); broker.pause();
      return { content: [{ type: 'text', text: 'Done' }], details: {} };
    },
  }]);
  await instance.prompt('Run both tools');
  expect(executed).toEqual(['first']);
  expect(provider.requests).toHaveLength(1);
  expect(broker.inspect()).toMatchObject({ status: 'paused', used: 50, reserved: 0 });
});

test.each([{ usage: null }, { status: 400, error: 'maximum context length exceeded' }])(
  'a response without usage blocks retries and later requests: %j', async plan => {
    const { instance, broker, provider } = await fixture([plan]);
    await instance.prompt('Run');
    expect(broker.inspect()).toMatchObject({ status: 'blocked', used: 0, hold: 'unknown usage' });
    broker.resume();
    await instance.prompt('Retry');
    expect(provider.requests).toHaveLength(1);
  },
);

test('manual compaction and branch summaries use the same actual-send gate', async () => {
  const { instance, broker, provider } = await fixture([{}, {}, {}, {}, {}, {}]);
  await instance.prompt('First topic');
  const first = instance.inspect().leafId!;
  await instance.prompt('A later topic to summarize');
  broker.pause();
  await expect(instance.compact()).rejects.toThrow();
  await expect(instance.navigate(first, true)).rejects.toThrow();
  expect(provider.requests).toHaveLength(2);
  broker.resume();
  await instance.navigate(first, true);
  expect(provider.requests).toHaveLength(3);
  await instance.prompt('A new branch');
  await instance.compact();
  // Pi summarizes the conversation prefix and split turn separately.
  expect(provider.requests).toHaveLength(6);
  expect(broker.inspect().used).toBe(300);
});

test.each(['threshold', 'overflow'] as const)('automatic %s compaction cannot send after its start event pauses the instance', async reason => {
  const seen: string[] = [];
  const plans: ResponsePlan[] = reason === 'threshold'
    ? [{ usage: { prompt_tokens: 31_900, completion_tokens: 10 } }]
    : [{}, { status: 400, error: 'maximum context length exceeded', usage: { prompt_tokens: 0, completion_tokens: 0 } }];
  const { instance, broker, provider } = await fixture(plans, () => [], {
    auto: true,
    onEvent: (event, gate) => { if (event.type === 'compaction_start') { seen.push(event.reason); gate.pause(); } },
  });
  await instance.prompt('Start topic');
  if (reason === 'overflow') await instance.prompt('Overflow this context');
  expect(seen).toEqual([reason]);
  expect(provider.requests).toHaveLength(reason === 'threshold' ? 1 : 2);
  expect(broker.inspect().status).toBe('paused');
});

test('a connection reset after the request was sent is not resent and holds unknown usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pi-retry-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let attempts = 0;
  const server = createServer(req => { attempts += 1; req.socket.destroy(); });
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1'); cleanup.push(() => broker.close());
  const model = {
    id: 'local', name: 'local', provider: 'graph-openai', api: 'openai-completions' as const,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    reasoning: false, input: ['text' as const], contextWindow: 32_000, maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const stream = await controlledOpenAIStream(broker, 'scripted-local-key')(model, { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] });
  expect((await stream.result()).stopReason).toBe('error');
  expect(attempts).toBe(1);
  expect(broker.inspect()).toMatchObject({ used: 0, hold: 'unknown usage', status: 'blocked', calls: [{ state: 'unknown' }] });
});

function fakeGate(pausedOnCall?: number) {
  const dispatches: string[] = [];
  const settled: { id: string; usage: TokenUsage | null }[] = [];
  return {
    dispatches, settled,
    dispatch<T>(id: string, _reservation: number, send: () => T): T {
      if (pausedOnCall !== undefined && dispatches.length + 1 === pausedOnCall) throw new Error('paused');
      dispatches.push(id);
      return send();
    },
    settle(id: string, usage: TokenUsage | null) { settled.push({ id, usage }); },
  };
}

const REFUSED = Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } });
const RESET = Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } });

test('a provider capacity answer is retried on the same logical send', async () => {
  const gate = fakeGate();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return calls === 1 ? new Response('model is at capacity', { status: 429 }) : new Response('ok', { status: 200 });
  };
  const response = await gatedProviderFetch(gate, 'http://provider.invalid/v1/chat', {}, { reservation: 10, fetchImpl, delay: async () => {} });
  expect(await response.text()).toBe('ok');
  expect(calls).toBe(2);
  expect(gate.dispatches).toHaveLength(2);
  // The rejected attempt produced no tokens, so it settles zero usage: an unknown settlement would
  // turn a provider hiccup into a blocking usage question for the user.
  expect(gate.settled).toHaveLength(1);
  expect(gate.settled[0]!.usage).toMatchObject({ input: 0, output: 0 });
  // A persistent capacity answer still reaches the caller so the node can fail honestly.
  let exhausted = 0;
  const alwaysBusy: typeof fetch = async () => { exhausted += 1; return new Response('at capacity', { status: 503 }); };
  const busy = await gatedProviderFetch(gate, 'http://provider.invalid/v1/chat', {}, { reservation: 10, fetchImpl: alwaysBusy, delay: async () => {}, maxAttempts: 2 });
  expect(busy.status).toBe(503);
  expect(exhausted).toBe(2);
});

test('a provably unsent request is retried as a new gated invocation', async () => {
  const gate = fakeGate();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) throw REFUSED;
    return new Response('ok', { status: 200 });
  };
  const response = await gatedProviderFetch(gate, 'http://provider.invalid/v1/chat', {}, { reservation: 10, fetchImpl, delay: async () => {} });
  expect(await response.text()).toBe('ok');
  expect(calls).toBe(2);
  expect(gate.dispatches).toHaveLength(2);
  expect(new Set(gate.dispatches).size).toBe(2);
  expect(gate.settled).toEqual([{
    id: gate.dispatches[0],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usageSource: 'authoritative' },
  }]);
});

test('a pause during retry backoff stops the resend', async () => {
  const gate = fakeGate(2);
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls += 1; throw REFUSED; };
  await expect(gatedProviderFetch(gate, 'http://provider.invalid/v1/chat', {}, { reservation: 10, fetchImpl, delay: async () => {} })).rejects.toThrow('paused');
  expect(calls).toBe(1);
  expect(gate.dispatches).toHaveLength(1);
});

test('an ambiguous transport failure is recorded as unknown usage without a resend', async () => {
  const gate = fakeGate();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls += 1; throw RESET; };
  await expect(gatedProviderFetch(gate, 'http://provider.invalid/v1/chat', {}, { reservation: 10, fetchImpl, delay: async () => {} })).rejects.toThrow('socket hang up');
  expect(calls).toBe(1);
  expect(gate.settled).toEqual([{ id: gate.dispatches[0], usage: null }]);
});
