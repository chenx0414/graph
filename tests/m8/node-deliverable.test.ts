import { git } from '../../src/git/git.ts';
import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { ArtifactWorkspace } from '../../src/core/artifact-workspace.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

// Native auto-publication, failure and version/schema settlement contracts moved to
// tests/console/node-deliverable.test.ts. These distinct artifact authority and
// committed-code guards remain until their complete public workflows prove them.

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
