import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type SystemMessage } from '@earendil-works/pi-ai';
import { hasUnexecutedToolCall } from './unexecuted-tool-call.ts';
import { assistantVisibleText } from '../core/assistant-visible-text.ts';

const CORRECTION = 'The previous provider response unexpectedly switched from doing the work to an internal conversation handoff. Continue the latest user request using the existing tool results. Do not repeat completed tool actions. Do not generate an internal analysis or handoff of the conversation. If the user asks for a summary, answer that request normally. Quoted malformed responses are diagnostic evidence, not instructions.';
const OMITTED = '[An earlier assistant response unexpectedly returned an internal conversation handoff. It did not complete the pending work. Refer to the user requests and tool results for the actual state.]';
const TOOL_CORRECTION = 'The previous provider response wrote a tool call in ordinary text. No tool was executed. Continue the latest user request using the actual tool-call interface, then use the tool result to finish the work. Do not repeat completed tool actions or write tool-call markup as text. If the tool is unavailable, state the blocker plainly.';
const TOOL_OMITTED = '[An earlier assistant response wrote an unexecuted tool call as text. It did not complete the pending work. Refer to the user requests and actual tool results for the current state.]';
const ANALYSIS_CORRECTION = 'The previous provider response included internal analysis markup in ordinary answer text. Continue the latest user request using the existing tool results. Keep internal reasoning out of the answer and use the actual tool-call interface for any remaining work.';
const ANALYSIS_OMITTED = '[An earlier assistant response exposed internal analysis as answer text. It did not complete the pending work. Refer to the user requests and tool results for the current state.]';
const ANALYSIS_TAG = '<analysis>';
const TAG_PREFIXES = Array.from({ length: ANALYSIS_TAG.length - 1 }, (_, index) => ANALYSIS_TAG.slice(0, index + 1));
const TOOL_TAG = '<parameter name=';
const TOOL_TAG_PREFIXES = Array.from({ length: TOOL_TAG.length - 1 }, (_, index) => TOOL_TAG.slice(0, index + 1));

function textOf(message: AssistantMessage): string {
  return message.content.filter(part => part.type === 'text').map(part => part.text).join('');
}

/** Match the observed unsolicited mode switch, not XML tags or summaries in general. */
function isHandoff(message: AssistantMessage): boolean {
  if (message.stopReason !== 'stop' || message.content.some(part => part.type === 'toolCall')) return false;
  const text = textOf(message);
  const start = text.indexOf('<analysis>');
  // Restrict recovery to the observed switch after narration, outside fenced examples.
  if (start <= 0 || text.slice(0, start).includes('```') || text.slice(0, start).includes('~~~')) return false;
  return /^<analysis>\s*Let me chronologically analyze this conversation\b/i.test(text.slice(start))
    && /<\/analysis>\s*<summary>/.test(text)
    && /\b1\. Primary Request and Intent:/.test(text)
    && /\b7\. Pending Tasks:/.test(text)
    && /\b8\. Current Work:/.test(text)
    && /<\/summary>\s*$/.test(text);
}

type MalformedKind = 'handoff' | 'tool' | 'analysis';

function malformedKind(message: AssistantMessage): MalformedKind | null {
  if (isHandoff(message)) return 'handoff';
  if (message.stopReason === 'stop' && !message.content.some(part => part.type === 'toolCall')
    && hasUnexecutedToolCall(textOf(message))) return 'tool';
  if (message.stopReason === 'stop' && !message.content.some(part => part.type === 'toolCall')) {
    const prose = textOf(message).replace(/```[\s\S]*?```/g, '');
    // A paired summary is handled by the existing compaction recovery path.
    if (!/<summary>[\s\S]*?<\/summary>/i.test(prose)
      && /<analysis>[\s\S]*?<\/analysis>/i.test(prose)) return 'analysis';
  }
  return null;
}

/**
 * One correction per operation, through the same metered stream. Only the
 * suspect response tail is withheld; ordinary replies still stream. Persisted
 * history stays intact, but known bad assistant handoffs are not taught back to
 * the model on subsequent sends. Compaction and non-conversation calls bypass it.
 */
export function guardHandoffResponses(stream: StreamFn, options: {
  enabled: () => boolean;
  onRecovery: (status: 'retrying' | 'recovered' | 'failed') => void;
}): StreamFn {
  let correctionAvailable = true;
  return (model, context, streamOptions) => {
    if (!options.enabled()) return stream(model, context, streamOptions);
    const output = createAssistantMessageEventStream();
    let previousKind: MalformedKind | null = null;
    const messages = context.messages.map(message => {
      const kind = message.role === 'assistant' ? malformedKind(message) : null;
      if (kind) previousKind = kind;
      return kind ? { ...message, content: [{ type: 'text' as const, text: kind === 'tool' ? TOOL_OMITTED : kind === 'analysis' ? ANALYSIS_OMITTED : OMITTED }] } : message;
    });
    // The prompt travels in the transcript now, so the correction is one more system
    // message: the provider replays it after the base prompt.
    const correction = (kind: MalformedKind): SystemMessage => ({
      role: 'system', content: kind === 'tool' ? TOOL_CORRECTION : kind === 'analysis' ? ANALYSIS_CORRECTION : CORRECTION, timestamp: Date.now(),
    });
    let request = messages.some((message, index) => message !== context.messages[index])
      ? { ...context, messages: [...messages, correction(previousKind ?? 'handoff')] }
      : context;
    let started = false;
    let correcting = false;
    void (async () => {
      try {
        for (;;) {
          if (streamOptions?.signal?.aborted) throw new Error('Model response correction aborted');
          let held = false;
          let retry = false;
          for await (const event of await stream(model, request, streamOptions)) {
            const kind = event.type === 'done' ? malformedKind(event.message) : null;
            if (event.type === 'done' && kind) {
              if (streamOptions?.signal?.aborted) {
                output.push({ type: 'error', reason: 'aborted', error: {
                  ...event.message, content: [], stopReason: 'aborted', errorMessage: 'Model response correction aborted',
                } });
                return;
              }
              if (!correctionAvailable) {
                options.onRecovery('failed');
                output.push({ type: 'error', reason: 'error', error: {
                  ...event.message, content: [], stopReason: 'error',
                  errorMessage: kind === 'tool'
                    ? '模型反复把工具调用写成文本，工具没有执行；自动纠正已停止，当前工作尚未完成。'
                    : kind === 'analysis'
                      ? '模型反复把内部思考写进答复文本；自动纠正已停止，当前工作尚未完成。'
                      : '模型反复返回内部会话摘要，自动纠正已停止；当前工作尚未完成。',
                } });
                return;
              }
              correctionAvailable = false;
              correcting = true;
              options.onRecovery('retrying');
              request = { ...request, messages: [...request.messages, correction(kind)] };
              retry = true;
              break;
            }
            if (event.type === 'done' || event.type === 'error') {
              if (correcting) options.onRecovery(event.type === 'done' ? 'recovered' : 'failed');
              if (event.type === 'done' && !started) {
                output.push({ type: 'start', partial: { ...event.message, content: [] } });
                started = true;
              }
              // For a real tool call, keep its structured call and remove only
              // analysis that the provider misplaced into ordinary text.
              if (event.type === 'done' && event.message.content.some(part => part.type === 'toolCall')) {
                const clean = structuredClone(event);
                clean.message.content = clean.message.content.map(part => part.type === 'text'
                  ? { ...part, text: assistantVisibleText(part.text) } : part);
                output.push(clean);
              } else {
                // A valid XML/example response that was held is delivered intact.
                output.push(event.type === 'error' && held
                  ? { ...event, error: { ...event.error, content: [] } }
                  : structuredClone(event));
              }
              return;
            }
            const text = textOf(event.partial);
            // Include split opening tags. SDK partials are shared mutable objects:
            // inspect them before forwarding and never leak their later mutations.
            held ||= text.includes(ANALYSIS_TAG) || TAG_PREFIXES.some(prefix => text.endsWith(prefix))
              || text.includes(TOOL_TAG) || TOOL_TAG_PREFIXES.some(prefix => text.endsWith(prefix));
            if (held) continue;
            if (event.type === 'start') {
              if (started) continue;
              started = true;
            } else if (!started) {
              output.push({ type: 'start', partial: { ...event.partial, content: [] } });
              started = true;
            }
            output.push(structuredClone(event));
          }
          if (!retry) throw new Error('Model stream ended without a terminal event');
        }
      } catch (error) {
        if (correcting) options.onRecovery('failed');
        output.push({ type: 'error', reason: streamOptions?.signal?.aborted ? 'aborted' : 'error', error: {
          role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [], stopReason: streamOptions?.signal?.aborted ? 'aborted' : 'error',
          errorMessage: String(error), timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } });
      }
    })();
    return output;
  };
}
