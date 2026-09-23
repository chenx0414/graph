/**
 * Readable, deterministic task/work-copy naming.
 *
 * A Chinese task summary is transliterated to a toneless pinyin slug, followed
 * by the first 8 hex characters of the task id. This keeps branch and worktree
 * names inspectable (`graph/task/xiu-fu-deng-lu-0faf1367`) while staying unique
 * across tasks that share a summary.
 *
 * Pure functions only: no IO, no Date, no randomness, no dependencies beyond the
 * built-in pinyin table. Historically recorded branch/path values are never
 * derived again from here, so existing tasks are untouched.
 */
import { pinyinFor } from './pinyin-table.ts';

/** Longest slug kept; git itself allows more, but names should stay scannable. */
export const MAX_SLUG_LENGTH = 40;

/** Uppercase/lowercase ASCII letters and digits survive as lowercase runs. */
const ASCII_ALNUM = /^[A-Za-z0-9]$/;
/** Han ideographs not covered by the table are preserved instead of dropped. */
const HAN = /^\p{Script=Han}$/u;

/** Fallback slug when a summary has no usable characters at all. */
export const DEFAULT_SLUG = 'task';

/**
 * Turn an arbitrary task summary into a branch-safe slug:
 * ASCII alphanumerics are lowercased, Han characters become toneless pinyin,
 * every other run collapses into a single '-', leading/trailing '-' are trimmed
 * and the result is capped at {@link MAX_SLUG_LENGTH} characters. An empty or
 * punctuation-only summary becomes {@link DEFAULT_SLUG}.
 */
export function taskSlug(request: string): string {
  const source = typeof request === 'string' ? request.normalize('NFC') : '';
  const tokens: string[] = [];
  let ascii = '';
  for (const char of source) {
    if (ASCII_ALNUM.test(char)) { ascii += char.toLowerCase(); continue; }
    if (ascii) { tokens.push(ascii); ascii = ''; }
    const pinyin = pinyinFor(char);
    if (pinyin) { tokens.push(pinyin); continue; }
    // Unknown Han stays readable; any other separator just breaks the run.
    if (HAN.test(char)) tokens.push(char);
  }
  if (ascii) tokens.push(ascii);
  const collapsed = tokens.join('-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const truncated = collapsed.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '').replace(/^-+/g, '');
  return truncated || DEFAULT_SLUG;
}

/** First 8 characters of the task id with separators removed; keeps tasks unique. */
export function taskShortId(taskId: string): string {
  const compact = (typeof taskId === 'string' ? taskId : '').replace(/[^0-9a-zA-Z]/g, '');
  return compact.slice(0, 8) || DEFAULT_SLUG;
}

/** Integration branch: `graph/task/<slug>-<shortId>`. */
export function taskBranchName(request: string, taskId: string): string {
  return `graph/task/${taskSlug(request)}-${taskShortId(taskId)}`;
}

/** Per-instance work-copy branch: `graph/copy/<slug>-<shortId>/<nodeId>`. */
export function workCopyBranchName(request: string, taskId: string, nodeId: string): string {
  return `graph/copy/${taskSlug(request)}-${taskShortId(taskId)}/${nodeId}`;
}

/** Per-task worktree directory: `<slug>-<shortId>` under the state worktrees root. */
export function taskWorktreeDirName(request: string, taskId: string): string {
  return `${taskSlug(request)}-${taskShortId(taskId)}`;
}

/**
 * First free directory name for a node: prefer the node id, then `-2`, `-3`…
 * so re-activating the same node never overwrites an earlier work copy.
 */
export function uniqueWorktreeDirName(preferred: string, taken: Iterable<string>): string {
  const used = taken instanceof Set ? taken : new Set(taken);
  if (!used.has(preferred)) return preferred;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${preferred}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
