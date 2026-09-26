import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

/**
 * One Agent session hands work to another and follows it. What has to hold end to end: the message
 * lands in the target conversation attributed to the Agent that wrote it (never as the user), the
 * target really answers it, and this session can read the answer back by cursor.
 */
test('a master turn sends work into another conversation, follows it, and reads the answer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-tools-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const provider = await openaiServer([
    // A — the calling session: it writes into B, follows B, then closes its own turn. The tool
    // arguments are built lazily so the target conversation id (only known after it exists) is real.
    { tools: [{ id: 'send', name: 'conversation_write', arguments: () => JSON.stringify({ action: 'send', conversationId: targetId, text: '请把候选项检查一遍', requestId: 'send-1' }) }] },
    { tools: [{ id: 'follow', name: 'conversation_read', arguments: () => JSON.stringify({ action: 'follow', conversationId: targetId }) }] },
    { text: '已把活交给另一个会话。' },
    // B — the target session answers what it was given.
    { text: '检查完毕，没有问题。' },
  ]);
  cleanup.push(() => provider.close());
  const entries = [
    { ...provider.model, id: 'local', grade: 'high' as const, credentialId: 'local' },
  ];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], actions: {},
    access: () => fullAccessPolicy(),
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    models: { entries, apiKey: 'local-key', credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }), modelRuntime: provider.runtime },
    live: {
      revision: () => 1, config: () => ({}), entries: () => entries, preferences: () => ({}),
      credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }),
      masterModel: () => 'local', defaultBudgetTokens: () => null, projects: () => [{ id: 'p', root: project }],
    },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');

  const caller = await runtime.conversations.create({ projectId: 'p', text: '开工。', requestId: 'caller' });
  const target = await runtime.conversations.create({ projectId: 'p', text: '先待命。', requestId: 'target' });
  const targetId = target.conversationId;
  await runtime.host.runReady();
  await runtime.conversations.chat(caller.conversationId, { text: '把一个检查交给另一个会话。', requestId: 'ask' });
  await runtime.host.runReady();
  await runtime.host.runReady();

  const targetView = await runtime.conversations.view(target.conversationId);
  const handed = targetView.messages.find(message => message.role === 'user' && message.text.includes('请把候选项检查一遍'));
  expect(handed).toBeDefined();
  // Attribution is the whole point: the target session must see that an Agent wrote this, not the user.
  expect(handed!.text).toContain('另一个 Agent');
  expect(handed!.data).toMatchObject({ source: { kind: 'agent', conversationId: caller.conversationId } });
  // The target really ran and answered.
  expect(targetView.messages.some(message => message.role === 'assistant' && message.text.includes('检查完毕'))).toBe(true);
  // The caller's own ledger keeps what it did.
  const events = new DatabaseSync(join(root, 'state', 'tasks.sqlite'))
    .prepare("SELECT data FROM events WHERE type = 'conversation.handed_off' ORDER BY rowid")
    .all() as { data: string }[];
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]!.data)).toMatchObject({ caller: caller.conversationId, target: target.conversationId, action: 'send' });
}, 120_000);
