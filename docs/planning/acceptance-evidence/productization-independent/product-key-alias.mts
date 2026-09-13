import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import type { Model } from '@earendil-works/pi-ai';
import { controlledOpenAIStream } from '../../../../src/runtime/controlled-openai.ts';
import { createModelScheduler, type SlotRequest } from '../../../../src/runtime/model-scheduler.ts';
import { openTaskRuntime } from '../../../../src/core/task-runtime.ts';
import { openaiServer } from '../../../../tests/fixtures/openai-server.ts';
import type { SendGate } from '../../../../src/runtime/controlled-openai.ts';

const cleanup: (() => Promise<void> | void)[] = [];
function sleep(milliseconds: number) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await sleep(10);
  }
}

function gate() {
  const state = { dispatches: 0 };
  const sendGate: SendGate = {
    dispatch(_id, _reservation, send) { state.dispatches += 1; return send(); },
    settle() { /* usage accounting is exercised elsewhere */ },
  };
  return { gate: sendGate, state };
}

/** Streaming provider that tracks real concurrency per credential header. */
async function provider(options: { bodyDelayMs?: number; status?: number } = {}) {
  const state = { inFlight: 0, maxInFlight: 0, requests: 0, byKey: new Map<string, number>(), maxByKey: new Map<string, number>(), maxGroup: 0 };
  const group = new Map<string, number>();
  const server = createServer(async (request, response) => {
    state.requests += 1;
    const key = request.headers.authorization ?? '';
    const groupKey = key.includes('shared') ? 'shared' : key;
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const keyCount = (state.byKey.get(key) ?? 0) + 1;
    state.byKey.set(key, keyCount);
    state.maxByKey.set(key, Math.max(state.maxByKey.get(key) ?? 0, keyCount));
    const groupCount = (group.get(groupKey) ?? 0) + 1;
    group.set(groupKey, groupCount);
    state.maxGroup = Math.max(state.maxGroup, groupCount);
    for await (const _chunk of request) { /* drain the request body */ }
    if (options.status) {
      response.writeHead(options.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'synthetic failure' } }));
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`);
      await sleep(options.bodyDelayMs ?? 0);
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
      response.end('data: [DONE]\n\n');
    }
    state.inFlight -= 1;
    state.byKey.set(key, (state.byKey.get(key) ?? 1) - 1);
    group.set(groupKey, (group.get(groupKey) ?? 1) - 1);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const model = (): Model<'openai-completions'> => ({
    id: 'local', name: 'local', provider: 'graph-openai', api: 'openai-completions', baseUrl,
    reasoning: false, input: ['text'], contextWindow: 32_000, maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  return { state, model };
}

function slotFor(scheduler: ReturnType<typeof createModelScheduler>, request: SlotRequest) {
  return { acquire: (signal?: AbortSignal) => scheduler.acquire(request, signal) };
}

async function send(stream: ReturnType<typeof controlledOpenAIStream>, model: Model<'openai-completions'>) {
  const events = await stream(model, { messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }] });
  const result = await events.result();
  return result.stopReason;
}


const scheduler = createModelScheduler();
const fixture = await provider({bodyDelayMs:250});
try {
 const reasons = await Promise.all(['alias-a','alias-b'].map(credentialId => send(controlledOpenAIStream(gate().gate, 'same-synthetic-key', slotFor(scheduler,{credentialId,limit:1})),fixture.model())));
 console.log(JSON.stringify({scenario:'same-key-two-credential-aliases',perAliasLimit:1,maxActualKeyInFlight:fixture.state.maxByKey.get('Bearer same-synthetic-key'),reasons}));
} finally {for(const action of cleanup.reverse()) await action();}
