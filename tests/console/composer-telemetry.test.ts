import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { conversationMasterUsage } from '../../src/core/conversation.ts';
import { TaskStore } from '../../src/core/store.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-composer-telemetry-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A minimal conversation ledger with one master node, so the usage rebuild can
 * be exercised directly on realistic invocation rows. */
function seedConversation(root: string, conversationId: string, taskId: string) {
  const store = new TaskStore(join(root, `${conversationId}.sqlite`));
  cleanup.push(async () => store.close());
  store.db.prepare("INSERT INTO projects VALUES('p','/tmp','[]')").run();
  store.db.prepare('INSERT INTO tasks(id,project_id,request,created_seq,conversation_id) VALUES(?,?,?,1,?)').run(taskId, 'p', 'chat', conversationId);
  store.db.prepare("INSERT INTO nodes(task_id,id,spec) VALUES(?,?,?)").run(taskId, 'master', '{"role":"master"}');
  store.db.prepare('INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES(?,?,?,?,1,1)').run(conversationId, 'p', taskId, 'chat');
  const operationId = `op-${conversationId}`;
  store.db.prepare("INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active) VALUES(?,?,?,1,'{}','succeeded',0,0)").run(operationId, taskId, 'master');
  return {
    store,
    addInvocation(id: string, instanceId: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null) {
      store.db.prepare('INSERT INTO invocations(id,operation_id,instance_id,model,purpose,usage,cost) VALUES(?,?,?,?,?,?,NULL)')
        .run(id, operationId, instanceId, 'm', 'completion', usage === null ? null : JSON.stringify(usage));
    },
  };
}

test('after a reload the context and cache numbers are rebuilt from persisted master invocations', async () => {
  const root = await temp('reload');
  const provider = await openaiServer([{ text: '好的。', usage: { prompt_tokens: 20, completion_tokens: 1 } }]);
  cleanup.push(() => provider.close());
  const options = {
    stateDir: join(root, 'state'),
    models: {
      entries: [{
        id: 'm', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const,
        baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, reasoning: false,
      }],
      apiKey: 'telemetry-local-key',
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  };
  const first = await openTaskRuntime(options);
  const created = await first.conversations.create({ text: '帮我看下这个项目。', requestId: 'telemetry-create' });
  await first.host.runReady();
  expect(provider.requests).toHaveLength(1);
  await first.close();

  // Reopen the ledger on its own and record the master turns the way Pi's SDK
  // usage recorder does. The master instance id is then moved, so a reload must
  // not depend on it any more.
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
  const instance = db.prepare("SELECT instance_id FROM nodes WHERE id='master'").get() as { instance_id: string };
  const operation = db.prepare("SELECT id FROM operations WHERE node_id='master' ORDER BY rowid").get() as { id: string };
  db.prepare("UPDATE nodes SET instance_id='reloaded-instance' WHERE id='master'").run();
  const insert = db.prepare('INSERT INTO invocations(id,operation_id,instance_id,model,purpose,usage,cost) VALUES(?,?,?,?,?,?,?)');
  insert.run('invocation-1', operation.id, instance.instance_id, 'm', 'completion', JSON.stringify({ input: 20, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
  insert.run('invocation-2', operation.id, instance.instance_id, 'm', 'completion', JSON.stringify({ input: 100, output: 5, cacheRead: 300, cacheWrite: 0 }), null);
  // Real ledgers end on a blank completion that never ran: it must not reset
  // the numbers the user already saw.
  insert.run('invocation-3', operation.id, instance.instance_id, 'm', 'completion', JSON.stringify({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), null);
  db.close();

  const second = await openTaskRuntime(options);
  cleanup.push(() => second.close());
  const view = await second.conversations.view(created.conversationId);
  expect(view.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
  expect(view.telemetry?.contextTokens).toBe(400);
  expect(view.telemetry?.cachedInput).toBe(300);
  expect(view.telemetry?.cacheInput).toBe(440);
  expect(view.telemetry?.cacheHitRate).toBeCloseTo(300 / 440, 6);
  expect(view.telemetry?.contextLimit).toBe(32_000);
  expect(provider.requests).toHaveLength(1);
});

test('only the master node of a conversation counts toward its context usage', async () => {
  const root = await temp('scope');
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.db.prepare("INSERT INTO projects VALUES('p','/tmp','[]')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,conversation_id) VALUES('anchor','p','chat',1,'conversation')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,conversation_id) VALUES('feature','p','work',2,'conversation')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq) VALUES('other','p','other',3)").run();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec) VALUES('anchor','master','{\"role\":\"master\"}')").run();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec) VALUES('feature','work','{\"role\":\"worker\"}')").run();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec) VALUES('other','master','{\"role\":\"master\"}')").run();
  store.db.prepare("INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES('conversation','p','anchor','chat',1,1)").run();
  const operation = 'INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active) VALUES(?,?,?,1,\'{}\',\'succeeded\',0,0)';
  store.db.prepare(operation).run('op-master', 'anchor', 'master');
  store.db.prepare(operation).run('op-worker', 'feature', 'work');
  store.db.prepare(operation).run('op-other', 'other', 'master');
  const invocation = 'INSERT INTO invocations(id,operation_id,instance_id,model,purpose,usage,cost) VALUES(?,?,?,?,?,?,NULL)';
  store.db.prepare(invocation).run('i-master', 'op-master', 'inst', 'm', 'completion', JSON.stringify({ input: 10, output: 1, cacheRead: 90, cacheWrite: 0 }));
  store.db.prepare(invocation).run('i-worker', 'op-worker', 'inst-w', 'm', 'completion', JSON.stringify({ input: 1000, output: 1, cacheRead: 0, cacheWrite: 0 }));
  store.db.prepare(invocation).run('i-other', 'op-other', 'inst-o', 'm', 'completion', JSON.stringify({ input: 500, output: 1, cacheRead: 0, cacheWrite: 0 }));
  expect(conversationMasterUsage(store, 'conversation')).toEqual({ cachedInput: 90, cacheInput: 100, contextTokens: 100 });
});

test('a trailing all-zero or usage-less completion never erases the last real context size', async () => {
  const root = await temp('blank-tail');
  const { addInvocation, store } = seedConversation(root, 'conversation', 'anchor');
  addInvocation('real', 'instance-old', { input: 436, output: 3, cacheRead: 451200, cacheWrite: 0 });
  addInvocation('unsettled', 'instance-old', null);
  addInvocation('blank-turn', 'instance-new', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  addInvocation('blank-unsettled', 'instance-new', null);
  // The only real completion sits on a since-replaced instance, so the rebuild
  // must find it across instances rather than fall back to 0/null.
  expect(conversationMasterUsage(store, 'conversation')).toEqual({
    cachedInput: 451200,
    cacheInput: 451636,
    contextTokens: 451636,
  });
});

test('the newest real completion wins across instances and a conversation without one stays null', async () => {
  const root = await temp('latest');
  const older = seedConversation(root, 'conversation-past', 'anchor-past');
  older.addInvocation('old-real', 'instance-old', { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 });
  older.addInvocation('new-real', 'instance-new', { input: 200, output: 1, cacheRead: 0, cacheWrite: 0 });
  expect(conversationMasterUsage(older.store, 'conversation-past').contextTokens).toBe(200);

  const blank = seedConversation(root, 'conversation-blank', 'anchor-blank');
  blank.addInvocation('blank-turn', 'instance-old', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  blank.addInvocation('unsettled', 'instance-new', null);
  expect(conversationMasterUsage(blank.store, 'conversation-blank').contextTokens).toBeNull();
});
