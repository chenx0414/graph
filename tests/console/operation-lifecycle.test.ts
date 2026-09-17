import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  OperationLifecycle,
  operationSnapshots,
  type OperationIntent,
} from '../../src/core/operation-lifecycle.ts';
import { TaskStore, canonicalJson } from '../../src/core/store.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-operation-lifecycle-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t','p','lifecycle',1,'running')").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,instance_id,status,activation_id) VALUES('t','work',?,'i','pending','a')")
      .run(canonicalJson({ id: 'work', kind: 'agent', action: 'work' }));
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,definition_version,model) VALUES('i','t','work','coder@1','m')").run();
    store.db.prepare("INSERT INTO activations(id,task_id,node_id,graph_version,round,state,input_versions) VALUES('a','t','work',1,1,'pending','{}')").run();
  });
  const lifecycle = new OperationLifecycle(store, { advance: () => undefined });
  lifecycle.recover();
  return { store, lifecycle };
}

function intent(attempt: number): OperationIntent {
  return {
    taskId: 't',
    nodeId: 'work',
    instanceId: 'i',
    kind: 'agent',
    action: 'work',
    input: { attempt },
    dependencies: {},
    proposalVersion: 0,
    requirementVersion: 1,
    context: { previousOutput: null, answers: [] },
    grants: [],
    activationId: 'a',
    graphVersion: 1,
    dependencySources: {},
    inputVersions: {},
  };
}

test('intent recovery is conservative and attempt identity stays behind the lifecycle seam', async () => {
  const { store, lifecycle } = await fixture();
  const operation = lifecycle.admit({
    node: { id: 'work', taskId: 't', activationId: 'a' },
    reservation: 100,
    prepare: intent,
  });
  expect(operation.attempt).toBe(1);
  expect(operationSnapshots(store, 't')).toMatchObject([{ state: 'intent', reserved: 100 }]);

  const recovered = new OperationLifecycle(store, { advance: () => undefined });
  recovered.recover();
  expect(operationSnapshots(store, 't')).toMatchObject([{ state: 'not_sent', reserved: 0 }]);
  expect(store.db.prepare("SELECT status FROM nodes WHERE task_id='t' AND id='work'").get()).toEqual({ status: 'pending' });
});

test('dispatch, unknown usage, and a human answer compose in one lifecycle transaction', async () => {
  const { store, lifecycle } = await fixture();
  const operation = lifecycle.admit({
    node: { id: 'work', taskId: 't', activationId: 'a' },
    reservation: 100,
    prepare: intent,
  });
  lifecycle.dispatch(operation);
  lifecycle.report(operation.id, operation.generation, { outcome: 'continue', output: { draft: true } });

  expect(operationSnapshots(store, 't')).toMatchObject([{ state: 'unknown' }]);
  const question = store.db.prepare("SELECT id FROM questions WHERE operation_id=? AND kind='unknown_usage' AND status='open'")
    .get(operation.id) as { id: string };

  store.transaction(() => lifecycle.answer('t', question.id, {
    type: 'usage',
    usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 },
    proof: 'Provider receipt',
  }));
  expect(operationSnapshots(store, 't')).toMatchObject([{ state: 'succeeded', reserved: 0, workerActive: false }]);
  expect(store.db.prepare("SELECT used,models_used FROM instances WHERE id='i'").get()).toMatchObject({
    used: 50,
    models_used: '["m"]',
  });
});
