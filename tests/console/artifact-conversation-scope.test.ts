import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

/**
 * A main agent dispatches subagents into their own feature tasks, and those tasks publish the
 * artifacts they produce. Before this the main agent could not read them at all: visibility followed
 * the single task that published, so `artifact_list` on the main lane showed nothing of what its own
 * subagents had produced. The only way through was promotion, which is project-wide knowledge and
 * would leak one graph's working material into every later graph.
 *
 * So visibility follows the CONVERSATION: a task sees its own task-scope artifacts plus those of
 * every task in the same conversation, and nothing across conversations.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-artifact-conversation-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.db.exec(`
    INSERT INTO projects(id,root,grants) VALUES('p','${root}','[]');
    INSERT INTO projects(id,root,grants) VALUES('q','${root}','[]');
    INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
      VALUES('main','p','main lane',1,0,'chatting',0,1);
    INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
      VALUES('lane-a','p','first research lane',1,0,'running',0,2);
    INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
      VALUES('lane-b','p','second research lane',1,0,'running',0,3);
    INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
      VALUES('loner','p','a task with no conversation',1,0,'discussing',0,4);
    INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
      VALUES('other-conv','q','another conversation',1,0,'running',0,5);
    INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at)
      VALUES('c1','p','p','main','this conversation',10,10);
    INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at)
      VALUES('c2','q','q','other-conv','some other conversation',20,20);
    UPDATE tasks SET conversation_id='c1' WHERE id IN ('main','lane-a','lane-b');
    UPDATE tasks SET conversation_id='c2' WHERE id='other-conv';
  `);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  return { root, store, workspace, artifacts: new ArtifactWorkspace(store, join(root, 'artifacts')) };
}

function producer(operationId = 'op-1') {
  return { nodeId: 'research', instanceId: 'instance-1', operationId, activationId: 'activation-1', outputVersion: 1 };
}

test('a task reads the task-scope artifacts of every task in its own conversation, and nothing across conversations', async () => {
  const { store, workspace, artifacts } = await fixture();
  const source = join(workspace, 'auth.md');
  await writeFile(source, '# auth notes\n');

  const published = await artifacts.publish({
    taskId: 'lane-a', workspace, namespace: 'research', name: 'auth-notes', sourcePath: source,
    title: 'auth notes', producer: producer(), requestId: 'publish-1',
  });
  expect(published.scope).toBe('task');
  expect(published.ownerId).toBe('lane-a');

  // The lane that published it, as before.
  const own = await artifacts.list({ taskId: 'lane-a' });
  expect(own.artifacts.map(item => item.artifactId)).toContain(published.artifactId);

  // The main lane and a sibling lane of the same conversation: this is what was missing.
  for (const taskId of ['main', 'lane-b']) {
    const listed = await artifacts.list({ taskId });
    expect(listed.artifacts.map(item => item.artifactId), `${taskId} should see the lane artifact`).toContain(published.artifactId);
    const read = await artifacts.read(taskId, published.artifactId, published.version);
    expect(read.text, `${taskId} should be able to read it`).toContain('# auth notes');
  }

  // A task with no conversation keeps the old isolation: only what it published itself.
  const loner = await artifacts.list({ taskId: 'loner' });
  expect(loner.artifacts.map(item => item.artifactId)).not.toContain(published.artifactId);
  await expect(artifacts.read('loner', published.artifactId, published.version)).rejects.toThrow(/not found in this task workspace/i);

  // A different conversation is a different boundary.
  const other = await artifacts.list({ taskId: 'other-conv' });
  expect(other.artifacts.map(item => item.artifactId)).not.toContain(published.artifactId);
  await expect(artifacts.read('other-conv', published.artifactId, published.version)).rejects.toThrow(/not found in this task workspace/i);
}, 30_000);

test('promotion is still a separate, explicit act and still lands in project scope', async () => {
  const { workspace, artifacts } = await fixture();
  const source = join(workspace, 'surface.md');
  await writeFile(source, '# surface notes\n');

  const published = await artifacts.publish({
    taskId: 'lane-a', workspace, namespace: 'research', name: 'surface-notes', sourcePath: source,
    producer: producer('op-2'), requestId: 'publish-2',
  });
  // Reading a sibling lane's artifact does not make it project knowledge.
  const before = await artifacts.listProject('p');
  expect(before.artifacts.map(item => item.artifactId)).not.toContain(published.artifactId);

  const promoted = await artifacts.promote({ taskId: 'lane-a', artifactId: published.artifactId, version: published.version, requestId: 'promote-2', promotedBy: 'main@17' });
  expect(promoted.scope).toBe('project');
  const after = await artifacts.listProject('p');
  expect(after.artifacts.map(item => item.artifactId)).toContain(promoted.artifactId);
}, 30_000);
