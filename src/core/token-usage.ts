export type UsageSource = 'authoritative' | 'account_delta' | 'estimated' | 'unknown';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usageSource?: UsageSource;
}
