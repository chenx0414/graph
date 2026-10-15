import type { SimpleStreamOptions, ThinkingBudgets } from '@earendil-works/pi-ai';

/** Only generation settings cross IPC; credentials, headers, callbacks and cancellation stay with the host. */
export type WorkerModelOptions = Pick<SimpleStreamOptions, 'reasoning' | 'sessionId' | 'temperature' | 'maxTokens' | 'thinkingBudgets'>;

export function workerModelOptions(value: unknown): WorkerModelOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: WorkerModelOptions = {};
  if (typeof input.reasoning === 'string' && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.reasoning)) {
    result.reasoning = input.reasoning as NonNullable<SimpleStreamOptions['reasoning']>;
  }
  if (typeof input.sessionId === 'string' && input.sessionId.length <= 1024) result.sessionId = input.sessionId;
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) result.temperature = input.temperature;
  if (typeof input.maxTokens === 'number' && Number.isSafeInteger(input.maxTokens) && input.maxTokens > 0) result.maxTokens = input.maxTokens;
  if (input.thinkingBudgets && typeof input.thinkingBudgets === 'object' && !Array.isArray(input.thinkingBudgets)) {
    const inputBudgets = input.thinkingBudgets as Record<string, unknown>;
    const budgets: ThinkingBudgets = {};
    for (const level of ['minimal', 'low', 'medium', 'high'] as const) {
      const budget = inputBudgets[level];
      if (typeof budget === 'number' && Number.isSafeInteger(budget) && budget >= 0) budgets[level] = budget;
    }
    if (Object.keys(budgets).length) result.thinkingBudgets = budgets;
  }
  return result;
}
