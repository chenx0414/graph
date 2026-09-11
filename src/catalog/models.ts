import { RuntimeError, type Json } from '../core/types.ts';
import type { TokenUsage } from '../runtime/call-broker.ts';

export type ModelGrade = 'low' | 'medium' | 'high' | 'highest';
export interface ModelCost { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface ModelEntry {
  id: string;
  provider: string;
  grade: ModelGrade;
  api: 'openai-completions';
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  cost?: ModelCost;
}

export function parseDefinitionVersion(value: string) {
  const match = /^(.*)@(\d+)$/.exec(value.trim());
  if (match) return { id: match[1]!, version: Number(match[2]) };
  if (!value.trim()) throw new RuntimeError('invalid_input', 'A definition version is required');
  return { id: value.trim(), version: 1 };
}

export function estimateCost(usage: TokenUsage, cost?: ModelCost): Json {
  if (!cost) return { unknown: true };
  const amount = (usage.input * cost.input + usage.output * cost.output + usage.cacheRead * cost.cacheRead + usage.cacheWrite * cost.cacheWrite) / 1_000_000;
  if (!Number.isFinite(amount)) return { unknown: true };
  return { amount };
}

/** Pick a configured model; review nodes pass exclude for implementer models used this round. */
export function selectModel(input: {
  requested?: string;
  grade: ModelGrade;
  directory: ModelEntry[];
  preferences?: Partial<Record<ModelGrade, string[]>>;
  exclude?: string[];
}) {
  const blocked = new Set(input.exclude ?? []);
  const usable = input.directory.filter(model => !blocked.has(model.id));
  const requested = input.requested ? usable.find(model => model.id === input.requested) : undefined;
  if (requested) return requested;
  const preferred = (input.preferences?.[input.grade] ?? []).map(id => usable.find(model => model.id === id)).find(model => model);
  if (preferred) return preferred;
  return usable.find(model => model.grade === input.grade);
}
