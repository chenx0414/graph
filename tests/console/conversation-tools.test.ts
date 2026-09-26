import { expect, test } from 'vitest';
import { CONVERSATION_SEND_LIMIT, agentMessageText, conversationWriteRefusal, openConversationTools } from '../../src/runtime/conversation-tools.ts';

/**
 * The outward rules of handing a message to another conversation, pinned before the tools exist. The
 * authority is the user's decision: any conversation in any project, and full access is what unlocks
 * it. Everything else here exists because that door is wide: a session must not be able to talk to
 * itself, a chain must not bounce (A→B→A), and one turn must not become a broadcast.
 */
test('a write into another conversation needs full access and a target that is not in the chain', () => {
  const base = { hostWrite: true, caller: 'A', chain: [] as string[], sent: 0 };
  expect(conversationWriteRefusal({ ...base, target: 'B' })).toBeNull();

  // Without host write there is no authority to speak into somebody else's session.
  expect(conversationWriteRefusal({ ...base, hostWrite: false, target: 'B' })).toMatch(/完全访问/);
  // Talking to itself is what every other tool already does.
  expect(conversationWriteRefusal({ ...base, target: 'A' })).toMatch(/自己/);
  // A→B→A ping-pong: the target already appears in this message's forwarding chain.
  expect(conversationWriteRefusal({ ...base, target: 'C', chain: ['C'] })).toMatch(/链/);
  // Runaway: one operation may only hand out so many cross-conversation messages.
  expect(conversationWriteRefusal({ ...base, target: 'B', sent: CONVERSATION_SEND_LIMIT })).toMatch(/上限/);
});

test('a message written by an Agent says so, so the target never mistakes it for the user', () => {
  const written = agentMessageText('请把候选项检查一遍', { conversationId: 'c-1', nodeId: 'master' });
  expect(written).toContain('请把候选项检查一遍');
  expect(written).toMatch(/另一个 Agent/);
  expect(written).toContain('c-1');
});

// A live miss: `read` asked for `after: 0`, which the service reads as "the oldest window", so a
// transcript read for "what did they answer?" returned the opening messages instead of the end.
test('read asks for the newest window unless a cursor says otherwise', async () => {
  const queries: ({ limit?: number; after?: number } | undefined)[] = [];
  const channel = openConversationTools({
    service: {
      list: () => [],
      view: async (_conversationId, query) => { queries.push(query); return { messages: [] }; },
      events: () => [],
      chat: async () => ({}),
      steer: async () => ({}),
      pause: async () => ({}),
      resume: async () => ({}),
    },
    caller: { conversationId: 'A', taskId: 't-1', nodeId: 'master' },
    hostWrite: true,
  });

  await channel.read('B', { limit: 20, after: 0 });
  await channel.read('B', { limit: 20, after: 7 });
  expect(queries[0]).toEqual({ limit: 20 });
  expect(queries[1]).toEqual({ limit: 20, after: 7 });
});
