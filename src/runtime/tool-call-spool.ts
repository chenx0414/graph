/**
 * A tool call reaches `tool_calls` through the store's own writer, in process. A lane that holds only
 * a file leaves a spool line instead, and reading the statistics folds those files in - this module
 * is the file side of that: where a spool can be, the offset that makes folding it idempotent, clearing.
 *
 * Both the daemon's own root and one directory per instance are read. A lane receives its session
 * directory as its state dir, so its spool lands at `<stateDir>/instances/<instanceId>/tool-calls/`;
 * a lane handed the root writes there instead. One convention from two ends, and reading only the
 * root reported zero calls for every lane while the samples sat on disk.
 */
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskStore } from '../core/store.ts';

export const TOOL_CALL_SPOOL_DIR = 'tool-calls';
export const INSTANCES_DIR = 'instances';
const RETAIN_DAYS = 90;

/** The file one instance's spool is read from: `<stateDir>/tool-calls/<instanceId>.jsonl`. */
export function toolCallSpoolPath(stateDir: string, instanceId: string): string {
  // An instance id is a uuid today; a file name is not the place to rely on that.
  return join(stateDir, TOOL_CALL_SPOOL_DIR, `${instanceId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
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

/** Every directory a lane's spool can be in, seen from the daemon: its own root and one per instance. */
async function spoolDirs(stateDir: string): Promise<string[]> {
  const dirs = [join(stateDir, TOOL_CALL_SPOOL_DIR)];
  const instances = await readdir(join(stateDir, INSTANCES_DIR)).catch(() => [] as string[]);
  for (const instance of instances) dirs.push(join(stateDir, INSTANCES_DIR, instance, TOOL_CALL_SPOOL_DIR));
  return dirs;
}

async function ingestOnce(store: TaskStore, stateDir: string, keepDays = RETAIN_DAYS): Promise<number> {
  let ingested = 0;
  for (const dir of await spoolDirs(stateDir)) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
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
  }
  return ingested;
}

/** Remove every spool file: a cleared sample must not be re-ingested from disk. */
export async function clearToolCallSpools(stateDir: string): Promise<void> {
  for (const dir of await spoolDirs(stateDir)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
