import { git } from '../../src/git/git.ts';
import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { ArtifactWorkspace } from '../../src/core/artifact-workspace.ts';
import { settleDeliverable } from '../../src/core/node-deliverable.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §13.8 (HB-275) — a v2 node can promise a file, and the kernel keeps that promise.
 *
 * The old path's `deliverable` was one of the few things the new kernel had no answer for
 * (the removal audit found zero v2 presence). Its contract is worth keeping verbatim,
 * because it is what stops a node from "passing" without doing the work:
 *
 *   - the harness publishes the declared file as a task-scope artifact on settle, so the
 *     node never has to remember a tool call;
 *   - a declared file that was never written, or that is empty, FAILS the node;
 *   - identical bytes publish nothing new, because a new version would claim work that
 *     did not change.
 *
 * In v2 the promise is declared on the node in the definition (§5) and settled by the
 * kernel when that node's execution completes.
 *
 * Failure modes first (R24):
 *   D1  a written deliverable is published and the execution still completes
 *   D2  a declared file that was never written fails the node with the reason
 *   D3  an empty declared file fails the node
 *   D4  identical bytes publish no second version; changed bytes publish a new one
 *   D5  a node with no deliverable settles without touching the artifact store
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function fixture(deliverable: string | null) {
  const root = await mkdtemp(join(tmpdir(), 'deliverable-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  store.db.exec(`INSERT INTO projects(id,root,grants) VALUES('p','${root}','[]');`);
  store.db.prepare("INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq) VALUES('g1','p','r',1,0,'running',0,1)").run();
  const kernel = new KernelStore(store);
  const definition = parseGraphDefinition({
    schemaVersion: 2, name: 'g',
    protocols: { done: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } },
    nodes: {
      a: {
        recipe: 'w@1', task: 'write the note', inputs: {},
        outputs: { out: { protocol: 'done' } }, submission: { required: ['out'] },
        ...(deliverable ? { deliverable: { path: deliverable, namespace: 'deliverables', name: 'note' } } : {}),
      },
    },
    modules: {}, edges: {},
  });
  const rev = kernel.publishRevision('g1', { definition, reason: 'c' });
  kernel.admitNode('g1', rev.version, 'a', { instanceId: 'i-a' });
  const execution = kernel.startExecution('g1', { executionId: 'e1', nodeId: 'a', revisionVersion: rev.version });
  return { root, workspace, store, kernel, executionId: execution.id, rev: rev.version };
}

describe('settleDeliverable — a v2 node promise is kept or the node fails (§13.8)', () => {
  test('D1: a written deliverable is published and the execution still completes', async () => {
    const { workspace, kernel, store, executionId } = await fixture('note.md');
    await writeFile(join(workspace, 'note.md'), '# the note\n');
    const artifacts = new ArtifactWorkspace(store, join(workspace, '.artifacts'));

    const outcome = await settleDeliverable({
      kernel, artifacts, graphId: 'g1', nodeId: 'a', revisionVersion: 1,
      executionId, workspace,
    });

    expect(outcome.ok).toBe(true);
    const published = artifacts.list({ taskId: 'g1', namespace: 'deliverables', prefix: 'note', latestOnly: false }).artifacts;
    expect(published).toHaveLength(1);
  });

  test('D2: a declared file that was never written fails the node with the reason', async () => {
    const { workspace, kernel, store, executionId } = await fixture('missing.md');
    const artifacts = new ArtifactWorkspace(store, join(workspace, '.artifacts'));

    const outcome = await settleDeliverable({
      kernel, artifacts, graphId: 'g1', nodeId: 'a', revisionVersion: 1,
      executionId, workspace,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/never written/i);
    // The node must be told, not silently passed.
    expect(kernel.execution(executionId)?.state).not.toBe('completed');
  });

  test('D3: an empty declared file fails the node', async () => {
    const { workspace, kernel, store, executionId } = await fixture('empty.md');
    await writeFile(join(workspace, 'empty.md'), '');
    const artifacts = new ArtifactWorkspace(store, join(workspace, '.artifacts'));

    const outcome = await settleDeliverable({
      kernel, artifacts, graphId: 'g1', nodeId: 'a', revisionVersion: 1,
      executionId, workspace,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/empty/i);
  });

  test('D4: identical bytes publish no second version, changed bytes publish a new one', async () => {
    const { workspace, kernel, store, executionId } = await fixture('note.md');
    const artifacts = new ArtifactWorkspace(store, join(workspace, '.artifacts'));
    const settle = () => settleDeliverable({
      kernel, artifacts, graphId: 'g1', nodeId: 'a', revisionVersion: 1,
      executionId, workspace,
    });

    await writeFile(join(workspace, 'note.md'), 'first\n');
    expect((await settle()).ok).toBe(true);
    // The same bytes again: nothing changed, so a new version would be a false claim.
    expect((await settle()).ok).toBe(true);
    expect(artifacts.list({ taskId: 'g1', namespace: 'deliverables', prefix: 'note', latestOnly: false }).artifacts).toHaveLength(1);

    await writeFile(join(workspace, 'note.md'), 'second, different\n');
    expect((await settle()).ok).toBe(true);
    expect(artifacts.list({ taskId: 'g1', namespace: 'deliverables', prefix: 'note', latestOnly: false }).artifacts).toHaveLength(2);
  });

  test('D5: a node with no deliverable settles without touching the artifact store', async () => {
    const { workspace, kernel, store, executionId } = await fixture(null);
    const artifacts = new ArtifactWorkspace(store, join(workspace, '.artifacts'));

    const outcome = await settleDeliverable({
      kernel, artifacts, graphId: 'g1', nodeId: 'a', revisionVersion: 1,
      executionId, workspace,
    });

    expect(outcome.ok).toBe(true);
    expect(artifacts.list({ taskId: 'g1', namespace: 'deliverables', prefix: 'note', latestOnly: false }).artifacts).toHaveLength(0);
  });
});


test('artifact authority refuses another node overwrite and forged publisher identity', async () => {
  const { workspace, kernel, store } = await fixture(null);
  const current = kernel.latestRevision('g1')!.definition;
  const revision = kernel.publishRevision('g1', { definition: { ...current, nodes: { ...current.nodes, b: structuredClone(current.nodes.a!) } }, reason: 'add reviewer' });
  kernel.admitNode('g1', revision.version, 'b', { instanceId: 'i-b' });
  kernel.startExecution('g1', { executionId: 'e-b', nodeId: 'b', revisionVersion: revision.version });
  const artifacts = new ArtifactWorkspace(store, join(workspace, '.artifacts'));
  const producer = { nodeId: 'a', instanceId: 'i-a', operationId: 'e1', activationId: 'e1' };
  const first = await artifacts.publish({ taskId: 'g1', workspace, namespace: 'plans', name: 'plan', content: '# initial', producer, requestId: 'first' });
  await expect(artifacts.publish({ taskId: 'g1', workspace, namespace: 'plans', name: 'plan', content: '# overwrite', producer: { nodeId: 'b', instanceId: 'i-b', operationId: 'e-b', activationId: 'e-b' }, requestId: 'bad' })).rejects.toThrow(/publisher|author/i);
  await expect(artifacts.publish({ taskId: 'g1', workspace, namespace: 'plans', name: 'other', content: 'forged', producer: { ...producer, instanceId: 'i-b' }, requestId: 'forged' })).rejects.toThrow(/publisher/i);
  expect(artifacts.get('g1', first.artifactId, first.version).version).toBe(1);
});

test('code publication binds committed bytes and old versions remain readable after file changes', async () => {
  const { workspace, store } = await fixture(null);
  git(workspace, ['init']);
  await writeFile(join(workspace, 'code.ts'), 'export const version = 1;\n');
  git(workspace, ['add', 'code.ts']);
  git(workspace, ['commit', '-m', 'v1'], undefined, { name: 'Test', email: 'test@example.com' });
  const artifacts = new ArtifactWorkspace(store, join(workspace, '.artifacts'));
  const producer = { nodeId: 'a', instanceId: 'i-a', operationId: 'e1', activationId: 'e1' };
  const published = await artifacts.publish({ taskId: 'g1', workspace, namespace: 'deliverables', name: 'code', sourcePath: 'code.ts', producer, requestId: 'v1' });
  const commit = git(workspace, ['rev-parse', 'HEAD']).stdout.trim();
  expect(published.metadata.code).toMatchObject({ commit, repository: workspace });
  await writeFile(join(workspace, 'code.ts'), 'export const version = 2;\n');
  await expect(artifacts.publish({ taskId: 'g1', workspace, namespace: 'deliverables', name: 'code', sourcePath: 'code.ts', producer, requestId: 'uncommitted' })).rejects.toThrow(/commit/i);
  expect((await artifacts.read('g1', published.artifactId, 1)).text).toContain('version = 1');
});
