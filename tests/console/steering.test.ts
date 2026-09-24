import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Execution } from '../../src/core/execution.ts';
import { TaskStore } from '../../src/core/store.ts';
import type { ActionAdapter } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-steering-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.db.prepare("INSERT INTO projects VALUES('p','/tmp','[]')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq) VALUES('task','p','chat',1)").run();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec) VALUES('task','master','{\"role\":\"master\"}')").run();
  return store;
}

/**
 * One live Agent turn. It has to be written after the runtime opens: opening a
 * runtime recovers operations that were in flight when the process started, so a
 * row seeded before that is deliberately turned into `unknown`.
 */
function liveTurn(store: TaskStore) {
  store.db.prepare(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active)
    VALUES('op','task','master',1,'{"action":"agent"}','dispatched',0,1)`).run();
}

function agentAdapter(overrides: Partial<ActionAdapter> = {}) {
  return {
    kind: 'agent',
    reserveTokens: 100,
    prepare: async () => async () => ({ outcome: 'completed', output: { text: 'done' } }),
    ...overrides,
  } as unknown as ActionAdapter;
}

test('steering reaches the fallback adapter that serves the built-in Agent action', async () => {
  const store = await fixture();
  const steered: string[] = [];
  const fallback = agentAdapter({ steer: async (_operation, text) => { steered.push(text); } });

  // The real runtime registers only the program actions in `actions`; every Agent
  // operation is served by the fallback adapter. Steering therefore has to resolve
  // exactly like dispatch does, otherwise a queued message can never interrupt a
  // running turn and the console reports that the Agent cannot be steered.
  const execution = new Execution(store, {}, { fallback });
  liveTurn(store);
  await execution.steer('op', '先看测试覆盖。');
  expect(steered).toEqual(['先看测试覆盖。']);
});

test('an action that is registered keeps precedence over the fallback', async () => {
  const store = await fixture();
  const steered: string[] = [];
  const execution = new Execution(store, {
    agent: agentAdapter({ steer: async (_operation, text) => { steered.push(`action:${text}`); } }),
  }, {
    fallback: agentAdapter({ steer: async (_operation, text) => { steered.push(`fallback:${text}`); } }),
  });
  liveTurn(store);
  await execution.steer('op', '插队');
  expect(steered).toEqual(['action:插队']);
});

test('steering without any capable adapter still fails loudly', async () => {
  const store = await fixture();
  const execution = new Execution(store, {}, { fallback: agentAdapter() });
  liveTurn(store);
  await expect(execution.steer('op', '插队')).rejects.toThrow('does not support steering');
});
