// The end-to-end the user asked for, driven through the REAL lifecycle that a node failure goes
// through: a network blip must retry itself and wake nobody, a real compile error must reach main.
//
// Evidence for why this is the shape: in the real state ledger `execution_failed` was answered 105
// times and every answer was `retry`; about 101 were a network/limit/5xx blip or a PATH problem.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { OperationLifecycle, type OperationIntent } from '../../src/core/operation-lifecycle.ts';
import { TaskStore, canonicalJson } from '../../src/core/store.ts';
import { fullAccessPolicy, resolveAccessPolicy } from '../../src/core/access-policy.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-transient-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t','p','transient',1,'running')").run();
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
    taskId: 't', nodeId: 'work', instanceId: 'i', kind: 'agent', action: 'work',
    input: { attempt }, dependencies: {}, proposalVersion: 0, requirementVersion: 1,
    accessPolicy: resolveAccessPolicy(fullAccessPolicy()),
    context: { previousOutput: null, answers: [] }, grants: [], activationId: 'a', graphVersion: 1,
    dependencySources: {}, inputVersions: {},
  };
}

/** Fail the node once, exactly the way the runtime reports a failed turn. */
function failOnce(lifecycle: OperationLifecycle, output: unknown) {
  const operation = lifecycle.admit({
    node: { id: 'work', taskId: 't', activationId: 'a' }, reservation: 0, prepare: intent,
  });
  lifecycle.dispatch(operation);
  lifecycle.report(operation.id, operation.generation, { outcome: 'failed', output: output as never });
  return operation;
}

function state(store: TaskStore) {
  const node = store.db.prepare("SELECT status,stall_count FROM nodes WHERE task_id='t' AND id='work'")
    .get() as { status: string; stall_count: number };
  const open = store.db.prepare("SELECT kind,data FROM questions WHERE task_id='t' AND status='open'").all() as { kind: string; data: string }[];
  const retries = store.db.prepare("SELECT data FROM events WHERE task_id='t' AND type='node.transient_retry'").all() as { data: string }[];
  return { node, open, retries: retries.map(row => JSON.parse(row.data) as { attempt: number; reason: string }) };
}

test('a network blip retries itself: node goes back to pending, nobody is woken', async () => {
  const { store, lifecycle } = await fixture();
  failOnce(lifecycle, { error: 'Connection error.' });
  const after = state(store);
  // Back to pending is what lets the scheduler dispatch it again with no main turn in between.
  expect(after.node).toMatchObject({ status: 'pending', stall_count: 1 });
  // Nobody was woken: no open problem for main.
  expect(after.open).toEqual([]);
  // And it is a recorded fact, not a silent loop.
  expect(after.retries).toHaveLength(1);
  expect(after.retries[0]).toMatchObject({ attempt: 1 });
});

test('a real compile error wakes main on the first failure, with the verdict recorded', async () => {
  const { store, lifecycle } = await fixture();
  failOnce(lifecycle, { stderr: "src/a.ts(3,5): error TS2304: Cannot find name 'foo'." });
  const after = state(store);
  expect(after.node.status).toBe('blocked');
  expect(after.retries).toEqual([]);
  expect(after.open.map(question => question.kind)).toContain('execution_failed');
  // The problem says WHY it was not retried, so main is not handed a bare failure.
  expect(JSON.parse(after.open[0]!.data)).toMatchObject({ retryVerdict: expect.stringContaining('判断') });
});

test('the bound holds: the third blip wakes main and says the retries ran out', async () => {
  const { store, lifecycle } = await fixture();
  failOnce(lifecycle, { error: 'Connection error.' });
  failOnce(lifecycle, { error: 'Connection error.' });
  expect(state(store).node.status).toBe('pending');
  failOnce(lifecycle, { error: 'Connection error.' });
  const after = state(store);
  expect(after.node.status).toBe('blocked');
  expect(after.retries).toHaveLength(2);
  expect(after.open.map(question => question.kind)).toContain('execution_failed');
  const data = JSON.parse(after.open[0]!.data) as { transientRetriesExhausted?: number; retryVerdict: string };
  expect(data.transientRetriesExhausted).toBe(2);
  expect(data.retryVerdict).toContain('重试');
});

test('a failure with no error text is not treated as a blip: main gets it immediately', async () => {
  const { store, lifecycle } = await fixture();
  // `null` is how a turn that reported nothing at all arrives; an empty object would stringify to
  // '{}', which is text and would be judged a verdict instead of silence.
  failOnce(lifecycle, null);
  const after = state(store);
  expect(after.node.status).toBe('blocked');
  expect(after.retries).toEqual([]);
  expect(JSON.parse(after.open[0]!.data).retryVerdict).toContain('没有输出');
});
