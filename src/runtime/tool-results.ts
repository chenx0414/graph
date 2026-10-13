/**
 * Tool-result lazy loading: keep the prompt small without losing data (backlog v81..v83).
 *
 * A result below TOOL_RESULT_LIMIT is returned untouched. A larger one is returned
 * whole for its first two occurrences per (scope, tool, params, content) key; from the
 * third the caller gets a bounded, deterministic summary plus a handle - a path on disk
 * that still holds every byte, readable with the existing read tool.
 *
 * The summary states how many characters were left out, counted from what the final text
 * actually dropped, so a single huge line cannot hide the omission. Characters, not bytes:
 * a non-ASCII result is longer on disk than the number reported here.
 *
 * `toolResultHook` is the single seam: Pi's agent loop calls it for every tool result,
 * Graph's own tools and Pi's built-ins alike. It overrides `content` only, so a tool's
 * own `details` and `terminate` hint always survive. Three rules live here: the lazy rule
 * for any large result that repeats, per-tool ceilings (TOOL_TEXT_LIMITS) that apply from
 * the first view, and the two bounds that keep it honest over time - the occurrence map
 * is capped (a forgotten key only ever means a full view again), the spill directory keeps
 * only the newest files, and the counts are written next to them so an instance that is
 * reopened for the same binding keeps counting instead of starting over.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TextContent, ImageContent } from '@earendil-works/pi-ai';
type ContentOverride = { content?: (TextContent | ImageContent)[] };

export const TOOL_RESULT_LIMIT = 4_000;
export const SUMMARY_LIMIT = 1_024;
/** Graph's own ceiling for shell output, deliberately the same order as the read-only
 * git surface: a longer result keeps a head/tail view that names its handle. */
export const SHELL_OUTPUT_LIMIT = 20_000;
/** The system inventory is a single-shot dump, so the lazy rule can never catch it: it
 * gets its own ceiling instead, with the same named fallback. */
export const SYSTEM_SUMMARY_LIMIT = 12_000;
/** A conversation transcript is a whole session, not a shell line: one read can carry every message and
 * every tool row of another Agent's turn. It gets a first-view ceiling for the same reason bash does. */
export const CONVERSATION_READ_LIMIT = 8_000;
/** Keys remembered per scope. Evicting a key is safe by construction: the worst case is
 * that a repeated result is shown in full once more, never that it is silently cut. */
export const MAX_RECORDED_KEYS = 256;
/** Scopes (one per agent instance) kept in memory. */
export const MAX_SCOPES = 64;
/** Spilled results kept per instance directory; the oldest are reclaimed first, so a
 * handle is best-effort and the document says so. */
export const MAX_SPILL_FILES = 256;
const COUNTS_FILE = 'counts.json';

/**
 * Per-tool ceilings on the model-visible text. Only `bash` and the system inventory are
 * listed: upstream `read` already continues with `offset` and upstream `edit` already
 * answers in one line, so a cap here would fight behaviour that is already the right shape.
 */
/**
 * Per-tool ceilings on the model-visible text. Only the tools that can flood the prompt in a single
 * view are listed: `bash` (host output), the system inventory (one dump), and reading another
 * conversation (a whole session). Upstream `read` already continues with `offset` and upstream `edit`
 * already answers in one line, so a cap here would fight behaviour that is already the right shape.
 */
const TOOL_TEXT_LIMITS: Record<string, number> = {
  bash: SHELL_OUTPUT_LIMIT,
  read_system_capabilities: SYSTEM_SUMMARY_LIMIT,
  conversation_read: CONVERSATION_READ_LIMIT,
};

type ContentPart = NonNullable<ContentOverride['content']>[number];
type ResultPart = { type: string; text?: string };

/** The part of an agent-loop tool result this seam reads. */
export type ToolResultHookContext = {
  toolCall: { name: string };
  args: unknown;
  result: { content: readonly ResultPart[] };
};

/** One occurrence counter with a hard size bound, ordered by recency. */
export type ToolResultTracker = {
  record: (key: string) => number;
  counts: () => Record<string, number>;
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

function forgetOldest(seen: Map<string, number>, capacity: number) {
  while (seen.size > capacity) {
    const oldest = seen.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    seen.delete(oldest);
  }
}

export function createToolResultTracker(options: { capacity?: number; initial?: Record<string, number> } = {}): ToolResultTracker {
  const capacity = Math.max(1, options.capacity ?? MAX_RECORDED_KEYS);
  const seen = new Map<string, number>(Object.entries(options.initial ?? {}));
  forgetOldest(seen, capacity);
  return {
    record(key) {
      const next = (seen.get(key) ?? 0) + 1;
      // Re-insert so the map order is the recency order, which is what gets trimmed.
      seen.delete(key);
      seen.set(key, next);
      forgetOldest(seen, capacity);
      return next;
    },
    counts() {
      return Object.fromEntries(seen);
    },
  };
}

/**
 * The SDK's read truncates to a head slice and says so in a *trailing* line, which is easy to lose
 * inside a long result - and a partly shown file then reads like a whole file. Hoisting that notice
 * to the front is what makes a truncated view unmistakable; it changes no content, only where the
 * warning sits. (Investigated 2026-09-25: read has no cache, it re-reads the file every time, so a
 * mismatch between what a read showed and what the file holds is this truncation, not staleness.)
 */
export function hoistTruncationNotice(text: string): string {
  const banner = truncationBanner(text);
  if (!banner || text.startsWith(banner)) return text;
  return `${banner}\n${bodyWithoutNotice(text)}`;
}

/** The banner alone, so a summary can lead with it; null when nothing was truncated. */
export function truncationBanner(text: string): string | null {
  const match = /\n*(\[(?:Showing lines|[\d,]+ more lines in file|Output truncated|Line \d+ is)[^\]]*\])\s*$/.exec(text);
  return match ? `[truncated: ${match[1]!}]` : null;
}

function bodyWithoutNotice(text: string): string {
  return text.replace(/\n*\[(?:Showing lines|[\d,]+ more lines in file|Output truncated|Line \d+ is)[^\]]*\]\s*$/, '');
}

/** Deterministic head/tail summary: same input, same text, no model call. Whole lines are
 * taken from each end while the budget allows, so a short tail - the line that carries a
 * failure - is never lost to one enormous leading line. */
export function summarizeToolResult(input: { text: string; handle: string; limit?: number }): string {
  const limit = input.limit ?? SUMMARY_LIMIT;
  const lineCount = input.text.split('\n').length;
  // The unit is characters, not bytes: a non-ASCII result occupies more bytes on disk
  // than the number reported here, so the label must not claim bytes.
  const header = `[large tool result: ${input.text.length} chars, ${lineCount} lines]`;
  const trailer = `handle: ${input.handle}\nRead the whole result with the read tool (offset/limit) on that path.`;
  const room = Math.max(0, limit - header.length - trailer.length - 64);
  const tailBudget = Math.floor(room / 3);
  const head = boundSide(input.text, room - tailBudget, false);
  const tail = boundSide(input.text, tailBudget, true);
  // Counted from what this summary really dropped, so a single huge line still
  // reports its omission instead of looking complete.
  const dropped = Math.max(0, input.text.length - head.length - tail.length);
  const marker = `... omitted ${dropped} of ${input.text.length} chars ...`;
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

/** Keep only the newest spilled results. A reclaimed handle is deliberately possible: the
 * summary stays truthful about the bytes, but a very old handle may be gone. */
async function pruneSpills(spillDir: string, keep: number): Promise<void> {
  const names = (await readdir(spillDir)).filter(name => name.endsWith('.txt'));
  if (names.length <= keep) return;
  const dated = await Promise.all(names.map(async (name) => {
    try {
      return { name, mtime: (await stat(join(spillDir, name))).mtimeMs };
    } catch {
      return { name, mtime: 0 };
    }
  }));
  dated.sort((left, right) => left.mtime - right.mtime);
  for (const item of dated.slice(0, dated.length - keep)) {
    await rm(join(spillDir, item.name), { force: true });
  }
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
  maxSpillFiles?: number;
}): Promise<string> {
  const text = hoistTruncationNotice(input.text);
  if (input.limit === undefined && text.length <= TOOL_RESULT_LIMIT) return text;
  const key = toolResultKey(input);
  if (input.limit === undefined && input.tracker.record(key) <= 2) return text;
  const handle = join(input.spillDir, `${key}.txt`);
  await mkdir(input.spillDir, { recursive: true });
  await writeFile(handle, text, { mode: 0o600 });
  await pruneSpills(input.spillDir, input.maxSpillFiles ?? MAX_SPILL_FILES);
  const summary = summarizeToolResult({ text, handle, ...(input.limit === undefined ? {} : { limit: input.limit }) });
  // "This file was cut short" outranks "this result is large": the summary's own header must not
  // push the warning out of sight.
  const banner = truncationBanner(input.text);
  return banner ? `${banner}\n${summary}` : summary;
}

type CountsFile = { version: 1; scopes: Record<string, Record<string, number>> };

async function readCounts(spillDir: string): Promise<CountsFile> {
  try {
    const parsed = JSON.parse(await readFile(join(spillDir, COUNTS_FILE), 'utf8')) as Partial<CountsFile>;
    if (parsed?.version === 1 && parsed.scopes && typeof parsed.scopes === 'object') {
      return { version: 1, scopes: parsed.scopes };
    }
  } catch {
    // A missing or unreadable counts file only means this scope starts fresh.
  }
  return { version: 1, scopes: {} };
}

async function writeCounts(spillDir: string, file: CountsFile): Promise<void> {
  await mkdir(spillDir, { recursive: true });
  const target = join(spillDir, COUNTS_FILE);
  await writeFile(`${target}.tmp`, JSON.stringify(file), { mode: 0o600 });
  await rename(`${target}.tmp`, target);
}

/** One tracker per scope, in recency order. */
const scopes = new Map<string, { tracker: ToolResultTracker; spillDir: string }>();
// Parallel Pi calls can share a spill directory. Serialize the complete read/record/write
// cycle, including tracker initialization, so neither counters nor rename targets race.
const directoryWrites = new Map<string, Promise<unknown>>();

async function inSpillDirectory<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const previous = directoryWrites.get(directory) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  directoryWrites.set(directory, next);
  try { return await next; }
  finally { if (directoryWrites.get(directory) === next) directoryWrites.delete(directory); }
}

async function trackerFor(scopeId: string, spillDir: string): Promise<ToolResultTracker> {
  const existing = scopes.get(scopeId);
  if (existing) {
    scopes.delete(scopeId);
    scopes.set(scopeId, existing);
    return existing.tracker;
  }
  // The counts live next to the handles, so an instance reopened for the same binding
  // continues where it stopped instead of forgetting the previous views.
  const saved = await readCounts(spillDir);
  const previous = saved.scopes[scopeId];
  const created = { tracker: createToolResultTracker(previous ? { initial: previous } : {}), spillDir };
  scopes.set(scopeId, created);
  forgetOldestScopes();
  return created.tracker;
}

function forgetOldestScopes() {
  while (scopes.size > MAX_SCOPES) {
    const oldest = scopes.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    scopes.delete(oldest);
  }
}

async function persistScope(scopeId: string, tracker: ToolResultTracker): Promise<void> {
  const entry = scopes.get(scopeId);
  if (!entry) return;
  const saved = await readCounts(entry.spillDir);
  saved.scopes[scopeId] = tracker.counts();
  const ids = Object.keys(saved.scopes);
  while (ids.length > MAX_SCOPES) delete saved.scopes[ids.shift()!];
  await writeCounts(entry.spillDir, saved);
}

/**
 * Build the agent loop's `afterToolCall` hook. It returns `undefined` whenever the
 * result should reach the model exactly as the tool produced it - a small result, a
 * first or second view of a large one, or a result with no text at all - so nothing
 * but a genuinely repeated large result (or one over its ceiling) is ever rewritten.
 */
export function toolResultHook(input: { scopeId: string; spillDir: string; maxSpillFiles?: number }) {
  return async (context: ToolResultHookContext): Promise<ContentOverride | undefined> => {
    const parts = context?.result?.content;
    if (!Array.isArray(parts)) return undefined;
    const texts = parts.filter(part => part.type === 'text').map(part => part.text ?? '');
    if (!texts.length) return undefined;
    const name = context.toolCall?.name ?? 'unknown';
    const text = texts.join('\n');
    const ceiling = TOOL_TEXT_LIMITS[name];
    const limit = ceiling !== undefined && text.length > ceiling ? ceiling : undefined;
    if (limit === undefined && text.length <= TOOL_RESULT_LIMIT) return undefined;
    return inSpillDirectory(input.spillDir, async () => {
      const tracker = await trackerFor(input.scopeId, input.spillDir);
      const rendered = await renderToolResult({
        text,
        conversationId: input.scopeId,
        tool: name,
        params: context.args,
        spillDir: input.spillDir,
        tracker,
        ...(limit === undefined ? {} : { limit }),
        ...(input.maxSpillFiles === undefined ? {} : { maxSpillFiles: input.maxSpillFiles }),
      });
      // Only the lazy path advances a count, so only it needs to be durable.
      if (limit === undefined) await persistScope(input.scopeId, tracker);
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
    });
  };
}
