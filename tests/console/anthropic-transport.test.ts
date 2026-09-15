import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import type { Context } from '@earendil-works/pi-ai';
import { controlledOpenAIStream, type SendGate } from '../../src/runtime/controlled-openai.ts';
import type { TokenUsage } from '../../src/runtime/call-broker.ts';
import { PROVIDER_TEMPLATES, providerTemplate, templateModelEntry } from '../../src/catalog/providers.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

interface Recorded { url: string; headers: Record<string, string>; body: unknown }

async function anthropicServer(options: { events?: string[]; status?: number; body?: unknown } = {}) {
  const requests: Recorded[] = [];
  const events = options.events ?? [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"usage":{"input_tokens":25,"output_tokens":0,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from Claude"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      url: req.url ?? '',
      headers: Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value ?? ''])),
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    if (options.status) {
      res.writeHead(options.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(options.body ?? { type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(event);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { baseUrl, requests };
}

function anthropicModel(baseUrl: string): Model<'anthropic-messages'> {
  return {
    id: 'claude-test', name: 'Claude test', provider: 'anthropic', api: 'anthropic-messages', baseUrl,
    reasoning: false, input: ['text'], contextWindow: 200_000, maxTokens: 1_024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function collectingGate() {
  const settled: (TokenUsage | null)[] = [];
  let dispatches = 0;
  const gate: SendGate = {
    dispatch(_id, _reservation, send) { dispatches += 1; return send(); },
    settle(_id, usage) { settled.push(usage); },
  };
  return { gate, settled, dispatches: () => dispatches };
}

async function consume(stream: AssistantMessageEventStream | Promise<AssistantMessageEventStream>) {
  const events: { type: string; text?: string; error?: string }[] = [];
  for await (const event of await stream) {
    if (event.type === 'text_delta' || (event.type as string) === 'text_start' || (event.type as string) === 'text_end') events.push({ type: event.type });
    if (event.type as string === 'error') events.push({ type: 'error', error: String((event as unknown as { error?: { errorMessage?: string } }).error?.errorMessage) });
    if (event.type === 'done') break;
  }
  return events;
}

test('the anthropic Messages transport sends the native request shape and normalizes cache usage', async () => {
  const server = await anthropicServer();
  const { gate, settled, dispatches } = collectingGate();
  const context: Context = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] };
  const stream = controlledOpenAIStream(gate, () => 'key-one', undefined, 'anthropic-messages')(anthropicModel(server.baseUrl), context, { apiKey: 'ignored', maxTokens: 64 });
  const events = await consume(stream);
  expect(events.some(event => event.type === 'error')).toBe(false);
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0]!.url.startsWith('/v1/messages')).toBe(true);
  expect(server.requests[0]!.headers['x-api-key']).toBe('key-one');
  expect(server.requests[0]!.headers.authorization).toBeUndefined();
  expect(server.requests[0]!.body).toMatchObject({ model: 'claude-test', max_tokens: 64, stream: true });
  expect(dispatches()).toBe(1);
  // 25 non-cache input, 7 output, 10 cache read, 5 cache write.
  expect(settled).toEqual([{ input: 25, output: 7, cacheRead: 10, cacheWrite: 5 }]);
}, 60_000);

test('a missing anthropic usage event settles as unknown instead of zero', async () => {
  const server = await anthropicServer({ events: [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ] });
  const { gate, settled } = collectingGate();
  const stream = controlledOpenAIStream(gate, 'key-one', undefined, 'anthropic-messages')(anthropicModel(server.baseUrl), { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }, { apiKey: 'ignored', maxTokens: 64 });
  await consume(stream);
  expect(settled).toEqual([null]);
}, 60_000);

test('an anthropic error response is a transport failure, not a provider success', async () => {
  const server = await anthropicServer({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'nope' } } });
  const { gate, settled } = collectingGate();
  let threw = false;
  try {
    const stream = controlledOpenAIStream(gate, 'key-one', undefined, 'anthropic-messages')(anthropicModel(server.baseUrl), { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }, { apiKey: 'ignored', maxTokens: 64 });
    for await (const event of await stream) { if (event.type === 'error') break; }
  } catch { threw = true; }
  // The SDK reports the HTTP error inside the stream error event; either way the
  // invocation settles with unknown usage rather than a fabricated zero.
  expect(threw || settled.length === 1).toBe(true);
  if (settled.length) expect(settled).toEqual([null]);
}, 60_000);

test('provider templates only use verified transports and never invent zero prices', () => {
  expect(PROVIDER_TEMPLATES.length).toBeGreaterThanOrEqual(5);
  for (const template of PROVIDER_TEMPLATES) {
    expect(['openai-completions', 'anthropic-messages']).toContain(template.api);
    for (const model of template.models) {
      expect(model.contextWindow).toBeGreaterThan(model.maxTokens);
      if (!model.cost) expect(model.pricing).toBeUndefined();
      if (model.cost) expect(model.cost.input + model.cost.output).toBeGreaterThan(0);
    }
  }
  const entry = templateModelEntry(providerTemplate('anthropic')!, providerTemplate('anthropic')!.models[0]!, 'anthropic-key');
  expect(entry).toMatchObject({ api: 'anthropic-messages', provider: 'anthropic', credentialId: 'anthropic-key' });
  expect(entry.cost).toBeUndefined();
  expect(entry.pricing).toBeUndefined();
});
