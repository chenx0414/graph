import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import type { Operation } from '../../src/core/types.ts';
import { TaskStore } from '../../src/core/store.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function setup(plans: ResponsePlan[] = [{ text: 'Peer reply' }, { text: 'User reply' }], owningConversation = false) {
  const root = await mkdtemp(join(tmpdir(), 'graph-messages-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer(plans); cleanup.push(() => provider.close());
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  const mainTurns: Operation[] = [];
  const runtime = await openTaskRuntime({ ...(owningConversation ? {
    master: { action: 'main', definitionVersion: 'main@1', model: 'local' },
    actions: { main: { kind: 'agent' as const, reserveTokens: 1, prepare: async (operation: Operation) => async () => {
      mainTurns.push(operation);
      return { outcome: 'completed' as const, output: { text: 'Clarification from main.' }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    } } },
  } : {}), stateDir: join(root, 'state'), projects: [{ id: 'p', root }], access: () => fullAccessPolicy(),
    catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
    models: { apiKey: 'local-only', modelRuntime: provider.runtime, entries: [{ id: 'local', provider: provider.model.provider,
      grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] },
  });
  cleanup.push(() => runtime.close()); runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');
  const parent = owningConversation
    ? await runtime.conversations.create({ projectId: 'p', text: 'peer messages', requestId: 'begin' })
    : await runtime.user.begin({ projectId: 'p', request: 'peer messages', requestId: 'begin' });
  const node = { recipe: 'worker@1', model: 'local', task: 'Reply to messages.', inputs: {}, outputs: {}, submission: {} };
  const { graphId: taskId } = await runtime.supervisor(parent.taskId).graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2,
    name: 'Peer messages', protocols: {}, nodes: { work: node, sibling: node }, modules: {}, edges: {} }) }) as { graphId: string };
  const store = new TaskStore(join(root, 'state/tasks.sqlite')); cleanup.push(() => store.close());
  return { runtime, taskId, store, provider, mainTurns };
}

test('a peer message that happened is what the native graph draws, and deleting its record empties the picture', async () => {
  const { runtime, taskId, store, provider } = await setup();
  expect(runtime.graphMessages(taskId)).toHaveLength(0);
  const input = { to: 'sibling', text: '你的诊断脚本里那段路径要 realpath 后再比', requestId: 'peer-1' };
  const delivered = await runtime.sendPeerMessage(taskId, 'work', input);
  expect(delivered).toMatchObject({ taskId, nodeId: 'sibling', queued: true });
  expect(await runtime.sendPeerMessage(taskId, 'work', input)).toEqual(delivered);
  const messages = runtime.graphMessages(taskId);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ source: 'work', target: 'sibling', text: input.text });
  expect(messages[0]!.id).toBeTruthy(); expect(messages[0]!.createdAt).toBeGreaterThan(0);
  await runtime.sendNodeMessage(taskId, 'work', { text: '用户的话', requestId: 'user-1' });
  expect(runtime.graphMessages(taskId)).toHaveLength(1);
  await runtime.host.drive();
  expect(runtime.nodeRun(taskId, 'sibling').node.status).toBe('succeeded');
  const requests = JSON.stringify(provider.requests);
  expect(requests).toContain(`From work: ${input.text}`);
  for (const [from, to] of [['work', 'ghost'], ['ghost', 'work'], ['work', 'another-task:work'], ['work', 'work']]) {
    await expect(runtime.sendPeerMessage(taskId, from!, { to: to!, text: '越权', requestId: `outside-${from}-${to}` }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  }
  expect(runtime.graphMessages(taskId)).toHaveLength(1);
  store.db.prepare("DELETE FROM node_entries WHERE task_id=? AND json_extract(data,'$.peer')=1").run(taskId);
  expect(runtime.graphMessages(taskId)).toHaveLength(0);
});

test('busy native node chats queue once per request and rerun serially in the same conversation', async () => {
  let release!: () => void; let received!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { received = resolve; });
  const { runtime, taskId, provider } = await setup([{ text: 'First reply', beforeReply: async () => { received(); await waiting; } },
    { text: 'Peer reply' }, { text: 'Last reply' }]);
  const before = runtime.nodeRun(taskId, 'work').instance!;
  const instance = before.id;
  const first = { text: 'First question', requestId: 'first' };
  const receipt = await runtime.sendNodeMessage(taskId, 'work', first);
  expect(await runtime.sendNodeMessage(taskId, 'work', first)).toEqual(receipt);
  const drive = runtime.host.drive();
  try {
    await arrived;
    const peer = { to: 'work', text: 'Second question', requestId: 'second' };
    expect(await runtime.sendPeerMessage(taskId, 'sibling', peer)).toMatchObject({ queued: true });
    await runtime.sendPeerMessage(taskId, 'sibling', peer);
    await runtime.sendNodeMessage(taskId, 'work', { text: 'Third question', requestId: 'third' });
    await expect(runtime.sendNodeMessage(taskId, 'work', { text: 'Changed first question', requestId: 'first' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const queue = await runtime.supervisor(taskId).graphInspect({ graphId: taskId, query: 'queue' }) as { items: { state: string }[] };
    expect(queue.items.map(item => item.state)).toEqual(['claimed', 'queued', 'queued']);
    expect(provider.requests).toHaveLength(1);
  } finally { release(); await drive; }
  expect(provider.requests).toHaveLength(3);
  expect(runtime.nodeRun(taskId, 'work').instance!.id).toBe(instance);
  expect(runtime.nodeRun(taskId, 'work').instance!.used).toBeGreaterThan(before.used);
  const second = provider.requests[1] as { messages: { role: string; content: unknown }[] };
  expect(JSON.stringify(second.messages)).toContain('First reply');
  const latestUser = second.messages.filter(message => message.role === 'user').at(-1)!;
  expect(JSON.stringify(latestUser.content)).toContain('From sibling: Second question');
  expect(JSON.stringify(latestUser.content)).not.toContain('GRAPH OVERVIEW');
  expect(runtime.nodeRun(taskId, 'sibling').operations).toHaveLength(0);
  const main = runtime.supervisor(taskId);
  const finished = await main.graphInspect({ graphId: taskId, query: 'queue' }) as { items: { seq: number; state: string; generation: number }[] };
  expect(finished.items.map(item => item.state)).toEqual(['done', 'done', 'done']);
  for (const action of ['retry', 'skip', 'cancel']) {
    await expect(main.graphControl({ graphId: taskId, action, seq: finished.items[0]!.seq })).rejects.toMatchObject({ code: 'invalid_queue' });
  }
  expect(await main.graphInspect({ graphId: taskId, query: 'queue' })).toEqual(finished);
  await runtime.host.drive();
  expect(provider.requests).toHaveLength(3);

  await runtime.supervisor(taskId).graphControl({ graphId: taskId, action: 'stop' });
  await runtime.host.drive();
  expect(await runtime.sendNodeMessage(taskId, 'work', first)).toEqual(receipt);
  await expect(runtime.sendNodeMessage(taskId, 'work', { text: 'New work after stop', requestId: 'closed' })).rejects.toMatchObject({ code: 'stopping' });
  expect(provider.requests).toHaveLength(3);
}, 30000);

test('the resident Pi peer tool publishes the same durable message arc as the SDK', async () => {
  const { runtime, taskId } = await setup([{ tools: [{ id: 'peer', name: 'send_to_peer', arguments: JSON.stringify({ to: 'sibling', text: 'Review this idea', requestId: 'tool-peer' }) }] },
    { text: 'Done' }, { text: 'Done' }]);
  await runtime.sendNodeMessage(taskId, 'work', { text: 'Ask sibling for review.', requestId: 'start' });
  await runtime.host.drive();
  expect(runtime.graphMessages(taskId)).toMatchObject([{ source: 'work', target: 'sibling', text: 'Review this idea' }]);
  expect(runtime.nodeRun(taskId, 'sibling').node.status).toBe('succeeded');
}, 30000);


test('resident Pi messages to main are durable once per sender request and replay through the SDK', async () => {
  const input = { to: 'main', text: 'Please clarify the acceptance criterion.', requestId: 'main-peer' };
  const knownUsage = { prompt_tokens: 7, completion_tokens: 3 };
  const { runtime, taskId, store, mainTurns } = await setup([
    { usage: knownUsage, tools: [{ id: 'first', name: 'send_to_peer', arguments: JSON.stringify(input) }] },
    { usage: knownUsage, tools: [{ id: 'retry', name: 'send_to_peer', arguments: JSON.stringify(input) }] },
    { usage: knownUsage, text: 'Waiting for main.' },
  ], true);
  await runtime.sendNodeMessage(taskId, 'work', { text: 'Ask main for clarification.', requestId: 'start' });
  await runtime.host.drive();
  const conversationId = store.task(taskId).conversation_id!;
  const peerMessages = async () => (await runtime.conversations.view(conversationId)).messages.filter(message => message.kind === 'peer');
  const conversation = await runtime.conversations.view(conversationId);
  expect(conversation.tasks.find(task => task.id === taskId)!.nodes.find(node => node.id === 'work')).toMatchObject({
    id: 'work', status: 'succeeded', model: 'local', role: 'worker', definitionVersion: 'worker@1', used: 30, unlimited: true, budget: null,
  });
  await runtime.supervisor(taskId).graphPatch({ graphId: taskId, baseRevision: 1, changes: {
    reason: 'Finite quota for the next turn', patch: { nodes: { work: { budget: { tokens: 500000 } } } },
  } });
  expect((await runtime.conversations.view(conversationId)).tasks.find(task => task.id === taskId)!.nodes.find(node => node.id === 'work'))
    .toMatchObject({ used: 30, unlimited: true, budget: null });
  const messages = await peerMessages();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ state: 'delivered', text: `[work](graph://${taskId}/agents/work): ${input.text}`,
    data: { graphId: taskId, nodeId: 'work', requestId: input.requestId } });
  expect(JSON.stringify(mainTurns)).toContain(input.text);
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM wake_intents WHERE kind='peer_message'").get()).toEqual({ count: 1 });
  const replay = await runtime.sendPeerMessage(taskId, 'work', input);
  expect(replay).toMatchObject({ id: messages[0]!.id });
  await expect(runtime.sendPeerMessage(taskId, 'work', { ...input, text: 'Changed question' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  for (const from of ['ghost', 'constructor']) {
    await expect(runtime.sendPeerMessage(taskId, from, input)).rejects.toMatchObject({ code: 'invalid_input' });
  }
  expect(await peerMessages()).toHaveLength(1);
  await runtime.supervisor(taskId).graphControl({ graphId: taskId, action: 'stop' });
  await runtime.host.drive();
  expect(await runtime.sendPeerMessage(taskId, 'work', input)).toEqual(replay);
  await expect(runtime.sendPeerMessage(taskId, 'work', { ...input, requestId: 'after-stop' })).rejects.toMatchObject({ code: 'stopping' });
  const turnsBeforeChat = mainTurns.length;
  await runtime.conversations.chat(conversationId, { text: 'Continue after the graph stopped.', requestId: 'continue-main' });
  await runtime.host.drive();
  expect(mainTurns.length).toBeGreaterThan(turnsBeforeChat);
  expect(JSON.stringify(mainTurns.at(-1))).toContain('Continue after the graph stopped.');
}, 30000);
