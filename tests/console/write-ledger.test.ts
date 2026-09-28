import { mkdtemp, rm, writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { WriteLedger, WRITE_TOOLS, capturePathFor } from '../../src/core/write-ledger.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-write-ledger-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'copy');
  await mkdir(workspace, { recursive: true });
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  return { root, workspace, store, ledger: new WriteLedger(store) };
}

/** A capture scope is one lane's turn: the same (task, node, instance, turn) keeps one record per file. */
const scope = { taskId: 't', nodeId: 'n', instanceId: 'i', turnId: 'turn-1' };

test('the same file written twice keeps one record whose before is the first content', async () => {
  const { workspace, ledger } = await fixture('twice');
  await writeFile(join(workspace, 'a.txt'), 'v1\n');
  await ledger.capture('open', { ...scope, toolCallId: 'c1', toolName: 'write_file', path: 'a.txt', workspace });
  await writeFile(join(workspace, 'a.txt'), 'v2\n');
  await ledger.capture('open', { ...scope, toolCallId: 'c2', toolName: 'write_file', path: 'a.txt', workspace });
  await writeFile(join(workspace, 'a.txt'), 'v3\n');
  await ledger.capture('close', { ...scope, toolCallId: 'c2', toolName: 'write_file', path: 'a.txt', workspace });

  const records = ledger.records('t', 'n');
  expect(records).toHaveLength(1);
  expect(records[0]!.path).toBe('a.txt');
  // before is the content the *first* write saw, never an intermediate state.
  expect(records[0]!.before.content).toBe('v1\n');
  expect(records[0]!.after!.content).toBe('v3\n');
});

test('a file created and then deleted keeps both sides of the fact and counts as no net change', async () => {
  const { workspace, ledger } = await fixture('deleted');
  await ledger.capture('open', { ...scope, toolCallId: 'c1', toolName: 'write_file', path: 'gone.txt', workspace });
  await writeFile(join(workspace, 'gone.txt'), 'temporary\n');
  await unlink(join(workspace, 'gone.txt'));
  await ledger.capture('close', { ...scope, toolCallId: 'c1', toolName: 'write_file', path: 'gone.txt', workspace });

  const record = ledger.records('t', 'n')[0]!;
  expect(record.before.exists).toBe(false);
  // Nothing exists on either side, and no digest is invented for bytes that are no longer there.
  expect(record.after).toMatchObject({ exists: false, digest: null });
  expect(ledger.changes('t', 'n')).toEqual([]);
});

test('an oversized file is recorded by size and digest without reading its content', async () => {
  const { workspace, ledger } = await fixture('oversized');
  await writeFile(join(workspace, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
  await ledger.capture('open', { ...scope, toolCallId: 'c1', toolName: 'write_file', path: 'big.bin', workspace });
  await ledger.capture('close', { ...scope, toolCallId: 'c1', toolName: 'write_file', path: 'big.bin', workspace });

  const record = ledger.records('t', 'n')[0]!;
  expect(record.after!.oversized).toBe(true);
  expect(record.after!.content).toBeNull();
  expect(record.after!.digest).toMatch(/^[a-f0-9]{64}$/);
});

test('a path outside the lane is refused instead of recorded', async () => {
  const { root, workspace, ledger } = await fixture('outside');
  await expect(ledger.capture('open', { ...scope, toolCallId: 'c1', toolName: 'write_file', path: join(root, '..', 'escape.txt'), workspace }))
    .rejects.toThrow(/outside/i);
  expect(ledger.records('t', 'n')).toHaveLength(0);
});

test('non-write tools and a repeated tool call never create noise or duplicates', async () => {
  const { workspace, ledger } = await fixture('noise');
  expect(WRITE_TOOLS.has('write_file')).toBe(true);
  expect(WRITE_TOOLS.has('read')).toBe(false);
  // bash cannot be captured reliably: no before/after, so it must not pretend to.
  expect(WRITE_TOOLS.has('bash')).toBe(false);
  expect(capturePathFor('bash', 'a.txt')).toBeNull();
  expect(capturePathFor('write_file', 'a.txt')).toBe('a.txt');

  await ledger.capture('open', { ...scope, toolCallId: 'c1', toolName: 'bash', path: 'a.txt', workspace });
  await ledger.capture('open', { ...scope, toolCallId: 'c2', toolName: 'read', path: 'a.txt', workspace });
  expect(ledger.records('t', 'n')).toHaveLength(0);

  await writeFile(join(workspace, 'a.txt'), 'v1\n');
  await ledger.capture('open', { ...scope, toolCallId: 'c3', toolName: 'write_file', path: 'a.txt', workspace });
  await ledger.capture('open', { ...scope, toolCallId: 'c3', toolName: 'write_file', path: 'a.txt', workspace });
  expect(ledger.records('t', 'n')).toHaveLength(1);
});

test('a lane change set is what the disk says, so the manifest can be judged against it', async () => {
  const { workspace, ledger } = await fixture('changeset');
  await writeFile(join(workspace, 'kept.txt'), 'before\n');
  await ledger.capture('open', { ...scope, toolCallId: 'c1', toolName: 'write_file', path: 'kept.txt', workspace });
  await writeFile(join(workspace, 'kept.txt'), 'after\n');
  await ledger.capture('close', { ...scope, toolCallId: 'c1', toolName: 'write_file', path: 'kept.txt', workspace });

  const changes = ledger.changes('t', 'n');
  expect(changes).toEqual([{
    path: 'kept.txt',
    beforeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    afterDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    status: 'modified',
  }]);
  expect(ledger.records('t', 'other')).toHaveLength(0);
});

test('a ledger read for a task whose records are gone is empty, never an error', async () => {
  const { ledger } = await fixture('empty');
  expect(ledger.records('missing', 'missing')).toEqual([]);
  expect(ledger.changes('missing', 'missing')).toEqual([]);
});
