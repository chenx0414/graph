import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-control-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A real conversation whose master runs through the real Pi adapter and tool surface. */
async function conversation(name: string, plans: ResponsePlan[]) {
  const root = await temp(name);
  const provider = await openaiServer(plans);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    catalog: { capabilityRoot: join(root, 'graph', 'capabilities'), recipesPath: join(root, 'graph', 'agent-combinations.json') },
    models: {
      entries: [{ id: 'local', provider: 'local', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'c' }],
      apiKey: 'local-key', modelRuntime: provider.runtime,
      credentialFor: () => ({ credentialId: 'c', apiKey: 'local-key' }),
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  const created = await runtime.conversations.create({ text: '帮我改造这个项目', requestId: `create-${name}` });
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(() => db.close());
  const anchorTaskId = (db.prepare('SELECT anchor_task_id AS id FROM conversations WHERE id=?').get(created.conversationId) as { id: string }).id;
  const masterStatus = () => (db.prepare("SELECT status FROM nodes WHERE task_id=? AND json_extract(spec,'$.role')='master'").get(anchorTaskId) as { status: string }).status;
  return { root, provider, runtime, db, conversationId: created.conversationId, anchorTaskId, masterStatus };
}

test('the master asks the user and the answer reaches its next turn', async () => {
  const { provider, runtime, db, conversationId, anchorTaskId, masterStatus } = await conversation('ask-user', [
    {
      finishReason: 'tool_calls',
      tools: [{
        id: 'ask-1', name: 'ask_user',
        arguments: JSON.stringify({ prompt: '这个项目要做成 Web 还是桌面 App？', why: '两条路线的车道完全不同，无法先开工再改', requestId: 'ask-1' }),
      }],
    },
    { text: '收到，我按你的选择继续。' },
  ]);
  await runtime.host.runReady();

  // The question is durable, owned by the user, and the turn stopped there: asking does not keep
  // spending model requests while it waits.
  const question = db.prepare("SELECT id,kind,owner,status,data FROM questions WHERE status='open'").get() as
    { id: string; kind: string; owner: string; status: string; data: string } | undefined;
  expect(question).toBeTruthy();
  expect(question!.kind).toBe('waiting');
  expect(question!.owner).toBe('user');
  expect(JSON.parse(question!.data)).toMatchObject({ requestType: 'user_decision' });
  expect(String(JSON.parse(question!.data).prompt)).toContain('Web 还是桌面 App');
  expect(masterStatus()).toBe('waiting');
  expect(provider.requests).toHaveLength(1);

  await runtime.user.task(anchorTaskId).answer(question!.id, { type: 'respond', value: '做成 Web' }, 'answer-1');
  expect(db.prepare('SELECT status FROM questions WHERE id=?').get(question!.id)).toEqual({ status: 'resolved' });
  await runtime.host.runReady();

  // The answer is part of the next attempt's context, not something the master has to ask for again.
  expect(provider.requests).toHaveLength(2);
  expect(JSON.stringify(provider.requests[1])).toContain('做成 Web');
  const view = await runtime.conversations.view(conversationId);
  expect(view.messages.some(message => message.text.includes('我按你的选择继续'))).toBe(true);
}, 60_000);

test('the master pauses its own turn, then sets a budget and abandons the task it is serving', async () => {
  const { provider, runtime, db, anchorTaskId } = await conversation('control-task', [
    {
      finishReason: 'tool_calls',
      tools: [{
        id: 'k1', name: 'control_task',
        arguments: JSON.stringify({ action: 'pause', reason: '先停下来核对范围', requestId: 'k1' }),
      }],
    },
    {
      finishReason: 'tool_calls',
      tools: [
        { id: 'k2', name: 'control_task', arguments: JSON.stringify({ action: 'set_budget', nodeId: 'master', tokens: null, requestId: 'k2' }) },
        { id: 'k3', name: 'control_task', arguments: JSON.stringify({ action: 'abandon', reason: '使用者已不需要这条任务', requestId: 'k3' }) },
      ],
    },
  ]);
  await runtime.host.runReady();

  // The pause is a real state boundary and it soft-stops the running turn.
  expect(db.prepare('SELECT paused FROM tasks WHERE id=?').get(anchorTaskId)).toEqual({ paused: 1 });
  expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE task_id=? AND type='task.pause_requested'").get(anchorTaskId)).toEqual({ count: 1 });
  expect(provider.requests).toHaveLength(1);
  // The durable wake-up the pause records is what lets an explicit resume continue this turn
  // instead of waiting for a brand new user message.
  expect(db.prepare('SELECT state FROM pause_continuations WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(anchorTaskId)).toEqual({ state: 'waiting' });

  // Only the user resumes a paused task, exactly like the pause button in the console.
  await runtime.user.task(anchorTaskId).resume('resume-1');
  expect(db.prepare('SELECT paused FROM tasks WHERE id=?').get(anchorTaskId)).toEqual({ paused: 0 });
  await runtime.host.runReady();

  // The resumed turn carries the budget change and stops the whole task immediately with the
  // master's own reason recorded. (A refused steering target is covered by its own test below:
  // a failed call inside a batch would make this ordering assertion ambiguous.)
  expect(provider.requests).toHaveLength(2);
  // An unlimited node is the shape a master normally runs with: a finite cap has to cover the
  // context reservation, so a small one starves the very turn that set it.
  expect(db.prepare("SELECT budget, unlimited FROM instances WHERE task_id=? AND node_id='master'").get(anchorTaskId)).toEqual({ budget: 0, unlimited: 1 });
  expect(db.prepare('SELECT phase FROM tasks WHERE id=?').get(anchorTaskId)).toEqual({ phase: 'abandoned' });
  const abandoned = db.prepare("SELECT data FROM events WHERE task_id=? AND type='task.abandoned' ORDER BY cursor DESC LIMIT 1").get(anchorTaskId) as { data: string } | undefined;
  expect(abandoned).toBeTruthy();
  expect(JSON.parse(abandoned!.data).reason).toBe('使用者已不需要这条任务');
}, 60_000);

test('steering an idle node is refused instead of queueing text nobody will read', async () => {
  const { runtime, db, anchorTaskId } = await conversation('steer-idle', [
    {
      finishReason: 'tool_calls',
      tools: [{
        id: 's1', name: 'control_task',
        arguments: JSON.stringify({ action: 'steer', nodeId: 'no-such-node', text: '插一句话', requestId: 's1' }),
      }],
    },
  ]);
  await runtime.host.runReady();

  // The refusal is real: nothing was steered and the task is exactly where it was.
  expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='operation.steered'").get()).toEqual({ count: 0 });
  expect(db.prepare('SELECT phase, paused FROM tasks WHERE id=?').get(anchorTaskId)).toEqual({ phase: 'chatting', paused: 0 });
}, 60_000);
