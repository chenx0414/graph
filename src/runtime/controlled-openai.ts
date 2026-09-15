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
 * One logical provider request. A transport failure before any response header
 * cannot prove the provider did not receive or bill the request, so it is
 * recorded as unknown usage and never resent silently. Only failures that prove
 * nothing was sent (DNS failure, refused connection, connect timeout) are
 * resent, and each resend is a new invocation that passes the gate again.
 */
export interface GatedProviderFetchOptions {
  reservation: number;
  fetchImpl?: typeof fetch;
  delay?: (milliseconds: number) => Promise<void>;
  maxAttempts?: number;
  /** Acquire a concurrency slot for one attempt; released on retry, failure or response end. */
  acquireSlot?: () => Promise<() => void>;
  /** Called once for the successful attempt so the caller can settle its usage. */
  onResponse?: (id: string, response: Response, release: () => void) => Promise<void> | void;
}

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const RETRYABLE_TRANSPORT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']);

function transportCode(error: unknown) {
  if (!(error instanceof Error) || error.name === 'AbortError') return undefined;
  const cause = (error as { cause?: unknown }).cause;
  return typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
}

export async function gatedProviderFetch(
  broker: SendGate, input: RequestInfo | URL, init: RequestInit | undefined, options: GatedProviderFetchOptions,
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    const id = randomUUID();
    let sent = false;
    let release: (() => void) | undefined;
    try {
      // Every attempt acquires its own slot, so a retry must pass the queue and
      // the gate again instead of holding capacity through the backoff.
      if (options.acquireSlot) release = await options.acquireSlot();
      const response = await broker.dispatch(id, options.reservation, () => {
        sent = true;
        return (options.fetchImpl ?? fetch)(input, init);
      });
      void options.onResponse?.(id, response, () => release?.());
      if (!response.body) { release?.(); return response; }
      // Capacity covers the whole body, not just the headers.
      const wrapped = response.body.pipeThrough(new TransformStream({ flush() { release?.(); } }));
      return new Response(wrapped, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      release?.();
      if (!sent) throw error; // The gate refused before anything was sent.
      const code = transportCode(error);
      const notSent = typeof code === 'string' && RETRYABLE_TRANSPORT_CODES.has(code);
      broker.settle(id, notSent ? ZERO_USAGE : null);
      if (!notSent || attempt >= maxAttempts) throw error;
      await (options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(500 * attempt);
    }
  }
}

/** A host-wide concurrency slot for one logical provider send. */
export interface StreamSlot {
  acquire(signal?: AbortSignal): Promise<() => void>;
}

/** Controlled lower-level adapter, currently verified for OpenAI chat-completions SSE. */
export function controlledOpenAIStream(broker: SendGate, apiKey: string | (() => string), slot?: StreamSlot): StreamFn {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let evidence: Promise<void> | undefined;
      try {
        if (model.api !== 'openai-completions') throw new Error('Unverified model transport');
        let sent = false;
        // Resolve the credential at actual send time so a key rotation that
        // happened while this request waited applies to unsent calls.
        const key = typeof apiKey === 'function' ? apiKey() : apiKey;
        const stream = streamSimple(model as Model<'openai-completions'>, context, {
          ...options, apiKey: key, maxRetries: 0, transport: 'sse',
          // Reserve an upper bound for this model's accepted context and output.
          maxTokens: Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens),
          fetch: async (input, init) => {
            if (sent) throw new Error('Unexpected provider retry; use a new controlled invocation');
            sent = true;
            // The slot is acquired per attempt inside gatedProviderFetch, so a
            // retry re-queues and re-passes the gate after releasing capacity.
            return gatedProviderFetch(broker, input, { ...init, redirect: 'error' }, {
              reservation: model.contextWindow + model.maxTokens,
              ...(slot ? { acquireSlot: () => slot.acquire(options?.signal) } : {}),
              onResponse: (id, response, release) => {
                // Consuming the evidence clone to the end also proves the
                // provider finished sending, so it can release the slot too.
                evidence = readUsage(response.clone()).then(usage => { broker.settle(id, usage); release(); }, () => { broker.settle(id, null); release(); });
              },
            });
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
