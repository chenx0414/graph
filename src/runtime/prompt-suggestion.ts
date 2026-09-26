import type { StreamFn } from '@earendil-works/pi-agent-core';
import { normalizeContext } from '@earendil-works/pi-ai';
import type { Context, Model } from '@earendil-works/pi-ai';
import { modelIdentity, type ModelApi, type ModelEntry } from '../catalog/models.ts';
import { DEFAULT_PROMPT_SUGGESTION_PROMPT } from './agent-context.ts';

const GRADE_ORDER: ModelEntry['grade'][] = ['low', 'medium', 'high', 'highest'];

/** Pick a separate, preferably cheaper model for the composer-only suggestion. */
export function selectPromptSuggestionModel(main: ModelEntry, directory: ModelEntry[]) {
  const mainIdentity = modelIdentity(main);
  const candidates = directory.filter(model => model.id !== main.id && modelIdentity(model) !== mainIdentity);
  for (const grade of GRADE_ORDER) {
    const candidate = candidates.find(model => model.grade === grade);
    if (candidate) return candidate;
  }
  return undefined;
}

function textFromMessage(message: { content?: unknown }) {
  if (!Array.isArray(message.content)) return '';
  return message.content
    .flatMap(part => part && typeof part === 'object' && !Array.isArray(part)
      && (part as { type?: unknown }).type === 'text'
      && typeof (part as { text?: unknown }).text === 'string'
      ? [(part as { text: string }).text]
      : [])
    .join('');
}

function normalizeSuggestion(value: string) {
  let text = value.trim();
  const fence = /^```(?:text)?\s*([\s\S]*?)```$/i.exec(text);
  if (fence) text = fence[1]!.trim();
  text = text.replace(/^(?:suggestion|prompt|候选提示|建议|下一步)\s*[:：]\s*/i, '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('“') && text.endsWith('”'))) {
    text = text.slice(1, -1).trim();
  }
  const firstLine = text.split('\n').map(line => line.trim()).find(Boolean) ?? '';
  if (/^(?:none|n\/a|no suggestion|没有建议|无)$/i.test(firstLine)) return '';
  return firstLine.slice(0, 500);
}

export interface PromptSuggestionReply {
  /** The suggestion when the call finished normally and carried one; '' when it did not. */
  text: string;
  /** What the model actually said before normalization: the evidence behind `text`. */
  raw: string;
  stopReason: string | null;
  /** The provider's or the transport's own words when the call did not finish normally. */
  error: string | null;
}

/** A reply that carries no suggestion and no failure: the model answered and had nothing to add. */
export const NO_SUGGESTION: PromptSuggestionReply = { text: '', raw: '', stopReason: null, error: null };

/**
 * Generate one composer suggestion in a fresh model call. The main Agent's
 * transcript is deliberately absent: only the latest user message and visible
 * reply cross this boundary. The outcome is returned, never swallowed: a provider that refused and a
 * model with nothing to say are different facts about the same turn.
 */
export async function generatePromptSuggestion(input: {
  stream: StreamFn;
  model: Model<ModelApi>;
  userMessage: string;
  assistantReply: string;
  systemPrompt?: string;
  signal?: AbortSignal;
}): Promise<PromptSuggestionReply> {
  const context: Context = {
    systemPrompt: input.systemPrompt?.trim() || DEFAULT_PROMPT_SUGGESTION_PROMPT,
    messages: [{
      role: 'user',
      content: JSON.stringify({
        lastUserMessage: input.userMessage.slice(0, 2_000),
        assistantReply: input.assistantReply.slice(0, 8_000),
      }),
      timestamp: Date.now(),
    }],
  };
  try {
    const stream = await input.stream(input.model, normalizeContext(context), {
      maxTokens: 160,
      reasoning: 'minimal',
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const message = await stream.result();
    const raw = textFromMessage(message);
    // The SDK reports its own reason on the message when the provider stopped abnormally; without it
    // a refusal and an empty answer arrive here looking exactly alike.
    const reported = (message as unknown as { errorMessage?: unknown }).errorMessage;
    return {
      text: message.stopReason === 'stop' ? normalizeSuggestion(raw) : '',
      raw,
      stopReason: message.stopReason ?? null,
      error: typeof reported === 'string' && reported ? reported : null,
    };
  } catch (error) {
    return { text: '', raw: '', stopReason: null, error: error instanceof Error ? error.message : String(error) };
  }
}
