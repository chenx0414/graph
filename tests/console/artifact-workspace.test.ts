import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ArtifactWorkspace } from '../../src/core/artifact-workspace.ts';
import { TaskStore } from '../../src/core/store.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-artifact-workspace-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.db.exec(`
    INSERT INTO projects(id,root,grants) VALUES('p','${root}','[]');
    INSERT INTO projects(id,root,grants) VALUES('q','${root}','[]');
    INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
      VALUES('t1','p','one',1,0,'discussing',0,1);
    INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
      VALUES('t2','p','two',1,0,'discussing',0,2);
    INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
      VALUES('t3','q','three',1,0,'discussing',0,3);
  `);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  return { root, store, workspace, artifacts: new ArtifactWorkspace(store, join(root, 'artifacts')) };
}

function producer(operationId = 'op-1') {
  return { nodeId: 'research', instanceId: 'instance-1', operationId, activationId: 'activation-1', outputVersion: 1 };
}

test('accepts tags in any script while names and namespaces stay ASCII slugs', async () => {
  const { store, workspace, artifacts } = await fixture();
  const source = join(workspace, 'note.json');
  await writeFile(source, '{"note":"one"}');

  const published = await artifacts.publish({
    taskId: 't1', workspace, namespace: 'research', name: 'note', sourcePath: source,
    title: '中文标签', tags: ['编码', 'Known-Issue'], producer: producer(), requestId: 'publish-tag-1',
  });
  expect(published.tags).toEqual(['known-issue', '编码']);
  const listed = await artifacts.list({ taskId: 't1', tag: '编码' });
  expect(listed.artifacts.map(item => item.artifactId)).toContain(published.artifactId);

  await expect(artifacts.publish({
    taskId: 't1', workspace, namespace: 'research', name: 'note', sourcePath: source,
    tags: ['bad tag'], producer: producer(), requestId: 'publish-tag-2',
  })).rejects.toThrow(/must be a label/);
  await expect(artifacts.publish({
    taskId: 't1', workspace, namespace: 'research', name: '中文名', sourcePath: source,
    producer: producer(), requestId: 'publish-tag-3',
  })).rejects.toThrow(/lowercase slug/);
});

test('publishes immutable artifact versions and rejects stale compare-and-swap publishes', async () => {
  const { store, workspace, artifacts } = await fixture();
  const source = join(workspace, 'papers.json');
  await writeFile(source, '{"papers":[{"title":"One"}]}');

  const first = await artifacts.publish({
    taskId: 't1', workspace, namespace: 'research', name: 'papers', sourcePath: source,
    schema: 'source-list@1', title: 'Literature', summary: 'First result set', tags: ['literature'],
    expectedVersion: 0, producer: producer(), requestId: 'publish-1',
  });
  expect(first).toMatchObject({
    version: 1,
    namespace: 'research',
    name: 'papers',
    schemaKind: 'source-list',
    schemaVersion: 1,
    state: 'published',
    uri: 'graph://tasks/t1/artifacts/research/papers@1',
  });
  expect((await artifacts.read('t1', first.artifactId, 1)).text).toContain('One');
  const replayed = await artifacts.publish({
    taskId: 't1', workspace, namespace: 'research', name: 'papers', sourcePath: source,
    schema: 'source-list@1', title: 'Literature', summary: 'First result set', tags: ['literature'],
    expectedVersion: 0, producer: producer(), requestId: 'publish-1',
  });
  expect(replayed).toEqual(first);

  await writeFile(source, '{"papers":[{"title":"Two"}]}');
  const second = await artifacts.publish({
    taskId: 't1', workspace, namespace: 'research', name: 'papers', sourcePath: source,
    schema: 'source-list@1', expectedVersion: 1, producer: producer('op-2'), requestId: 'publish-2',
  });
  expect(second).toMatchObject({ artifactId: first.artifactId, version: 2, supersedes: { artifactId: first.artifactId, version: 1 } });
  expect((await artifacts.read('t1', first.artifactId, 1)).text).toContain('One');
  expect((await artifacts.read('t1', first.artifactId, 2)).text).toContain('Two');

  await expect(artifacts.publish({
    taskId: 't1', workspace, namespace: 'research', name: 'papers', sourcePath: source,
    schema: 'source-list@1', expectedVersion: 1, producer: producer('op-3'), requestId: 'publish-3',
  })).rejects.toMatchObject({ code: 'artifact_conflict' });
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM artifacts').get()).toMatchObject({ count: 2 });
});

test('rejects traversal and symbolic-link publication outside the private workspace', async () => {
  const { root, workspace, artifacts } = await fixture();
  const outside = join(root, 'secret.txt');
  await writeFile(outside, 'secret');
  await symlink(outside, join(workspace, 'link.txt'));

  await expect(artifacts.publish({
    taskId: 't1', workspace, namespace: 'research', name: 'traversal', sourcePath: '../secret.txt',
    producer: producer(), requestId: 'traversal',
  })).rejects.toMatchObject({ code: 'invalid_artifact' });
  await expect(artifacts.publish({
    taskId: 't1', workspace, namespace: 'research', name: 'link', sourcePath: 'link.txt',
    producer: producer(), requestId: 'link',
  })).rejects.toMatchObject({ code: 'invalid_artifact' });
});

test('a path outside the work copy is refused with the fix in the message, not just the rule', async () => {
  // Measured 2026-09-30 on task 68543fed: 7 of 27 artifact_publish calls failed because the report
  // had been written to /tmp, and each node had to rediscover the rule by failing. The refusal is
  // the one place the caller reads, so it names what to do instead.
  const { root, workspace, artifacts } = await fixture();
  const report = join(root, 'report.md');
  await writeFile(report, '# report\n');

  await expect(artifacts.publish({
    taskId: 't1', workspace, namespace: 'research', name: 'elsewhere',
    sourcePath: '../report.md', producer: producer(), requestId: 'elsewhere',
  })).rejects.toThrow(/work copy/);
  await expect(artifacts.publish({
    taskId: 't1', workspace, namespace: 'research', name: 'elsewhere-2',
    sourcePath: '../report.md', producer: producer(), requestId: 'elsewhere-2',
  })).rejects.toThrow(/content/);
});

test('publishes direct text content without first writing a private workspace file', async () => {
  const { workspace, artifacts } = await fixture();
  const plan = await artifacts.publish({
    taskId: 't1',
    workspace,
    namespace: 'plans',
    name: 'implementation-plan',
    content: '# Plan\n\n1. Implement the shared artifact workspace.',
    mediaType: 'text/markdown',
    producer: producer(),
    requestId: 'publish-plan-text',
  });
  expect(plan).toMatchObject({ namespace: 'plans', name: 'implementation-plan', version: 1 });
  expect((await artifacts.read('t1', plan.artifactId, 1)).text).toContain('Implement the shared artifact workspace');
});

test('promotes an exact published version into explicit project knowledge without leaking to another project', async () => {
  const { workspace, artifacts } = await fixture();
  const source = join(workspace, 'notes.md');
  await writeFile(source, '# Shared notes');
  const published = await artifacts.publish({
    taskId: 't1', workspace, namespace: 'summaries', name: 'shared-notes', sourcePath: source,
    mediaType: 'text/markdown', producer: producer(), requestId: 'publish-notes',
  });

  const promoted = await artifacts.promote({
    taskId: 't1', artifactId: published.artifactId, version: published.version,
    requestId: 'promote-notes', promotedBy: 'Atlas_main',
  });
  expect(promoted).toMatchObject({
    scope: 'project',
    projectId: 'p',
    version: 1,
    uri: 'graph://projects/p/artifacts/summaries/shared-notes@1',
  });
  expect(artifacts.list({ taskId: 't2' }).artifacts).toEqual(expect.arrayContaining([
    expect.objectContaining({ artifactId: promoted.artifactId, scope: 'project' }),
  ]));
  expect(artifacts.list({ taskId: 't3' }).artifacts).toHaveLength(0);
});

test('retires an artifact without deleting its immutable content', async () => {
  const { workspace, artifacts } = await fixture();
  const source = join(workspace, 'report.md');
  await writeFile(source, 'review body');
  const published = await artifacts.publish({
    taskId: 't1', workspace, namespace: 'reviews', name: 'report', sourcePath: source,
    mediaType: 'text/markdown', producer: producer(), requestId: 'publish-report',
  });

  const retired = artifacts.retire('t1', published.artifactId, published.version, 'superseded', 'retire-report');
  expect(retired.state).toBe('retired');
  expect(artifacts.list({ taskId: 't1' }).artifacts).toHaveLength(0);
  expect(artifacts.list({ taskId: 't1', includeRetired: true }).artifacts).toMatchObject([{ state: 'retired' }]);
  expect((await artifacts.read('t1', published.artifactId, published.version)).text).toBe('review body');
});

test('a dependency reference is recorded so the artifact-to-reader edge is observable', async () => {
  const { store, workspace, artifacts } = await fixture();
  const source = join(workspace, 'report.md');
  await writeFile(source, 'review body');
  const published = await artifacts.publish({
    taskId: 't1', workspace, namespace: 'reviews', name: 'report', sourcePath: source,
    mediaType: 'text/markdown', producer: producer(), requestId: 'publish-reference',
  });

  // The briefing hands a dependency's artifact to a node without the node calling a tool, so the
  // reader is recorded here. Without this the only proof anybody read it is a reversed bash command.
  artifacts.recordReference({
    taskId: 't1', nodeId: 'review-b', artifactId: published.artifactId, version: published.version,
    relation: 'briefed',
  });
  const rows = store.db.prepare("SELECT type,data FROM artifact_events WHERE artifact_id=? AND version=? ORDER BY cursor")
    .all(published.artifactId, published.version) as { type: string; data: string }[];
  const referenced = rows.find(row => row.type === 'artifact.referenced');
  expect(referenced).toBeTruthy();
  expect(JSON.parse(referenced!.data)).toMatchObject({ nodeId: 'review-b', relation: 'briefed' });
});

test('a long-lived document keeps publishing past its hundredth version', async () => {
  // 实测碰到的：主 Agent 要长期维护的那份清单在第 100 版被旧上限判死（上限按版本号算，退役不释放）。
  // 这里钉的是外部行为——同一逻辑键能继续发到第 101 版，而不是去断言那个常量的数值。
  const { workspace, artifacts } = await fixture();
  const source = join(workspace, 'backlog.md');
  await writeFile(source, '# backlog\n');

  let head = 0;
  for (let version = 1; version <= 101; version += 1) {
    const published = await artifacts.publish({
      taskId: 't1', workspace, namespace: 'plans', name: 'backlog', sourcePath: source,
      // 每次发布都算一次「操作」，用新 id，否则先撞上「单次操作最多 32 条」。
      producer: producer(`op-backlog-${version}`), requestId: `publish-backlog-${version}`,
    });
    head = published.version;
  }

  expect(head).toBe(101);
});
