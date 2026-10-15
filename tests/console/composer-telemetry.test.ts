import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { conversationMasterUsage } from '../../src/core/conversation.ts';
import { TaskStore } from '../../src/core/store.ts';

// Defensive cross-instance reader contract. A genuine historical producer
// fixture is still unavailable; this is explicitly a lower-level retained test.
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-composer-telemetry-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

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
