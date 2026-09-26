import { expect, test } from 'vitest';
import { agentMessageText, conversationWriteRefusal, openConversationTools } from '../../src/runtime/conversation-tools.ts';

/**
 * The outward rules of handing a message to another conversation. The user kept one authority and
 * removed two guards: full access is still what unlocks a write, and a session still cannot address
 * itself — but a reply back is a message rather than a bounce, and one turn may hand out as many as it
 * needs. Both removed rules never fired in production and one of them forbade a normal conversation.
 */
test('a write needs full access, and that is the only door it needs', () => {
  expect(conversationWriteRefusal({ hostWrite: true, caller: 'A', target: 'B' })).toBeNull();

  // Without host write there is no authority to speak into somebody else's session.
  expect(conversationWriteRefusal({ hostWrite: false, caller: 'A', target: 'B' })).toMatch(/完全访问/);
  // Addressing itself is not a permission question: every other tool already answers this session.
  expect(conversationWriteRefusal({ hostWrite: true, caller: 'A', target: 'A' })).toMatch(/自己/);
});

test('agents talk freely: a reply back is a message, and one turn may send as many as it needs', async () => {
  const sent: string[] = [];
  const channel = openConversationTools({
    service: {
      list: () => [],
      // A transcript that already relayed a message from B: under the old chain rule this read was
      // enough to refuse a handoff, which made an ordinary reply impossible.
      view: async () => ({ messages: [{ role: 'user', data: { source: { chain: ['B', 'A'] } } }] }),
      events: () => [],
      chat: async (conversationId, input) => { sent.push(`${conversationId}:${input.text.split('\n').pop() ?? ''}`); return {}; },
      steer: async () => ({}),
      pause: async () => ({}),
      resume: async () => ({}),
    },
    caller: { conversationId: 'A', taskId: 't-1', nodeId: 'master' },
    hostWrite: true,
  });

  await channel.send({ conversationId: 'B', text: 'reply back', requestId: 'r-0' });
  for (let index = 1; index <= 6; index += 1) {
    await channel.send({ conversationId: 'B', text: `fan ${index}`, requestId: `r-${index}` });
  }
  expect(sent).toEqual(['B:reply back', 'B:fan 1', 'B:fan 2', 'B:fan 3', 'B:fan 4', 'B:fan 5', 'B:fan 6']);
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
