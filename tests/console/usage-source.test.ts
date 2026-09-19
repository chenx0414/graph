import { afterEach, expect, test } from 'vitest';
import type { Context } from '@earendil-works/pi-ai';
import { controlledOpenAIStream, type SendGate } from '../../src/runtime/controlled-openai.ts';
import type { TokenUsage } from '../../src/runtime/call-broker.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

function collectingGate() {
  const settled: (TokenUsage | null)[] = [];
  const gate: SendGate = {
    dispatch(_id, _reservation, send) { return send(); },
    settle(_id, usage) { settled.push(usage); },
  };
  return { gate, settled };
}

async function consume(stream: ReturnType<ReturnType<typeof controlledOpenAIStream>>) {
  for await (const event of await Promise.resolve(stream)) {
    if (event.type === 'done' || event.type === 'error') break;
  }
}

function bounded<T>(promise: Promise<T>, milliseconds: number, label: string) {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${label} did not settle within ${milliseconds}ms`)), milliseconds);
      timeout.unref?.();
    }),
  ]);
}

test('a completed SSE response settles before the provider closes its connection', async () => {
  const provider = await openaiServer([{ text: 'already complete', holdOpen: true }]);
  cleanup.push(() => provider.close());
  const context: Context = { messages: [{ role: 'user', content: 'Answer now.', timestamp: 1 }] };
  const tracked = collectingGate();

  await bounded(
    consume(controlledOpenAIStream(tracked.gate, 'key')(provider.model, context, { apiKey: 'ignored' })),
    1_000,
    'completed SSE response',
  );

  expect(tracked.settled).toHaveLength(1);
  expect(tracked.settled[0]).toMatchObject({ usageSource: 'authoritative', output: 10 });
});

test('usage provenance prefers provider, then account delta, then local estimation', async () => {
  const provider = await openaiServer([
    { text: 'authoritative answer' },
    { text: 'account delta answer', usage: null },
    { text: 'estimated answer', usage: null },
  ]);
  cleanup.push(() => provider.close());
  const context: Context = { messages: [{ role: 'user', content: 'Explain the token usage source.', timestamp: 1 }] };

  const authoritative = collectingGate();
  await consume(controlledOpenAIStream(authoritative.gate, 'key')(provider.model, context, { apiKey: 'ignored' }));
  expect(authoritative.settled).toHaveLength(1);
  expect(authoritative.settled[0]).toMatchObject({ usageSource: 'authoritative' });

  const accountDelta = collectingGate();
  let deltaCalls = 0;
  await consume(controlledOpenAIStream(accountDelta.gate, 'key', undefined, 'openai-completions', {
    estimateMissing: true,
    accountUsageDelta: () => {
      deltaCalls += 1;
      return { input: 7, output: 3, cacheRead: 1, cacheWrite: 0 };
    },
  })(provider.model, context, { apiKey: 'ignored' }));
  expect(deltaCalls).toBe(1);
  expect(accountDelta.settled[0]).toEqual({
    input: 7,
    output: 3,
    cacheRead: 1,
    cacheWrite: 0,
    usageSource: 'account_delta',
  });

  const estimated = collectingGate();
  await consume(controlledOpenAIStream(estimated.gate, 'key', undefined, 'openai-completions', {
    estimateMissing: true,
  })(provider.model, context, { apiKey: 'ignored' }));
  expect(estimated.settled[0]).toMatchObject({ usageSource: 'estimated' });
  expect(estimated.settled[0]!.input).toBeGreaterThan(0);
  expect(estimated.settled[0]!.output).toBeGreaterThan(0);
}, 60_000);
