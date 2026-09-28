import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { inspectResultHandoffSubmission } from '../../src/core/predecessor-handoff.ts';
import { WriteLedger } from '../../src/core/write-ledger.ts';
import { TaskStore } from '../../src/core/store.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-manifest-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'copy');
  await mkdir(workspace, { recursive: true });
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  return { root, workspace, store, ledger: new WriteLedger(store) };
}

function manifest(changes: { path: string; digest: string; summary: string }[]) {
  return {
    schemaVersion: 1,
    objective: 'Implement the slice',
    outcome: 'completed',
    workSummary: 'Wrote the file and ran its check.',
    changes: changes.map(change => ({ kind: 'file' as const, ...change })),
    decisions: [],
    verification: [],
    knownLimits: [],
    openQuestions: [],
    nextActions: [],
  };
}

/** The lane's own record of what it wrote, in the shape the harness will judge against. */
async function laneChangeSet(ledger: WriteLedger) {
  return ledger.changes('t', 'n');
}

test('a manifest that matches the lane change set is accepted and keeps the worker own fields', async () => {
  const { workspace, ledger } = await fixture('match');
  await writeFile(join(workspace, 'lib.ts'), 'export const a = 1;\n');
  await ledger.capture('open', { taskId: 't', nodeId: 'n', instanceId: 'i', turnId: 'turn-1', toolCallId: 'c1', toolName: 'write_file', path: 'lib.ts', workspace });
  await writeFile(join(workspace, 'lib.ts'), 'export const a = 2;\n');
  await ledger.capture('close', { taskId: 't', nodeId: 'n', instanceId: 'i', turnId: 'turn-1', toolCallId: 'c1', toolName: 'write_file', path: 'lib.ts', workspace });

  const submission = manifest([{ path: join(workspace, 'lib.ts'), digest: sha('export const a = 2;\n'), summary: 'changed a' }]);
  const inspection = inspectResultHandoffSubmission(submission, {
    workspace,
    changeSet: await laneChangeSet(ledger),
  });
  expect(inspection.defects).toEqual([]);
  expect(inspection.draft?.changes[0]).toMatchObject({ path: join(workspace, 'lib.ts'), digest: sha('export const a = 2;\n'), summary: 'changed a' });
});

test('a manifest that omits a file the lane really changed is refused, naming the omission', async () => {
  const { workspace, ledger } = await fixture('omit');
  await writeFile(join(workspace, 'a.ts'), 'a\n');
  await ledger.capture('open', { taskId: 't', nodeId: 'n', instanceId: 'i', turnId: 'turn-1', toolCallId: 'c1', toolName: 'write_file', path: 'a.ts', workspace });
  await writeFile(join(workspace, 'a.ts'), 'a2\n');
  await ledger.capture('close', { taskId: 't', nodeId: 'n', instanceId: 'i', turnId: 'turn-1', toolCallId: 'c1', toolName: 'write_file', path: 'a.ts', workspace });

  const inspection = inspectResultHandoffSubmission(manifest([]), { workspace, changeSet: await laneChangeSet(ledger) });
  expect(inspection.draft).toBeUndefined();
  expect(inspection.defects.some(defect => defect.expected.includes('every file this lane changed') && defect.got.includes('a.ts'))).toBe(true);
});

test('a manifest that claims a file this lane never touched is refused', async () => {
  const { workspace, ledger } = await fixture('phantom');
  await writeFile(join(workspace, 'real.ts'), 'x\n');
  const inspection = inspectResultHandoffSubmission(
    manifest([{ path: join(workspace, 'real.ts'), digest: sha('x\n'), summary: 'pretend' }]),
    { workspace, changeSet: await laneChangeSet(ledger) },
  );
  expect(inspection.draft).toBeUndefined();
  expect(inspection.defects.some(defect => defect.got.includes('no change recorded'))).toBe(true);
});

test('a manifest whose digest disagrees with the bytes on disk is refused, never rewritten', async () => {
  const { workspace, ledger } = await fixture('digest');
  await writeFile(join(workspace, 'd.ts'), 'true\n');
  await ledger.capture('open', { taskId: 't', nodeId: 'n', instanceId: 'i', turnId: 'turn-1', toolCallId: 'c1', toolName: 'write_file', path: 'd.ts', workspace });
  await writeFile(join(workspace, 'd.ts'), 'false\n');
  await ledger.capture('close', { taskId: 't', nodeId: 'n', instanceId: 'i', turnId: 'turn-1', toolCallId: 'c1', toolName: 'write_file', path: 'd.ts', workspace });

  const inspection = inspectResultHandoffSubmission(
    manifest([{ path: join(workspace, 'd.ts'), digest: sha('true\n'), summary: 'claims the old bytes' }]),
    { workspace, changeSet: await laneChangeSet(ledger) },
  );
  expect(inspection.draft).toBeUndefined();
  expect(inspection.defects.some(defect => /digest/.test(defect.expected))).toBe(true);
});

test('a manifest naming a path outside the lane scope is refused as belonging to another lane', async () => {
  const { workspace, ledger } = await fixture('foreign');
  await writeFile(join(workspace, 'mine.ts'), 'mine\n');
  await ledger.capture('open', { taskId: 't', nodeId: 'n', instanceId: 'i', turnId: 'turn-1', toolCallId: 'c1', toolName: 'write_file', path: 'mine.ts', workspace });
  await writeFile(join(workspace, 'mine.ts'), 'mine2\n');
  await ledger.capture('close', { taskId: 't', nodeId: 'n', instanceId: 'i', turnId: 'turn-1', toolCallId: 'c1', toolName: 'write_file', path: 'mine.ts', workspace });
  await writeFile(join(workspace, 'theirs.ts'), 'theirs\n');

  const inspection = inspectResultHandoffSubmission(
    manifest([
      { path: join(workspace, 'mine.ts'), digest: sha('mine2\n'), summary: 'mine' },
      { path: join(workspace, 'theirs.ts'), digest: sha('theirs\n'), summary: 'not mine' },
    ]),
    { workspace, changeSet: await laneChangeSet(ledger), scope: [relative(workspace, join(workspace, 'mine.ts'))] },
  );
  expect(inspection.draft).toBeUndefined();
  expect(inspection.defects.some(defect => defect.got.includes('theirs.ts'))).toBe(true);
});
