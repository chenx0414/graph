/** What one model call used, as the provider reported it.
 *
 * The daemon's own ledger is the Go side (core_token_usage.go); this is the
 * shape the console reads and the remaining view modules agree on.
 */
export type UsageSource = 'authoritative' | 'account_delta' | 'estimated' | 'unknown';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usageSource?: UsageSource;
}
