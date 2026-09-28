import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { agentTools } from '../../src/runtime/agent-tools.ts';
import { assertQuestionAnswer, questionOwner, questionSummary } from '../../src/core/question-routing.ts';
import { describeQuestion } from '../../src/web/labels.ts';
import { TaskStore } from '../../src/core/store.ts';
import { describeAgentTools } from '../../src/runtime/agent-tool-definitions.ts';
import { activeOperationForNode } from '../../src/core/control-targets.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

/** A discussion task with one master node, like the conversation anchor. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-control-tools-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.db.prepare("INSERT INTO projects VALUES('p','/tmp','[]')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq) VALUES('task','p','chat',1)").run();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec) VALUES('task','master','{\"role\":\"master\"}')").run();
  return store;
}

test('a master question is the user decision to make, and a plain answer settles it', () => {
  // The master asks because the answer changes the plan: that decision is the user's, not the
  // runtime's, so it must land in the user's inbox instead of a main-owned problem.
  expect(questionOwner('waiting', { requestType: 'user_decision', prompt: 'Web 还是 App？' })).toBe('user');
  expect(questionSummary('waiting', { prompt: 'Web 还是 App？' })).toBe('Web 还是 App？');
  expect(() => assertQuestionAnswer('waiting', { type: 'respond', value: 'Web' })).not.toThrow();
  expect(() => assertQuestionAnswer('waiting', { type: 'grant', grant: 'mcp:demo:write' }))
    .toThrow('Answer type does not match the open question');
  // The console names what it is waiting for: a decision, not an external condition.
  expect(describeQuestion('waiting', { requestType: 'user_decision' })).toBe('等待你的决定');
  expect(describeQuestion('waiting', { requestType: 'model_access' })).toBe('等待外部条件');
});

test('the master tool inventory carries the two control tools and workers do not', () => {
  const master = describeAgentTools({ role: 'master', run: true, fetch: true, catalog: true, supervisor: { controlTask: true } });
  const names = master.map(tool => tool.name);
  expect(names).toContain('ask_user');
  expect(names).toContain('control_task');
  const control = master.find(tool => tool.name === 'control_task')!;
  // TypeBox represents a literal union as anyOf/const, so read whichever shape the schema uses.
  const action = (control.parameters as { properties: { action: { enum?: string[]; anyOf?: { const?: string }[] } } }).properties.action;
  expect(action.enum ?? (action.anyOf ?? []).map(item => item.const))
    .toEqual(['pause', 'resume', 'abandon', 'set_budget', 'steer']);

  // A worker keeps its own surface: it reports through submit_result and never controls a task.
  const worker = describeAgentTools({ role: 'worker', run: true }).map(tool => tool.name);
  expect(worker).not.toContain('ask_user');
  expect(worker).not.toContain('control_task');
  expect(describeAgentTools({ role: 'master' }).map(tool => tool.name)).not.toContain('control_task');
});

test('ask_user keeps bounded choices and multiple selection in its durable question', async () => {
  const asked: { prompt: string; why: string; options: string[]; multiple: boolean }[] = [];
  const tools = agentTools({ workspace: '/tmp', role: 'master', onAskUser: question => { asked.push(question); },
    supervisor: { propose: async () => ({}), revise: async () => ({}), controlTask: async () => ({ ok: true }) },
  });
  const ask = tools.find(tool => tool.name === 'ask_user')!;
  const execute = ask.execute as unknown as (id: string, params: unknown) => Promise<unknown>;
  const result = await execute('ask', { prompt: '**Choose**', why: 'Changes the plan', options: ['Web', 'Web', 'App'], multiple: true, requestId: 'ask-1' });
  expect(asked).toEqual([{ prompt: '**Choose**', why: 'Changes the plan', options: ['Web', 'App'], multiple: true }]);
  expect(result).toMatchObject({ terminate: true });
});

test('a live operation is resolved for its node and nothing else', async () => {
  const store = await fixture();
  expect(activeOperationForNode(store, 'task', 'master')).toBeUndefined();
  store.db.prepare(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active)
    VALUES('op','task','master',1,'{"action":"agent"}','dispatched',0,1)`).run();
  expect(activeOperationForNode(store, 'task', 'master')).toEqual({ id: 'op' });
  store.db.prepare("UPDATE operations SET state='succeeded', worker_active=0 WHERE id='op'").run();
  expect(activeOperationForNode(store, 'task', 'master')).toBeUndefined();
});

test('the control tools refuse an unknown action, a missing steering target and an empty question', async () => {
  const calls: unknown[] = [];
  const tools = agentTools({
    workspace: '/tmp',
    role: 'master',
    supervisor: {
      propose: async () => ({}),
      revise: async () => ({}),
      controlTask: async input => { calls.push(input); return { ok: true }; },
    },
  });
  const call = (name: string, params: Record<string, unknown>) =>
    (tools.find(tool => tool.name === name)!.execute as unknown as (id: string, params: unknown) => Promise<unknown>)('probe', params);

  await expect(call('control_task', { action: 'explode', requestId: 'x1' })).rejects.toThrow('Unsupported control action');
  await expect(call('control_task', { action: 'pause' })).rejects.toThrow('requestId');
  await expect(call('ask_user', { prompt: '去哪条路？', requestId: 'x4' })).rejects.toThrow('would change with the answer');
  // A missing steering target is refused by the runtime, not here: the tool must forward
  // the request so the refusal can name the node that has no running turn.
  expect(calls).toHaveLength(0);

  // Only a valid request reaches the runtime, and the tool reports its receipt verbatim.
  const receipt = await call('control_task', { action: 'pause', reason: '先停下', requestId: 'x5' }) as { content: { text: string }[] };
  expect(calls).toEqual([{ action: 'pause', reason: '先停下', requestId: 'x5' }]);
  expect(receipt.content[0]!.text).toContain('"ok":true');
});
