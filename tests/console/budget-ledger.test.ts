import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  addBudget,
  assertWithinBudget,
  budgetScopeView,
  budgetSnapshot,
  commitUsage,
  ensureBudgetScope,
  modelsUsed,
  recordModelUse,
  releaseOperationReservation,
  reserveOperation,
  setBudget,
  shareBudgetScope,
} from '../../src/core/budget-ledger.ts';
import { TaskStore } from '../../src/core/store.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-budget-ledger-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t','p','budget',1)").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,instance_id) VALUES('t','source','{}','i-source')").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,instance_id) VALUES('t','fork','{}','i-fork')").run();
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,budget,used,unlimited,model) VALUES('i-source','t','source',100,0,0,'m1')").run();
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,budget,used,unlimited,model,parent_instance_id) VALUES('i-fork','t','fork',100,0,0,'m1','i-source')").run();
    store.db.prepare("INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,activation_id) VALUES('op','t','source','i-source',0,'{}','intent',0,'a')").run();
  });
  return store;
}

test('one scope owns reservation, commit and shared cap changes', async () => {
  const store = await fixture();
  const scopeId = ensureBudgetScope(store, 't', 'i-source');
  expect(ensureBudgetScope(store, 't', 'i-source')).toBe(scopeId);
  shareBudgetScope(store, 'i-fork', scopeId);
  expect(budgetScopeView(store, scopeId)).toMatchObject({
    id: scopeId,
    ownerInstanceId: 'i-source',
    members: 2,
    used: 0,
    limit: 100,
    unlimited: false,
  });

  reserveOperation(store, 'op', 40);
  expect(budgetSnapshot(store, 'i-source')).toMatchObject({ reserved: 40, scopeUsed: 0 });
  expect(() => assertWithinBudget(store, 'i-fork', 61)).toThrow(/Shared context budget/);
  expect(() => assertWithinBudget(store, 'i-fork', 60)).not.toThrow();

  releaseOperationReservation(store, 'op');
  commitUsage(store, 'i-source', 60);
  expect(budgetScopeView(store, scopeId)).toMatchObject({ used: 60 });
  expect(() => assertWithinBudget(store, 'i-fork', 41)).toThrow(/Shared context budget/);
  expect(() => assertWithinBudget(store, 'i-fork', 40)).not.toThrow();
  expect(() => setBudget(store, 'i-fork', 200)).toThrow(/shared budget owner/);
  addBudget(store, 'i-fork', 50);
  expect(store.db.prepare("SELECT id,budget FROM instances WHERE id IN ('i-source','i-fork') ORDER BY id").all())
    .toEqual([
      { id: 'i-fork', budget: 150 },
      { id: 'i-source', budget: 150 },
    ]);
  expect(() => assertWithinBudget(store, 'i-source', 90)).not.toThrow();
  expect(() => assertWithinBudget(store, 'i-source', 91)).toThrow(/Shared context budget/);
});

test('unlimited and model history remain explicit ledger facts', async () => {
  const store = await fixture();
  const scopeId = ensureBudgetScope(store, 't', 'i-source');
  recordModelUse(store, 'i-source', 'm1');
  recordModelUse(store, 'i-source', 'm2');
  recordModelUse(store, 'i-source', 'm2');
  expect(modelsUsed(store, 'i-source')).toEqual(['m1', 'm2']);

  commitUsage(store, 'i-source', 0);
  expect(budgetSnapshot(store, 'i-source')).toMatchObject({ used: 0, scopeUsed: 0 });
  setBudget(store, 'i-source', null);
  expect(budgetSnapshot(store, 'i-source')).toMatchObject({ unlimited: true, scopeUnlimited: true });
  expect(budgetScopeView(store, scopeId)).toMatchObject({ limit: null, unlimited: true });
  expect(() => assertWithinBudget(store, 'i-source', 1_000_000)).not.toThrow();
});

test('in-flight invocation usage is counted before settlement without becoming committed usage', async () => {
  const store = await fixture();
  const scopeId = ensureBudgetScope(store, 't', 'i-source');
  reserveOperation(store, 'op', 50);
  store.transaction(() => {
    store.db.prepare("UPDATE operations SET state='dispatched',worker_active=1 WHERE id='op'").run();
    store.db.prepare("INSERT INTO invocations(id,operation_id,instance_id,model,usage) VALUES('inv','op','i-source','m1',?)")
      .run(JSON.stringify({ input: 30, output: 0, cacheRead: 0, cacheWrite: 0 }));
  });
  expect(budgetScopeView(store, scopeId)).toMatchObject({ used: 0 });
  expect(() => assertWithinBudget(store, 'i-source', 20)).not.toThrow();
  expect(() => assertWithinBudget(store, 'i-source', 21)).toThrow(/Shared context budget/);

  releaseOperationReservation(store, 'op');
  commitUsage(store, 'i-source', 30);
  expect(budgetScopeView(store, scopeId)).toMatchObject({ used: 30 });
});
