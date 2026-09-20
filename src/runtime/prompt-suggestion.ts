import type { StreamFn } from '@earendil-works/pi-agent-core';
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

/**
 * Generate one composer suggestion in a fresh model call. The main Agent's
 * transcript is deliberately absent: only the latest user message and visible
 * reply cross this boundary.
 */
export async function generatePromptSuggestion(input: {
  stream: StreamFn;
  model: Model<ModelApi>;
  userMessage: string;
  assistantReply: string;
  systemPrompt?: string;
  signal?: AbortSignal;
}) {
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
    const stream = await input.stream(input.model, context, {
      maxTokens: 160,
      reasoning: 'minimal',
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const message = await stream.result();
    if (message.stopReason !== 'stop') return undefined;
    const suggestion = normalizeSuggestion(textFromMessage(message));
    return suggestion || undefined;
  } catch {
    return undefined;
  }
}
