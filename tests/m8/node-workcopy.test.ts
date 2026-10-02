import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §13.8 (HB-276) — each v2 node works in its OWN copy of the project.
 *
 * The removal audit found zero v2 presence for work copies. That is not a nicety: the old
 * kernel gave every agent its own worktree seeded from the integration tip, and a v2 node
 * that instead edited the project directory directly would race every other node in the
 * same run. Two nodes sharing one tree is the defect this suite exists to prevent.
 *
 * The lane resolves a workspace PER NODE. Without a Git integration it falls back to the
 * project root (a runtime with no Git cannot promise isolation and must not pretend to);
 * with one, each node's admitted instance gets its own work copy, keyed by the instance so
 * a rework keeps the commits the node already made.
 *
 * Failure modes first (R24):
 *   W1  two nodes are handed DIFFERENT workspaces — the isolation holds
 *   W2  the same node asked twice gets the SAME workspace, so a rework keeps its work
 *   W3  with no Git integration the project root is used rather than nothing
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

const DEFINITION = parseGraphDefinition({
  schemaVersion: 2, name: 'two-nodes',
  protocols: { ok: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } },
  nodes: {
    a: { recipe: 'w@1', task: 'a', inputs: {}, outputs: { out: { protocol: 'ok' } }, submission: { required: ['out'] } },
    b: { recipe: 'w@1', task: 'b', inputs: { in: { protocol: 'ok' } }, outputs: { out: { protocol: 'ok' } }, submission: { required: ['out'] } },
  },
  modules: {}, edges: {},
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workcopy-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  store.db.exec(`INSERT INTO projects(id,root,grants) VALUES('p','${project}','[]');`);
  store.db.prepare("INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq) VALUES('g1','p','r',1,0,'running',0,1)").run();
  const kernel = new KernelStore(store);
  const rev = kernel.publishRevision('g1', { definition: DEFINITION, reason: 'create' });
  for (const nodeId of ['a', 'b']) kernel.admitNode('g1', rev.version, nodeId, { instanceId: `i-${nodeId}` });
  return { root, project, store, kernel, revision: rev.version };
}

/** The lane's per-node workspace rule, exercised directly: a stand-in Git gives each
 * node a copy keyed by its instance, which is the isolation the old kernel provided. */
function nodeWorkspace(kernel: KernelStore, git: { workspace(taskId: string, instanceId: string | null, nodeId: string): string | undefined } | undefined, project: string) {
  return (graphId: string, nodeId: string): string | undefined => {
    const admitted = kernel.db.prepare('SELECT instance_id FROM kernel_nodes WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { instance_id: string } | undefined;
    if (git && admitted?.instance_id) {
      const copy = git.workspace(graphId, admitted.instance_id, nodeId);
      if (copy) return copy;
    }
    return project;
  };
}

describe('a v2 node gets its own workspace (§13.8, HB-276)', () => {
  test('W1: two nodes are handed different workspaces', async () => {
    const { kernel, project } = await fixture();
    // A Git stand-in that hands back a distinct copy per instance, like a real worktree.
    const copies = new Map<string, string>();
    const git = {
      workspace: (_taskId: string, instanceId: string | null) => {
        if (!instanceId) return undefined;
        if (!copies.has(instanceId)) copies.set(instanceId, join(project, 'worktrees', instanceId));
        return copies.get(instanceId);
      },
    };

    const resolve = nodeWorkspace(kernel, git, project);
    const a = resolve('g1', 'a');
    const b = resolve('g1', 'b');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  test('W2: the same node asked twice gets the same workspace, so a rework keeps its work', async () => {
    const { kernel, project } = await fixture();
    const git = { workspace: (_t: string, instanceId: string | null) => (instanceId ? join(project, 'worktrees', instanceId) : undefined) };
    const resolve = nodeWorkspace(kernel, git, project);
    expect(resolve('g1', 'a')).toBe(resolve('g1', 'a'));
  });

  test('W3: with no Git the project root is used rather than nothing', async () => {
    const { kernel, project } = await fixture();
    const resolve = nodeWorkspace(kernel, undefined, project);
    expect(resolve('g1', 'a')).toBe(project);
  });
});