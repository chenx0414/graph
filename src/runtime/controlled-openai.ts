import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, type AssistantMessage, type Context, type Model, type TranscriptContext, type Api, type SimpleStreamOptions, type AssistantMessageEventStream } from '@earendil-works/pi-ai';
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

export type ControlledStream = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

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
  const contentType = response.headers.get('content-type') ?? '';
  let received = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    if (contentType.includes('application/json')) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > 8_000_000) { void reader.cancel(); return null; }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      const body = JSON.parse(text) as { usage?: unknown };
      return api === 'anthropic-messages' ? parseAnthropicUsage(body.usage) : parseUsage(body.usage);
    }

    // The SDK ends its event stream at the protocol terminator ([DONE] for
    // OpenAI, message_stop for Anthropic). The raw evidence connection can
    // still stay open behind a proxy or keep-alive, so waiting for EOF here
    // would hold the model response hostage indefinitely.
    let usage: TokenUsage | null = null;
    let buffered = '';
    const processLine = (line: string): boolean => {
      if (!line.startsWith('data:')) return false;
      const payload = line.slice(5).trim();
      if (!payload) return false;
      if (api === 'openai-completions' && payload === '[DONE]') return true;
      let event: { type?: string; message?: { usage?: unknown }; usage?: unknown };
      try { event = JSON.parse(payload) as typeof event; } catch { return false; }
      if (api === 'anthropic-messages') {
        if (event.type === 'message_start') {
          usage = parseAnthropicUsage(event.message?.usage) ?? usage;
        } else if (event.type === 'message_delta' && usage) {
          const delta = parseAnthropicUsage({
            ...(event.usage as object | undefined),
            input_tokens: usage.input,
            cache_read_input_tokens: usage.cacheRead,
            cache_creation_input_tokens: usage.cacheWrite,
          });
          if (delta) usage = delta;
        }
        return event.type === 'message_stop';
      }
      if (event.usage) usage = parseUsage(event.usage);
      return false;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > 8_000_000) { void reader.cancel(); return null; }
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!processLine(line)) continue;
        void reader.cancel();
        return usage;
      }
    }
    buffered += decoder.decode();
    if (buffered) processLine(buffered);
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

function isTerminalSseLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return false;
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') return true;
  try {
    const event = JSON.parse(payload) as { type?: unknown };
    return event.type === 'message_stop';
  } catch {
    return false;
  }
}

/** Some SSE providers send the protocol terminator but keep the HTTP body
 * open. The OpenAI SDK waits for body EOF even after [DONE], so expose the
 * semantic end of the event stream as EOF at the fetch boundary. */
function boundedSseBody(body: ReadableStream<Uint8Array>, release: () => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  let finished = false;
  const finish = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (finished) return;
    finished = true;
    release();
    controller.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffered += decoder.decode();
          if (buffered) controller.enqueue(encoder.encode(buffered));
          finish(controller);
          return;
        }
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline !== -1) {
          const line = buffered.slice(0, newline + 1);
          buffered = buffered.slice(newline + 1);
          controller.enqueue(encoder.encode(line));
          if (isTerminalSseLine(line)) {
            controller.enqueue(encoder.encode('\n'));
            finish(controller);
            void reader.cancel().catch(() => undefined);
            return;
          }
          newline = buffered.indexOf('\n');
        }
      }
    },
    async cancel() {
      if (!finished) {
        finished = true;
        release();
        await reader.cancel().catch(() => undefined);
      }
    },
  });
}

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
      // A capacity answer (429 or 503) means the provider rejected the request before producing any
      // token, exactly like an unsent connection: give the same logical send another attempt instead
      // of failing the Agent turn. Other 5xx answers stay hard failures - they can be a provider bug
      // that the unknown-usage path must see. Settling zero usage matters too: an unknown settlement
      // would turn a provider hiccup into a blocking usage question for the user.
      if ((response.status === 429 || response.status === 503) && attempt < maxAttempts) {
        release?.();
        broker.settle(id, ZERO_USAGE);
        await response.body?.cancel().catch(() => undefined);
        await (options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(500 * attempt);
        continue;
      }
      void options.onResponse?.(id, response, () => release?.());
      if (!response.body) { release?.(); return response; }
      // Capacity covers the whole body, not just the headers.
      const contentType = response.headers.get('content-type') ?? '';
      const wrapped = contentType.includes('text/event-stream')
        ? boundedSseBody(response.body, () => release?.())
        : response.body.pipeThrough(new TransformStream({ flush() { release?.(); } }));
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
  context: TranscriptContext;
  /** A fresh clone owned by the callback; it may be consumed. */
  response: Response;
}

export interface ControlledStreamUsageOptions {
  /** Estimate a successful response when neither per-request nor account-level usage exists. */
  estimateMissing?: boolean;
  /** Provider adapter hook. It must return the account-level delta attributable to this send. */
  accountUsageDelta?: (input: AccountUsageDeltaInput) => Promise<TokenUsage | null> | TokenUsage | null;
  /**
   * Reports the exact system prompt one send carries. The console shows what the model really
   * received, so this must be the string the transport sends — never a re-render of the same facts.
   */
  onSend?: (sent: { systemPrompt: string | null; toolDeclarations: string | null }) => void;
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

async function estimateMissingUsage(response: Response, api: 'openai-completions' | 'anthropic-messages', context: TranscriptContext): Promise<TokenUsage | null> {
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

/** The tool declarations a request carries, read off the very body the provider sends. */
function requestToolDeclarations(init?: RequestInit): string | null {
  const body = init?.body;
  if (typeof body !== 'string') return null;
  try {
    const parsed = JSON.parse(body) as { tools?: unknown };
    if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) return null;
    return JSON.stringify(parsed.tools);
  } catch { return null; }
}

/** Controlled lower-level adapter, currently verified for OpenAI chat-completions SSE. */
export function controlledOpenAIStream(
  broker: SendGate,
  apiKey: string | (() => string),
  slot?: StreamSlot,
  api: ModelApi = 'openai-completions',
  usageOptions: ControlledStreamUsageOptions = {},
): ControlledStream {
  if (api !== 'openai-completions' && api !== 'anthropic-messages') throw new Error('Unverified model transport');
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let evidence: Promise<void> | undefined;
      try {
        if (model.api !== api) throw new Error('Unverified model transport');
        let sent = false;
        let reported = false;
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
            if (!reported) {
              reported = true;
              // A diagnostic must never break a send: the model call is what matters.
              // The provider now receives a normalized transcript: the current prompt is
              // what every system message in it replays to, never a plain field. The tool
              // declarations are read off the very request being sent, so the console shows
              // the bytes this request carries - recording only, nothing extra is ever sent.
              try {
                usageOptions.onSend?.({
                  systemPrompt: getCurrentSystemPrompt(context.messages) || null,
                  toolDeclarations: requestToolDeclarations(init),
                });
              } catch { /* ignored on purpose */ }
            }
            // The slot is acquired per attempt inside gatedProviderFetch, so a
            // retry re-queues and re-passes the gate after releasing capacity.
            return gatedProviderFetch(broker, input, { ...init, redirect: 'error' }, {
              reservation: model.contextWindow + model.maxTokens,
              fetchImpl: (url, init) => {
                // Resolve after the credential slot and the send gate: queued
                // calls adopt a rotated key, while sent calls keep their bytes.
                const liveKey = typeof apiKey === 'function' ? apiKey() : apiKey;
                const headers = new Headers(init?.headers);
                if (headers.get('authorization') === `Bearer ${key}`) headers.set('authorization', `Bearer ${liveKey}`);
                if (headers.get('x-api-key') === key) headers.set('x-api-key', liveKey);
                return fetch(url, { ...init, headers });
              },
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
