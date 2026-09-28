import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { TaskStore } from './store.ts';

/**
 * Recorded proof of what a lane actually wrote, and the only evidence a worker's manifest is
 * judged against.
 *
 * Each lane already works in its own `graph/copy/*` checkout, so two lanes cannot see each
 * other's files. What a lane could still do is *claim* something other than what it wrote:
 * report a file it never touched, miss a file it did touch, or carry a digest copied from a
 * draft. This ledger records the bytes before and after every write a lane performs, so the
 * manifest can be compared with the disk instead of believed.
 *
 * The capture is deliberately small: a path, an existence flag, a sha256 and - for text that
 * fits the bound - the content. A file too large to hold is still recorded by size and digest,
 * because the digest is what a manifest is checked against.
 */

/** The tools whose effect on a single path can be observed before and after. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit',
  'multiedit',
  'multi_edit',
  'file_edit',
  'apply_patch',
]);

/** Text up to this size is kept in the record; larger files keep only size and digest. */
export const MAX_CAPTURE_TEXT_BYTES = 2 * 1024 * 1024;

export interface WriteSnapshot {
  exists: boolean;
  /** sha256 of the bytes, or null when the file does not exist. */
  digest: string | null;
  sizeBytes: number | null;
  /** The text itself, or null when it does not exist, is not text, or exceeds the bound. */
  content: string | null;
  oversized: boolean;
  binary: boolean;
}

export interface WriteRecord {
  taskId: string;
  nodeId: string;
  instanceId: string | null;
  turnId: string;
  /** Lane-relative, forward-slashed, so the same file has one identity across platforms. */
  path: string;
  toolName: string;
  toolCallId: string;
  before: WriteSnapshot;
  after: WriteSnapshot | null;
  createdAt: number;
}

export interface WriteCaptureInput {
  taskId: string;
  nodeId: string;
  instanceId: string | null;
  turnId: string;
  toolCallId: string;
  toolName: string;
  /** As the tool received it: relative to the lane, or absolute inside it. */
  path: string;
  /** The lane root the path must stay inside. */
  workspace: string;
}

/**
 * The path a write tool acts on, or null when the tool's effect cannot be captured. `bash` is
 * absent on purpose: a shell can write through a redirection, a subshell or a program it starts,
 * so a before/after snapshot of one path would be a guess dressed as evidence. Shell writes are
 * caught later, when the manifest is compared with the disk.
 */
export function capturePathFor(toolName: string, path: unknown): string | null {
  if (!WRITE_TOOLS.has(toolName)) return null;
  return typeof path === 'string' && path.length > 0 && !path.includes('\0') ? path : null;
}

function missing(): WriteSnapshot {
  return { exists: false, digest: null, sizeBytes: null, content: null, oversized: false, binary: false };
}

/**
 * Read one file's identity without trusting the caller's path.
 *
 * The path is resolved against the lane root and refused when it escapes, so a record can never
 * describe a file another lane owns. Symlinks are not followed out of the lane: the resolved
 * target must still be inside it.
 */
export async function snapshotFile(workspace: string, path: string): Promise<WriteSnapshot> {
  const root = await realpath(resolve(workspace));
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const inside = target === root || target.startsWith(`${root}${sep}`);
  if (!inside) throw new Error(`Path is outside the lane workspace: ${path}`);
  let handle;
  try {
    const linkInfo = await stat(target);
    if (!linkInfo.isFile()) return missing();
    handle = await open(target, 'r');
  } catch {
    return missing();
  }
  try {
    const info = await handle.stat();
    const sizeBytes = info.size;
    const digest = createHash('sha256');
    const chunks: Buffer[] = [];
    let carried = 0;
    let binary = false;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      digest.update(buffer);
      if (carried < MAX_CAPTURE_TEXT_BYTES) {
        chunks.push(buffer);
        carried += buffer.length;
      }
      if (!binary && buffer.includes(0)) binary = true;
    }
    return {
      exists: true,
      digest: digest.digest('hex'),
      sizeBytes,
      // A binary file has no meaningful text form, and an oversized one is judged by digest.
      content: binary || sizeBytes > MAX_CAPTURE_TEXT_BYTES ? null : Buffer.concat(chunks).toString('utf8'),
      oversized: sizeBytes > MAX_CAPTURE_TEXT_BYTES,
      binary,
    };
  } finally {
    await handle.close();
  }
}

interface Row {
  task_id: string; node_id: string; instance_id: string | null; turn_id: string; path: string;
  tool_name: string; tool_call_id: string; before: string; after: string | null; created_at: number;
}

function parse(json: string): WriteSnapshot {
  return JSON.parse(json) as WriteSnapshot;
}

/** One lane's write ledger, and the change set derived from it. */
export class WriteLedger {
  // Declared as a field rather than a constructor parameter property: worker children load these
  // modules through Node's type stripping, which refuses parameter properties outright.
  private readonly store: TaskStore;

  constructor(store: TaskStore) {
    this.store = store;
  }

  /**
   * Record one side of a write. `open` stores the state a tool is about to change, `close` the
   * state it left behind.
   *
   * The first `open` for a path wins: a second write to the same file in the same turn must not
   * replace the pre-turn bytes with an intermediate state, or the lane's change set would
   * describe only its last edit. A repeated `open` for the same tool call is idempotent.
   */
  async capture(side: 'open' | 'close', input: WriteCaptureInput): Promise<WriteRecord | null> {
    const path = capturePathFor(input.toolName, input.path);
    if (!path) return null;
    const snapshot = await snapshotFile(input.workspace, path);
    const relativePath = relativeLanePath(input.workspace, path);
    return this.store.transaction(() => {
      const existing = this.store.db.prepare(
        'SELECT * FROM node_write_captures WHERE task_id=? AND node_id=? AND turn_id=? AND path=?',
      ).get(input.taskId, input.nodeId, input.turnId, relativePath) as unknown as Row | undefined;
      if (side === 'open') {
        if (existing) return rowToRecord(existing);
        this.store.db.prepare(`INSERT INTO node_write_captures
          (task_id,node_id,instance_id,turn_id,path,tool_name,tool_call_id,before,after,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
          input.taskId, input.nodeId, input.instanceId, input.turnId, relativePath,
          input.toolName, input.toolCallId, JSON.stringify(snapshot), null, Date.now(),
        );
      } else {
        if (!existing) {
          // A close without an open means the capture started mid-write; the honest record is
          // that nothing is known about the before state, not a fabricated one.
          this.store.db.prepare(`INSERT INTO node_write_captures
            (task_id,node_id,instance_id,turn_id,path,tool_name,tool_call_id,before,after,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
            input.taskId, input.nodeId, input.instanceId, input.turnId, relativePath,
            input.toolName, input.toolCallId, JSON.stringify(missing()), JSON.stringify(snapshot), Date.now(),
          );
        } else {
          this.store.db.prepare(
            'UPDATE node_write_captures SET after=? WHERE task_id=? AND node_id=? AND turn_id=? AND path=?',
          ).run(JSON.stringify(snapshot), input.taskId, input.nodeId, input.turnId, relativePath);
        }
      }
      const row = this.store.db.prepare(
        'SELECT * FROM node_write_captures WHERE task_id=? AND node_id=? AND turn_id=? AND path=?',
      ).get(input.taskId, input.nodeId, input.turnId, relativePath) as unknown as Row;
      return rowToRecord(row);
    });
  }

  /** Every file the node touched, oldest capture first. */
  records(taskId: string, nodeId: string): WriteRecord[] {
    const rows = this.store.db.prepare(
      'SELECT * FROM node_write_captures WHERE task_id=? AND node_id=? ORDER BY created_at, path',
    ).all(taskId, nodeId) as unknown as Row[];
    return rows.map(rowToRecord);
  }

  /**
   * The lane's change set: what the disk says this node changed, in the shape a manifest is
   * judged against. A record whose `before` and `after` digests agree is not a change.
   */
  changes(taskId: string, nodeId: string): LaneChange[] {
    const changes: LaneChange[] = [];
    for (const record of this.records(taskId, nodeId)) {
      const before = record.before.exists ? record.before.digest : null;
      const after = record.after?.exists ? record.after.digest : null;
      if (before === after) continue;
      changes.push({
        path: record.path,
        beforeDigest: before,
        afterDigest: after,
        status: before === null ? 'added' : after === null ? 'deleted' : 'modified',
      });
    }
    return changes;
  }
}

export interface LaneChange {
  path: string;
  beforeDigest: string | null;
  afterDigest: string | null;
  status: 'added' | 'modified' | 'deleted';
}

function rowToRecord(row: Row): WriteRecord {
  return {
    taskId: row.task_id,
    nodeId: row.node_id,
    instanceId: row.instance_id,
    turnId: row.turn_id,
    path: row.path,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    before: parse(row.before),
    after: row.after === null ? null : parse(row.after),
    createdAt: row.created_at,
  };
}

/** A lane-relative, forward-slashed path: one identity per file regardless of how it was named. */
export function relativeLanePath(workspace: string, path: string): string {
  const root = resolve(workspace);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const relative = target === root ? '' : target.startsWith(`${root}${sep}`) ? target.slice(root.length + 1) : null;
  if (relative === null) throw new Error(`Path is outside the lane workspace: ${path}`);
  return relative.split(sep).join('/');
}
