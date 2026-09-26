/**
 * Worker lanes run in a child process that holds no store, so their tool calls cannot be
 * written by the daemon's own seam. They are spooled to a file inside the state directory
 * the worker was already given, and folded into `tool_calls` on the next read.
 *
 * A file, not a new protocol: the worker already writes only inside that directory, and an
 * append cannot block the turn it observes. Losing a sample is acceptable; breaking a tool
 * call is not, so every write here swallows its own failure.
 */
import { appendFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskStore } from '../core/store.ts';

export const TOOL_CALL_SPOOL_DIR = 'tool-calls';
const RETAIN_DAYS = 90;

/** Where one worker instance spools its calls. */
export function toolCallSpoolPath(stateDir: string, instanceId: string): string {
  return join(stateDir, TOOL_CALL_SPOOL_DIR, `${instanceId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
}

/** Called from the worker's tool-call seam. Never throws: telemetry must not break a turn. */
export async function spoolToolCall(
  stateDir: string,
  instanceId: string,
  call: { tool: string; ms: number; isError: boolean; target?: string | null },
): Promise<void> {
  try {
    await mkdir(join(stateDir, TOOL_CALL_SPOOL_DIR), { recursive: true });
    await appendFile(toolCallSpoolPath(stateDir, instanceId), `${JSON.stringify({
      instanceId,
      tool: call.tool,
      ms: Math.max(0, Math.round(call.ms)),
      isError: call.isError,
      at: Date.now(),
      ...(call.target ? { target: call.target } : {}),
    })}\n`);
  } catch {
    // An unwritable spool is a missing sample, never a failed tool call.
  }
}

function parseSpooledLine(line: string): { instanceId: string; tool: string; ms: number; isError: boolean; at: number; target: string | null } | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value['instanceId'] !== 'string' || typeof value['tool'] !== 'string') return null;
    return {
      instanceId: value['instanceId'],
      tool: value['tool'],
      ms: typeof value['ms'] === 'number' ? value['ms'] : 0,
      isError: value['isError'] === true,
      at: typeof value['at'] === 'number' ? value['at'] : Date.now(),
      target: typeof value['target'] === 'string' ? value['target'] : null,
    };
  } catch {
    return null;
  }
}

/**
 * Fold spooled worker calls into the store, continuing from the byte offset recorded per file.
 * That offset is what makes an ingest idempotent, and it also means a partially written last
 * line is simply read again next time. A file that shrank was rewritten by someone else, so
 * the read starts over rather than trusting a stale offset.
 */
/**
 * Reading is what folds worker calls in, and two readers can ask at the same moment (the console
 * fetches the tool numbers and the skill numbers together). The ingest state lives in the store and
 * on disk, so two concurrent passes would each read the same offset and insert the same lines
 * twice. One pass per state directory at a time; a caller arriving during a pass joins it.
 */
const ingesting = new Map<string, Promise<number>>();

export function ingestToolCallSpools(store: TaskStore, stateDir: string, keepDays = RETAIN_DAYS): Promise<number> {
  const running = ingesting.get(stateDir);
  if (running) return running;
  const pass = ingestOnce(store, stateDir, keepDays).finally(() => { ingesting.delete(stateDir); });
  ingesting.set(stateDir, pass);
  return pass;
}

async function ingestOnce(store: TaskStore, stateDir: string, keepDays = RETAIN_DAYS): Promise<number> {
  const dir = join(stateDir, TOOL_CALL_SPOOL_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let ingested = 0;
  for (const name of names.filter(entry => entry.endsWith('.jsonl'))) {
    const file = join(dir, name);
    const info = await stat(file).catch(() => null);
    if (!info) continue;
    const recorded = store.toolCallSpoolOffset(file);
    const from = recorded > info.size ? 0 : recorded;
    if (info.size > from) {
      const text = await readFile(file, 'utf8');
      const chunk = text.slice(from);
      const cut = chunk.lastIndexOf('\n');
      if (cut >= 0) {
        const consumed = chunk.slice(0, cut + 1);
        for (const line of consumed.split('\n')) {
          if (!line.trim()) continue;
          const parsed = parseSpooledLine(line);
          if (!parsed) continue;
          store.recordToolCall({
            instanceId: parsed.instanceId, tool: parsed.tool, ms: parsed.ms, isError: parsed.isError, at: parsed.at,
            target: parsed.target,
          });
          ingested += 1;
        }
        store.setToolCallSpoolOffset(file, from + Buffer.byteLength(consumed, 'utf8'));
      }
    }
    // A fully consumed spool past the retention window is done with: the rows it produced are
    // pruned by the store on the same schedule.
    if (store.toolCallSpoolOffset(file) >= info.size && info.mtimeMs < Date.now() - keepDays * 86_400_000) {
      await rm(file, { force: true });
      store.forgetToolCallSpool(file);
    }
  }
  return ingested;
}

/** Remove every spool file: a cleared sample must not be re-ingested from disk. */
export async function clearToolCallSpools(stateDir: string): Promise<void> {
  await rm(join(stateDir, TOOL_CALL_SPOOL_DIR), { recursive: true, force: true }).catch(() => undefined);
}
