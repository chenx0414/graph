import { randomUUID } from 'node:crypto';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { streamSimple as openaiStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as anthropicStreamSimple } from '@earendil-works/pi-ai/api/anthropic-messages';
import { estimateContextTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';
import type { ModelApi } from '../catalog/models.ts';
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
  return {
    input: (input as number) - (cache as number),
    output: output as number,
    cacheRead: cache as number,
    cacheWrite: 0,
    usageSource: 'authoritative',
  };
}

function parseAnthropicUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const input = raw.input_tokens;
  const output = raw.output_tokens ?? 0;
  const cacheRead = raw.cache_read_input_tokens ?? 0;
  const cacheWrite = raw.cache_creation_input_tokens ?? 0;
  if (![input, output, cacheRead, cacheWrite].every(item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)) return null;
  return {
    input: input as number,
    output: output as number,
    cacheRead: cacheRead as number,
    cacheWrite: cacheWrite as number,
    usageSource: 'authoritative',
  };
}

async function readUsage(response: Response, api: 'openai-completions' | 'anthropic-messages' = 'openai-completions'): Promise<TokenUsage | null> {
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
    if (api === 'anthropic-messages') {
      if (response.headers.get('content-type')?.includes('application/json')) {
        const body = JSON.parse(text) as { usage?: unknown };
        return parseAnthropicUsage(body.usage);
      }
      // Anthropic streams input/cache usage once at message_start and the
      // cumulative output tokens on each message_delta.
      let usage: TokenUsage | null = null;
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let event: { type?: string; message?: { usage?: unknown }; usage?: unknown };
        try { event = JSON.parse(line.slice(5)); } catch { continue; }
        if (event.type === 'message_start') {
          usage = parseAnthropicUsage(event.message?.usage) ?? usage;
        } else if (event.type === 'message_delta' && usage) {
          const delta = parseAnthropicUsage({ ...(event.usage as object | undefined), input_tokens: usage.input, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheWrite });
          if (delta) usage = delta;
        }
      }
      return usage;
    }
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

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usageSource: 'authoritative' };
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

export interface AccountUsageDeltaInput {
  model: Model<ModelApi>;
  context: Context;
  /** A fresh clone owned by the callback; it may be consumed. */
  response: Response;
}

export interface ControlledStreamUsageOptions {
  /** Estimate a successful response when neither per-request nor account-level usage exists. */
  estimateMissing?: boolean;
  /** Provider adapter hook. It must return the account-level delta attributable to this send. */
  accountUsageDelta?: (input: AccountUsageDeltaInput) => Promise<TokenUsage | null> | TokenUsage | null;
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromContent).join('');
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  if (typeof item.text === 'string') return item.text;
  if (typeof item.thinking === 'string') return item.thinking;
  if (typeof item.partial_json === 'string') return item.partial_json;
  if (item.input !== undefined) return JSON.stringify(item.input);
  if (typeof item.content === 'string') return item.content;
  return '';
}

function openAIOutputText(body: unknown, contentType: string): string {
  if (contentType.includes('application/json')) {
    const message = (body as { choices?: { message?: unknown }[] }).choices?.[0]?.message;
    if (!message || typeof message !== 'object') return '';
    const record = message as { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown[] };
    return [
      textFromContent(record.content),
      typeof record.reasoning_content === 'string' ? record.reasoning_content : '',
      ...(Array.isArray(record.tool_calls) ? record.tool_calls.map(call => JSON.stringify(call)) : []),
    ].join('');
  }
  return '';
}

function anthropicOutputText(body: unknown, contentType: string): string {
  if (contentType.includes('application/json')) {
    const content = (body as { content?: unknown }).content;
    return textFromContent(content);
  }
  return '';
}

async function estimateMissingUsage(response: Response, api: 'openai-completions' | 'anthropic-messages', context: Context): Promise<TokenUsage | null> {
  if (!response.ok) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  const contentType = response.headers.get('content-type') ?? '';
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > 8_000_000) { void reader.cancel(); return null; }
    }
    text += decoder.decode();
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }

  let outputText = '';
  if (contentType.includes('application/json')) {
    try {
      const body = JSON.parse(text) as unknown;
      outputText = api === 'anthropic-messages' ? anthropicOutputText(body, contentType) : openAIOutputText(body, contentType);
    } catch {
      return null;
    }
  } else {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
      if (api === 'anthropic-messages') {
        if (event.type === 'content_block_delta') outputText += textFromContent(event.delta);
      } else {
        const delta = (event.choices as { delta?: unknown }[] | undefined)?.[0]?.delta;
        if (delta && typeof delta === 'object') {
          const record = delta as { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown[] };
          outputText += textFromContent(record.content);
          if (typeof record.reasoning_content === 'string') outputText += record.reasoning_content;
          if (Array.isArray(record.tool_calls)) outputText += record.tool_calls.map(call => JSON.stringify(call)).join('');
        }
      }
    }
  }

  const input = estimateContextTokens(context).tokens;
  const output = estimateTextTokens(outputText);
  if (input <= 0 && output <= 0) return null;
  return { input, output, cacheRead: 0, cacheWrite: 0, usageSource: 'estimated' };
}

/** Controlled lower-level adapter, currently verified for OpenAI chat-completions SSE. */
export function controlledOpenAIStream(
  broker: SendGate,
  apiKey: string | (() => string),
  slot?: StreamSlot,
  api: ModelApi = 'openai-completions',
  usageOptions: ControlledStreamUsageOptions = {},
): StreamFn {
  if (api !== 'openai-completions' && api !== 'anthropic-messages') throw new Error('Unverified model transport');
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let evidence: Promise<void> | undefined;
      try {
        if (model.api !== api) throw new Error('Unverified model transport');
        let sent = false;
        // Resolve the credential at actual send time so a key rotation that
        // happened while this request waited applies to unsent calls.
        const key = typeof apiKey === 'function' ? apiKey() : apiKey;
        const openCodeGo = model.provider === 'opencode-go' || model.baseUrl.includes('opencode.ai/zen/go');
        const headers = {
          ...(model.headers ?? {}),
          ...(openCodeGo && options?.sessionId ? { 'x-opencode-session': options.sessionId } : {}),
          ...(options?.headers ?? {}),
        };
        const streamOptions = {
          ...options, apiKey: key, maxRetries: 0 as const, transport: 'sse' as const,
          ...(Object.keys(headers).length ? { headers } : {}),
          // Reserve an upper bound for this model's accepted context and output.
          maxTokens: Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens),
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
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
                // Optional clones are created before the first await: the response
                // wrapper locks the original body immediately after this callback.
                const providerEvidence = response.clone();
                const accountEvidence = usageOptions.accountUsageDelta ? response.clone() : undefined;
                const estimateEvidence = usageOptions.estimateMissing ? response.clone() : undefined;
                const discard = (evidence: Response | undefined) => {
                  if (!evidence) return;
                  void evidence.body?.cancel().catch(() => undefined);
                };
                evidence = (async () => {
                  try {
                    const authoritative = await readUsage(providerEvidence, api);
                    if (authoritative) {
                      discard(accountEvidence);
                      discard(estimateEvidence);
                      broker.settle(id, authoritative);
                      return;
                    }
                    if (usageOptions.accountUsageDelta && accountEvidence) {
                      let delta: TokenUsage | null = null;
                      try {
                        delta = await usageOptions.accountUsageDelta({
                          model: model as Model<ModelApi>,
                          context,
                          response: accountEvidence,
                        });
                      } catch {
                        delta = null;
                      } finally {
                        discard(accountEvidence);
                      }
                      if (delta) {
                        discard(estimateEvidence);
                        broker.settle(id, { ...delta, usageSource: 'account_delta' });
                        return;
                      }
                    }
                    if (usageOptions.estimateMissing && estimateEvidence) {
                      const estimated = await estimateMissingUsage(estimateEvidence, api, context);
                      if (estimated) {
                        broker.settle(id, estimated);
                        return;
                      }
                    }
                    broker.settle(id, null);
                  } catch {
                    discard(accountEvidence);
                    discard(estimateEvidence);
                    broker.settle(id, null);
                  } finally {
                    release();
                  }
                })();
              },
            });
          },
        };
        const stream = api === 'anthropic-messages'
          ? anthropicStreamSimple(model as Model<'anthropic-messages'>, context, streamOptions as Parameters<typeof openaiStreamSimple>[2])
          : openaiStreamSimple(model as Model<'openai-completions'>, context, streamOptions);
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
