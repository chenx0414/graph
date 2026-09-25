/**
 * Tool-result lazy loading: keep the prompt small without losing data (backlog v81).
 *
 * A result below TOOL_RESULT_LIMIT is returned untouched. A larger one is returned
 * whole for its first two occurrences per (conversation, tool, params, content) key;
 * from the third the caller gets a bounded, deterministic summary plus a handle - a
 * path on disk that still holds every byte, readable with the existing read tool.
 *
 * The summary always states how many bytes were left out, counted from what the
 * final text actually dropped, so a single huge line cannot hide the omission.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TOOL_RESULT_LIMIT = 4_000;
export const SUMMARY_LIMIT = 1_024;

/** Head and tail lines the summary prefers before the byte budget bites. */
const SUMMARY_LINES = 12;

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

/** Deterministic head/tail summary: same input, same text, no model call. */
export function summarizeToolResult(input: { text: string; handle: string }): string {
  const lines = input.text.split('\n');
  const head = lines.slice(0, SUMMARY_LINES);
  const tail = lines.slice(Math.max(head.length, lines.length - SUMMARY_LINES));
  const header = `[large tool result: ${input.text.length} bytes, ${lines.length} lines]`;
  const trailer = `handle: ${input.handle}\nRead the whole result with the read tool (offset/limit) on that path.`;
  const body = [...head, ...(tail.length ? ['...'] : []), ...tail].join('\n');
  const budget = Math.max(0, SUMMARY_LIMIT - header.length - trailer.length - 64);
  const kept = body.length <= budget ? body : body.slice(0, budget);
  // Counted from what this summary really dropped, so a single huge line still
  // reports its omission instead of looking complete.
  const dropped = Math.max(0, input.text.length - kept.length);
  const marker = `... omitted ${dropped} of ${input.text.length} bytes ...`;
  return `${[header, kept, marker, trailer].join('\n')}`.slice(0, SUMMARY_LIMIT);
}

/** The seam every tool result goes through. */
export async function renderToolResult(input: {
  text: string;
  conversationId: string;
  tool: string;
  params: unknown;
  spillDir: string;
  tracker: { record: (key: string) => number };
}): Promise<string> {
  if (input.text.length <= TOOL_RESULT_LIMIT) return input.text;
  const key = toolResultKey(input);
  const occurrence = input.tracker.record(key);
  if (occurrence <= 2) return input.text;
  const handle = join(input.spillDir, `${key}.txt`);
  await mkdir(input.spillDir, { recursive: true });
  await writeFile(handle, input.text, { mode: 0o600 });
  return summarizeToolResult({ text: input.text, handle });
}
