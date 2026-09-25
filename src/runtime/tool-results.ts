/**
 * Tool-result lazy loading: keep the prompt small without losing data (backlog v81).
 *
 * A result below TOOL_RESULT_LIMIT is returned untouched. A larger one is returned
 * whole for its first two occurrences per (scope, tool, params, content) key; from the
 * third the caller gets a bounded, deterministic summary plus a handle - a path on disk
 * that still holds every byte, readable with the existing read tool.
 *
 * The summary always states how many bytes were left out, counted from what the final
 * text actually dropped, so a single huge line cannot hide the omission.
 *
 * `toolResultHook` is the single seam: Pi's agent loop calls it for every tool result,
 * Graph's own tools and Pi's built-ins alike. It overrides `content` only, so a tool's
 * own `details` and `terminate` hint always survive. Two rules live here: the lazy rule
 * for any large result that repeats, and a ceiling for shell output (SHELL_OUTPUT_LIMIT),
 * which is stricter than the upstream bound and applies from the first view.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AfterToolCallResult } from '@earendil-works/pi-agent-core';

export const TOOL_RESULT_LIMIT = 4_000;
export const SUMMARY_LIMIT = 1_024;
/** Graph's own ceiling for shell output, deliberately the same order as the read-only
 * git surface: a longer result keeps a head/tail view that names its handle. */
export const SHELL_OUTPUT_LIMIT = 20_000;

/**
 * Per-tool ceilings on the model-visible text. Only `bash` is listed: upstream `read`
 * already continues with `offset` and upstream `edit` already answers in one line, so a
 * cap here would fight behaviour that is already the right shape.
 */
const TOOL_TEXT_LIMITS: Record<string, number> = { bash: SHELL_OUTPUT_LIMIT };

type ContentPart = NonNullable<AfterToolCallResult['content']>[number];
type ResultPart = { type: string; text?: string };

/** The part of an agent-loop tool result this seam reads. */
export type ToolResultHookContext = {
  toolCall: { name: string };
  args: unknown;
  result: { content: readonly ResultPart[] };
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${key}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** The identity of one large result: the same tool, arguments and content are one key,
 * while a changed argument (or a changed file) is a different result that may still
 * deserve a full view. */
export function toolResultKey(input: { conversationId: string; tool: string; params: unknown; text: string }): string {
  return digest(`${input.conversationId}\u0000${input.tool}\u0000${stable(input.params)}\u0000${digest(input.text)}`);
}

export function createToolResultTracker(): { record: (key: string) => number } {
  const seen = new Map<string, number>();
  return {
    record(key) {
      const next = (seen.get(key) ?? 0) + 1;
      seen.set(key, next);
      return next;
    },
  };
}

/** Deterministic head/tail summary: same input, same text, no model call. Whole lines are
 * taken from each end while the budget allows, so a short tail - the line that carries a
 * failure - is never lost to one enormous leading line. */
export function summarizeToolResult(input: { text: string; handle: string; limit?: number }): string {
  const limit = input.limit ?? SUMMARY_LIMIT;
  const lineCount = input.text.split('\n').length;
  const header = `[large tool result: ${input.text.length} bytes, ${lineCount} lines]`;
  const trailer = `handle: ${input.handle}\nRead the whole result with the read tool (offset/limit) on that path.`;
  const room = Math.max(0, limit - header.length - trailer.length - 64);
  const tailBudget = Math.floor(room / 3);
  const head = boundSide(input.text, room - tailBudget, false);
  const tail = boundSide(input.text, tailBudget, true);
  // Counted from what this summary really dropped, so a single huge line still
  // reports its omission instead of looking complete.
  const dropped = Math.max(0, input.text.length - head.length - tail.length);
  const marker = `... omitted ${dropped} of ${input.text.length} bytes ...`;
  return `${[header, head, marker, tail, trailer].join('\n')}`.slice(0, limit);
}

/** Whole lines up to `budget`, from the start or the end; a single line larger than the
 * whole budget is cut instead of dropped. */
function boundSide(text: string, budget: number, fromEnd: boolean): string {
  if (budget <= 0) return '';
  const lines = text.split('\n');
  const ordered = fromEnd ? [...lines].reverse() : lines;
  const picked: string[] = [];
  let used = 0;
  for (const line of ordered) {
    const cost = line.length + (picked.length ? 1 : 0);
    if (used + cost > budget) {
      if (!picked.length) picked.push(fromEnd ? line.slice(-budget) : line.slice(0, budget));
      break;
    }
    picked.push(line);
    used += cost;
  }
  return (fromEnd ? picked.reverse() : picked).join('\n');
}

/** The seam every tool result goes through. `limit` forces a bounded view at that
 * ceiling on every occurrence; without it the lazy rule applies - full for the first two
 * occurrences of a large result, a summary from the third. */
export async function renderToolResult(input: {
  text: string;
  conversationId: string;
  tool: string;
  params: unknown;
  spillDir: string;
  tracker: { record: (key: string) => number };
  limit?: number;
}): Promise<string> {
  if (input.limit === undefined && input.text.length <= TOOL_RESULT_LIMIT) return input.text;
  const key = toolResultKey(input);
  if (input.limit === undefined && input.tracker.record(key) <= 2) return input.text;
  const handle = join(input.spillDir, `${key}.txt`);
  await mkdir(input.spillDir, { recursive: true });
  await writeFile(handle, input.text, { mode: 0o600 });
  return summarizeToolResult({ text: input.text, handle, ...(input.limit === undefined ? {} : { limit: input.limit }) });
}

/** One occurrence count per scope, kept for the life of the daemon so a re-read of the
 * same result across turns is still recognised for what it is. */
const trackers = new Map<string, { record: (key: string) => number }>();

function trackerFor(scopeId: string) {
  const existing = trackers.get(scopeId);
  if (existing) return existing;
  const created = createToolResultTracker();
  trackers.set(scopeId, created);
  return created;
}

/**
 * Build the agent loop's `afterToolCall` hook. It returns `undefined` whenever the
 * result should reach the model exactly as the tool produced it - a small result, a
 * first or second view of a large one, or a result with no text at all - so nothing
 * but a genuinely repeated large result is ever rewritten.
 */
export function toolResultHook(input: { scopeId: string; spillDir: string }) {
  return async (context: ToolResultHookContext): Promise<AfterToolCallResult | undefined> => {
    const parts = context?.result?.content;
    if (!Array.isArray(parts)) return undefined;
    const texts = parts.filter(part => part.type === 'text').map(part => part.text ?? '');
    if (!texts.length) return undefined;
    const name = context.toolCall?.name ?? 'unknown';
    const text = texts.join('\n');
    const ceiling = TOOL_TEXT_LIMITS[name];
    const limit = ceiling !== undefined && text.length > ceiling ? ceiling : undefined;
    if (limit === undefined && text.length <= TOOL_RESULT_LIMIT) return undefined;
    const rendered = await renderToolResult({
      text,
      conversationId: input.scopeId,
      tool: name,
      params: context.args,
      spillDir: input.spillDir,
      tracker: trackerFor(input.scopeId),
      ...(limit === undefined ? {} : { limit }),
    });
    // Still a full view: leave the tool's own result object completely untouched.
    if (rendered === text) return undefined;
    const content: ContentPart[] = [];
    let summarised = false;
    for (const part of parts) {
      if (part.type !== 'text') {
        content.push(part as ContentPart);
        continue;
      }
      if (summarised) continue;
      content.push({ type: 'text', text: rendered });
      summarised = true;
    }
    return { content };
  };
}
