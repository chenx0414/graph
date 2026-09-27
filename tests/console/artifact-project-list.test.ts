import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, expect } from 'vitest';
import { ArtifactWorkspace } from '../../src/core/artifact-workspace.ts';
import { TaskStore } from '../../src/core/store.ts';

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-artifact-project-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const workspace = join(root, 'source');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'plan.md'), '# 只属于任务\n');
  await writeFile(join(workspace, 'backlog.md'), '# 项目自己的清单\n');
  const taskId = 'task-one';
  store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('project-one', root, '[]');
  store.db.prepare('INSERT INTO tasks(id,project_id,request,phase,created_seq) VALUES(?,?,?,?,?)')
    .run(taskId, 'project-one', '一个任务', 'running', 1);
  return { artifacts: new ArtifactWorkspace(store, join(root, 'artifact-workspace')), taskId, workspace };
}

test('a project lists its own shared artifacts, and a task still sees them too', async () => {
  const { artifacts, taskId, workspace } = await fixture();
  const producer = { nodeId: 'master', instanceId: 'instance', operationId: 'operation', activationId: 'activation' };
  const own = await artifacts.publish({
    taskId, workspace, namespace: 'plans', name: 'task-only', sourcePath: 'plan.md', title: '只属于任务', producer, requestId: 'publish-own',
  });
  const shared = await artifacts.publish({
    taskId, workspace, namespace: 'plans', name: 'backlog', sourcePath: 'backlog.md', title: '项目自己的清单', producer, requestId: 'publish-shared',
  });
  const promoted = await artifacts.promote({ taskId, artifactId: shared.artifactId, version: shared.version, promotedBy: 'user', requestId: 'promote' });

  // The project lists exactly what belongs to it - the promoted version, and nothing of the task's.
  const project = artifacts.listProject('project-one');
  expect(project.artifacts.map(item => item.name)).toEqual(['backlog']);
  expect(project.artifacts.every(item => item.scope === 'project')).toBe(true);
  expect(project.artifacts.some(item => item.artifactId === own.artifactId)).toBe(false);
  expect(artifacts.listProject('project-one', { prefix: 'backl' }).artifacts).toHaveLength(1);
  expect(artifacts.listProject('project-one', { prefix: 'nope' }).artifacts).toHaveLength(0);
  // Another project's listing is empty rather than everything.
  expect(artifacts.listProject('project-two').artifacts).toHaveLength(0);

  // Through a task in that project both the task's own artifact and the shared one are visible.
  const throughTask = artifacts.list({ taskId }).artifacts.map(item => `${item.name}@${item.scope}`);
  // Both copies of the promoted artifact are listed: the task's own version and the project's.
  expect(throughTask.sort()).toEqual(['backlog@project', 'backlog@task', 'task-only@task']);
  // Promotion mints a new artifact identity: the project's copy is its own artifact, so a version
  // number never has to be disambiguated between the two.
  expect(promoted.artifactId).not.toBe(shared.artifactId);
  expect(artifacts.get(taskId, promoted.artifactId, promoted.version).scope).toBe('project');
  expect(artifacts.get(taskId, promoted.artifactId, promoted.version).name).toBe('backlog');
  expect(artifacts.get(taskId, shared.artifactId, shared.version).scope).toBe('task');
});
