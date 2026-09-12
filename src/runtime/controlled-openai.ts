import { randomUUID } from 'node:crypto';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { TokenUsage } from './call-broker.ts';

/** Pause and usage gate around one actual provider send. CallBroker satisfies this. */
export interface SendGate {
  dispatch<T>(id: string, reservation: number, send: () => T): T;
  settle(id: string, usage: TokenUsage | null): void;
}

function parseUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const input = raw.prompt_tokens;
  const output = raw.completion_tokens;
  const details = raw.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  const cache = details?.cached_tokens ?? 0;
  if (![input, output, cache].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return null;
  if ((cache as number) > (input as number)) return null;
  if (raw.total_tokens !== undefined && raw.total_tokens !== (input as number) + (output as number)) return null;
  return { input: (input as number) - (cache as number), output: output as number, cacheRead: cache as number, cacheWrite: 0 };
}

async function readUsage(response: Response): Promise<TokenUsage | null> {
  // A bounded clone observes raw evidence; an SDK's zero-filled error is not evidence.
  const reader = response.body?.getReader();
  if (!reader) return null;
  let text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > 8_000_000) { void reader.cancel(); return null; }
    }
    text += decoder.decode();
    if (response.headers.get('content-type')?.includes('application/json')) return parseUsage(JSON.parse(text).usage);
    let usage: TokenUsage | null = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
      const data = JSON.parse(line.slice(5));
      if (data.usage) usage = parseUsage(data.usage);
    }
    return usage;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

/**
 * A transport failure before any response header means the provider reported no
 * usage at all. Retrying it inside the same gated invocation keeps pause and
 * budget checks once per logical request while a random connection reset no
 * longer costs an entire Agent session. Anything that resolved a response is
 * never retried here; mid-stream failures still hold unknown usage for review.
 */
function retryableTransportError(error: unknown) {
  if (!(error instanceof Error) || error.name === 'AbortError') return false;
  const cause = (error as { cause?: unknown }).cause;
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  // A refused redirect is a policy result, not a transport reset; socket-level
  // failures are the only ones worth resending.
  return typeof code === 'string' && ['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND'].includes(code);
}

async function fetchWithTransportRetry(input: RequestInfo | URL, init: RequestInit | undefined) {
  const replayable = init?.body === undefined || typeof init.body === 'string';
  for (let attempt = 1; ; attempt++) {
    try { return await fetch(input, init); }
    catch (error) {
      if (!replayable || attempt >= 3 || !retryableTransportError(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
}

/** Controlled lower-level adapter, currently verified for OpenAI chat-completions SSE. */
export function controlledOpenAIStream(broker: SendGate, apiKey: string): StreamFn {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let evidence: Promise<void> | undefined;
      try {
        if (model.api !== 'openai-completions') throw new Error('Unverified model transport');
        let sent = false;
        const stream = streamSimple(model as Model<'openai-completions'>, context, {
          ...options, apiKey, maxRetries: 0, transport: 'sse',
          // Reserve an upper bound for this model's accepted context and output.
          maxTokens: Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens),
          fetch: (input, init) => {
            if (sent) throw new Error('Unexpected provider retry; use a new controlled invocation');
            sent = true;
            const id = randomUUID();
            const response = broker.dispatch(id, model.contextWindow + model.maxTokens, () => fetchWithTransportRetry(input, { ...init, redirect: 'error' }));
            evidence = response.then(async result => { broker.settle(id, await readUsage(result.clone())); }, () => { broker.settle(id, null); });
            return response;
          },
        });
        for await (const event of stream) {
          if (event.type === 'done' || event.type === 'error') await evidence;
          output.push(event);
        }
      } catch (error) {
        await evidence;
        const message: AssistantMessage = {
          role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [], stopReason: 'error', errorMessage: String(error), timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        output.push({ type: 'error', reason: 'error', error: message });
      }
    })();
    return output;
  };
}
