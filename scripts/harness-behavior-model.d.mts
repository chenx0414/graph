import type { BehaviorCase } from './harness-behavior-cases.mjs';

export interface BehaviorProvider {
  /** The OpenAI-compatible base url the model is served from. */
  baseUrl: string;
  /** Every request the model received. */
  requests: unknown[];
  /** Every answer the model gave. */
  answers: string[];
  close(): Promise<void>;
}

export declare function startBehaviorProvider(caseScript: BehaviorCase): Promise<BehaviorProvider>;

export declare function behaviorLastWords(answers: string[]): string;
