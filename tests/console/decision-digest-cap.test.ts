import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import type { ActionAdapter, OperationResult } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

function scripted(handler: () => OperationResult): ActionAdapter {
  return { kind: 'agent', reserveTokens: 100, prepare: async () => async () => handler() };
}

/**
 * The compatibility fallback freezes the conversation's consumed user messages when the master
 * declares no decisions. That is deliberate -- it is how a constraint the user states in chat reaches
 * the node doing the work -- but it had no bound at all, so one real task carried 636 entries of its
 * whole chat history into every node's briefing.
 *
 * The bound keeps BOTH ends: the opening (the original request and the constraints stated with it)
 * and the recent end (what the conversation is about now). Dropping the oldest instead would defeat
 * the feature, because that is exactly where the constraints are.
 */
test('the fallback drops what states nothing and keeps a short constraint', async () => {
  // A chat is full of lines that state no decision - a slash command, `继续`, `ok` - and they cost
  // window space in every node's briefing while reading like a constraint to a model looking for one.
  // The filter cannot be a length rule: "别动 login" is shorter than "好的，继续吧" and is exactly the
  // kind of thing this fallback exists to carry.
  const root = await mkdtemp(join(tmpdir(), 'decision-digest-noise-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const runtime = await openTaskRuntime({
    stateDir,
    projects: [{ id: 'p', root }],
    actions: { master: scripted(() => ({ outcome: 'completed', output: { text: 'ok' }, usage })) },
    models: {
      entries: [{ id: 'local', provider: 'synthetic', grade: 'medium' as const, api: 'openai-completions' as const, baseUrl: 'http://127.0.0.1:1', contextWindow: 32_000, maxTokens: 256, reasoning: false }],
      apiKey: 'k', modelRuntime: {} as never,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  const created = await runtime.conversations.create({ projectId: 'p', text: '第一次提问', requestId: 'create' });

  const seed = new TaskStore(join(stateDir, 'tasks.sqlite'));
  const messages = ['/agent-browser 帮我打开页面', '继续', 'ok', '别动 login 那段', '把设置页拆成两步，第一步只填厂商'];
  messages.forEach((text, index) => {
    seed.db.prepare(
      "INSERT INTO messages(id,conversation_id,role,kind,text,state,turn,created_at,updated_at) VALUES(?,?,'user','chat',?,'delivered',0,?,?)",
    ).run(`n${index}`, created.conversationId, text, index, index);
  });
  seed.close();

  await runtime.supervisor(created.taskId).propose({
    requirementVersion: 1,
    summary: '无声明决策',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'master', kind: 'agent', role: 'master', action: 'master', definitionVersion: 'master@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['master'], input: { command: 'node', args: ['--version'] } },
    ],
  }, 'draft');

  const read = new TaskStore(join(stateDir, 'tasks.sqlite'));
  const row = read.db.prepare('SELECT decision_snapshot FROM proposals WHERE task_id=? AND version=1').get(created.taskId) as { decision_snapshot: string | null };
  read.close();
  const snapshot = row.decision_snapshot ?? '';
  expect(snapshot).toContain('别动 login');
  expect(snapshot).toContain('把设置页拆成两步');
  expect(snapshot).not.toContain('/agent-browser');
  expect(snapshot.split('\n').some(line => line.endsWith('继续'))).toBe(false);
  expect(snapshot.split('\n').some(line => line.endsWith('ok'))).toBe(false);
}, 60_000);

test('the fallback decision snapshot is bounded at both ends, not just the recent one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'decision-digest-cap-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');

  const runtime = await openTaskRuntime({
    stateDir,
    projects: [{ id: 'p', root }],
    actions: { master: scripted(() => ({ outcome: 'completed', output: { text: 'ok' }, usage })) },
    models: {
      entries: [{ id: 'local', provider: 'synthetic', grade: 'medium' as const, api: 'openai-completions' as const, baseUrl: 'http://127.0.0.1:1', contextWindow: 32_000, maxTokens: 256, reasoning: false }],
      apiKey: 'k', modelRuntime: {} as never,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');

  const created = await runtime.conversations.create({ projectId: 'p', text: '第一次提问', requestId: 'create' });

  // Seed a long conversation, which is exactly what the fallback consumes. `binding_since_seq` stays
  // at its 0 default, so the whole conversation is in scope.
  const seed = new TaskStore(join(stateDir, 'tasks.sqlite'));
  for (let index = 0; index < 80; index += 1) {
    seed.db.prepare(
      "INSERT INTO messages(id,conversation_id,role,kind,text,state,turn,created_at,updated_at) VALUES(?,?,'user','chat',?,'delivered',0,?,?)",
    ).run(`m${index}`, created.conversationId, `这是第 ${index} 条提问，内容够长以便累计到字符预算。`, index, index);
  }
  seed.close();

  // No `decisions` on the proposal: this is the compatibility fallback path.
  await runtime.supervisor(created.taskId).propose({
    requirementVersion: 1,
    summary: '无声明决策',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'master', kind: 'agent', role: 'master', action: 'master', definitionVersion: 'master@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['master'], input: { command: 'node', args: ['--version'] } },
    ],
  }, 'draft');

  const read = new TaskStore(join(stateDir, 'tasks.sqlite'));
  const row = read.db.prepare('SELECT decision_snapshot FROM proposals WHERE task_id=? AND version=1').get(created.taskId) as { decision_snapshot: string | null } | undefined;
  read.close();

  expect(row?.decision_snapshot).toBeTruthy();
  const snapshot = row!.decision_snapshot!;
  const lines = snapshot.split('\n').filter(line => line.trim());

  // Bounded in count and in size, so a long conversation cannot grow the briefing without limit.
  expect(lines.length).toBeLessThanOrEqual(20);
  expect(snapshot.length).toBeLessThanOrEqual(4_000);
  // The opening survives: this is where the original request and its constraints live.
  expect(snapshot).toContain('第 0 条提问');
  // The recent end survives.
  expect(snapshot).toContain('第 79 条提问');
  // The middle is what gives way.
  expect(snapshot).not.toContain('第 40 条提问');
}, 60_000);
