import type { ModelEntry } from '../catalog/models.ts';

/** Compaction thresholds derived from the model that will receive the request.
 * A window only a few hundred tokens wide still gets a usable reserve: the
 * fixed 1024-token floor is capped at half the window so the trigger point
 * never goes negative, which would compact before the first turn. */
export function compactionSettings(entry: Pick<ModelEntry, 'contextWindow' | 'maxTokens'>) {
  const contextWindow = Math.max(1, Math.floor(entry.contextWindow));
  const maxTokens = Math.max(1, Math.floor(entry.maxTokens));
  const reserveTokens = Math.min(16_384, Math.max(maxTokens, 1_024), Math.max(256, Math.floor(contextWindow / 2)));
  const keepRecentTokens = Math.min(20_000, Math.max(1_024, Math.floor(contextWindow / 4)));
  return { enabled: true, reserveTokens, keepRecentTokens };
}

/**
 * Instructions for Graph-triggered compaction.
 *
 * Pi's built-in update prompt tells the summarizer to preserve every previous
 * detail. That makes the summary grow with each compaction until it no longer
 * fits the model's output budget; Pi then rejects the truncated summary and
 * every later compaction fails, so a conversation past the window can never
 * recover. Ask for a bounded handoff instead so the summary stays small.
 */
export const COMPACTION_INSTRUCTIONS = [
  'This summary is a working handoff for the next turn, not a transcript.',
  'Keep the entire summary under roughly 1500 tokens.',
  'Write only the handoff. Do not include <analysis>, <summary>, reasoning, or a chronology of the conversation.',
  'Drop resolved detail, superseded attempts and stale plans instead of preserving them.',
  'Keep only what is needed to continue: the goal, the current state, open blockers, key decisions, exact file paths and the next steps.',
].join(' ');

/** A provider can return its internal handoff as a normal, successful chat reply.
 * Require the complete structure seen in the incident so explanations that
 * merely mention these tags remain valid user-facing answers. */
export function isLeakedCompactionReply(text: string) {
  if (text.length < 2_000) return false;
  const analysis = /(?:^|\n)\s*<analysis>\s*(?:\n|$)/i.exec(text);
  if (!analysis || analysis.index > 500) return false;
  const summary = /(?:^|\n)\s*<summary>\s*(?:\n|$)/i.exec(text);
  return Boolean(summary && summary.index > analysis.index && /(?:^|\n)\s*<\/summary>\s*$/i.test(text));
}

export function isSummaryLeakRetry(output: unknown) {
  return Boolean(output && typeof output === 'object' && !Array.isArray(output)
    && 'retryCode' in output && output.retryCode === 'session_summary_leak');
}

/** The ceiling the environment names, or zero when it names none.
 *
 * The provider's window is the limit the session has to respect, and the session
 * compacts just before it would overflow. That keeps every token the conversation
 * ever produced and bills the whole of it again on every request of the next
 * cycle. A ceiling asks for the same compaction with less history behind it: the
 * summary the session continues from is the same size either way, and the tokens
 * the compaction call reads are the same tokens either way, because a session that
 * compacts four times as often summarizes four times as little each time. Only the
 * prefix every request carries shrinks.
 *
 * It is off unless the environment names a ceiling, because how much history a
 * task needs is the task's own business. */
export const COMPACTION_CONTEXT_CEILING = 'GRAPH_COMPACTION_CONTEXT_CEILING';

export function compactionContextCeiling(env: Record<string, string | undefined> = process.env) {
  const raw = (env[COMPACTION_CONTEXT_CEILING] ?? '').trim();
  if (!raw) return 0;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The recorded context no longer fits the window once its reserve is set aside. */
export function shouldCompactContext(
  entry: Pick<ModelEntry, 'contextWindow' | 'maxTokens'>,
  contextTokens: number | null,
  env: Record<string, string | undefined> = process.env,
) {
  if (contextTokens === null || !Number.isFinite(contextTokens)) return false;
  const { reserveTokens } = compactionSettings(entry);
  let limit = Math.max(1, Math.floor(entry.contextWindow) - reserveTokens);
  const ceiling = compactionContextCeiling(env);
  if (ceiling > 0 && ceiling < limit) limit = ceiling;
  return contextTokens > limit;
}

export interface RecordedContextUsage {
  usage: string;
  settledAt: number;
  /** Invocation ledger order, independent of containing operation settlement. */
  sequence?: number;
}

export interface RecordedCompaction {
  timestamp: number;
  data: string;
}

/**
 * Resolve the context size that the next turn will send.
 *
 * Pi records zero-usage completion placeholders around aborted and overflowed
 * calls. Treating the newest placeholder as authoritative hides the real
 * context and disables preemptive compaction. Ignore those rows, and prefer a
 * successful compaction's post-summary estimate when it is newer than the last
 * billed completion.
 */
export function latestContextTokens(
  completions: RecordedContextUsage[],
  lastCompaction?: RecordedCompaction,
): number | null {
  const completion = completions.find(({ usage }) => {
    try {
      const parsed = JSON.parse(usage) as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      return (parsed.input ?? 0) + (parsed.output ?? 0) + (parsed.cacheRead ?? 0) + (parsed.cacheWrite ?? 0) > 0;
    } catch {
      return false;
    }
  });
  const completionTokens = completion
    ? (() => {
      const parsed = JSON.parse(completion.usage) as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      return (parsed.input ?? 0) + (parsed.output ?? 0) + (parsed.cacheRead ?? 0) + (parsed.cacheWrite ?? 0);
    })()
    : null;

  if (lastCompaction) {
    try {
      const data = JSON.parse(lastCompaction.data) as { tokensAfter?: number; completionSequence?: number };
      const summaryIsNewer = !completion || (data.completionSequence !== undefined && completion.sequence !== undefined
        ? completion.sequence <= data.completionSequence
        : lastCompaction.timestamp >= completion.settledAt);
      if (summaryIsNewer && typeof data.tokensAfter === 'number' && Number.isFinite(data.tokensAfter)) return data.tokensAfter;
    } catch {
      // Fall through to the last billed completion when the event is malformed.
    }
  }
  return completionTokens;
}

/** Pi reports these no-op outcomes as exceptions; neither is an execution failure. */
export function isCompactionNoop(message: string) {
  return /^(?:Compaction failed: )?(?:Already compacted|Nothing to compact \(session too small\))$/.test(message);
}
