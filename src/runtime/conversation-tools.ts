import type { Json } from '../core/types.ts';

/**
 * Handing work to another conversation.
 *
 * The authority is explicit: any conversation in any project, and full access is what unlocks it. Every
 * other rule here exists because that door is wide — a session must not talk to itself, a handoff must
 * not bounce A→B→A, and one turn must not turn into a broadcast. The rules live in one module so the
 * tools, the wiring and their tests cannot drift apart.
 */

/** How many cross-conversation messages one operation may hand out. */
export const CONVERSATION_SEND_LIMIT = 4;

export interface ConversationWriteAttempt {
  /** Whether this operation may write to the host at all (full access). */
  hostWrite: boolean;
  /** The conversation this operation belongs to. */
  caller: string;
  /** The conversation it wants to speak into. */
  target: string;
  /** Conversations that already relayed this message, oldest first, including the caller. */
  chain: string[];
  /** Cross-conversation messages this operation already handed out. */
  sent: number;
}

/** Why this write is refused, or null when it may go ahead. */
export function conversationWriteRefusal(attempt: ConversationWriteAttempt): string | null {
  if (!attempt.hostWrite) {
    return '写别的会话需要完全访问：这次操作没有主机写权限，请把结果报告给使用者。';
  }
  if (attempt.target === attempt.caller) {
    return '这是你自己的会话：把结果直接回答给使用者，而不是发消息给自己。';
  }
  if (attempt.chain.includes(attempt.target)) {
    return `转发链已经经过 ${attempt.target}：A→B→A 的往复在这里停下，请把矛盾报告给使用者。`;
  }
  if (attempt.sent >= CONVERSATION_SEND_LIMIT) {
    return `这次操作已经发出 ${attempt.sent} 条跨会话消息（上限 ${CONVERSATION_SEND_LIMIT}）：停下来，把进展报告给使用者。`;
  }
  return null;
}

/**
 * An Agent's message says who wrote it — in the text the target model reads, and in its ledger, so it
 * can never be mistaken for the user's own words.
 */
export function agentMessageText(text: string, source: { conversationId: string; nodeId?: string }): string {
  const who = `另一个 Agent（会话 ${source.conversationId}${source.nodeId ? ` / ${source.nodeId}` : ''}）`;
  return `[来自${who}的消息]\n\n${text.trim()}`;
}

/** The conversation service as far as these tools need it, so the module does not depend on the runtime. */
export interface ConversationToolService {
  list(query?: { archived?: boolean }): unknown;
  view(conversationId: string, query?: { limit?: number; after?: number }): Promise<{ messages: { role: string; data?: { source?: { chain?: string[] } } | null }[] }>;
  events(conversationId: string, after?: number, limit?: number): unknown;
  chat(conversationId: string, input: { text: string; requestId: string; source?: Json }): Promise<unknown>;
  steer(conversationId: string, input: { requestId: string }): Promise<unknown>;
  pause(conversationId: string, requestId: string): Promise<unknown>;
  resume(conversationId: string, requestId: string): Promise<unknown>;
}

export interface ConversationToolChannel {
  list(query: { archived?: boolean }): Promise<unknown>;
  read(conversationId: string, query: { limit: number; after: number }): Promise<unknown>;
  follow(conversationId: string, after: number, limit: number): Promise<unknown>;
  send(input: { conversationId: string; text: string; requestId: string }): Promise<unknown>;
  steer(input: { conversationId: string; text: string; requestId: string }): Promise<unknown>;
  pause(input: { conversationId: string; requestId: string }): Promise<unknown>;
  resume(input: { conversationId: string; requestId: string }): Promise<unknown>;
}

/**
 * The tools one Agent session gets over other sessions. State that belongs to the *operation* (how many
 * handoffs it has made, which conversations drove it) lives in this closure, not in the model.
 */
export function openConversationTools(input: {
  service: ConversationToolService;
  caller: { conversationId: string; taskId: string; nodeId: string };
  hostWrite: boolean;
  /** Recorded on the caller's ledger so a handoff is a fact, never a guess. */
  onHandoff?: (record: Record<string, Json>) => void;
}): ConversationToolChannel {
  let sent = 0;

  // The chain a session inherits is the chain of the message that drove it: whoever sent into this
  // conversation is upstream, so a reply back upstream is a bounce, not a new handoff.
  const inheritedChain = async () => {
    try {
      const view = await input.service.view(input.caller.conversationId, { limit: 20 });
      const carried = [...view.messages].reverse()
        .find(message => message.data?.source?.chain?.length)?.data?.source?.chain;
      return carried ?? [];
    } catch {
      return [];
    }
  };

  const check = async (target: string) => {
    const refusal = conversationWriteRefusal({
      hostWrite: input.hostWrite, caller: input.caller.conversationId, target,
      chain: [...(await inheritedChain()), input.caller.conversationId], sent,
    });
    if (refusal) throw new Error(refusal);
  };

  const handoff = (record: Record<string, Json>) => input.onHandoff?.(record);

  const source = async (target: string): Promise<Json> => ({
    kind: 'agent',
    conversationId: input.caller.conversationId,
    nodeId: input.caller.nodeId,
    taskId: input.caller.taskId,
    chain: [...(await inheritedChain()), input.caller.conversationId, target],
  });

  return {
    list: async query => input.service.list(query),
    read: async (conversationId, query) => input.service.view(conversationId, { limit: query.limit, after: query.after }),
    follow: async (conversationId, after, limit) => input.service.events(conversationId, after, limit),
    send: async request => {
      await check(request.conversationId);
      const receipt = await input.service.chat(request.conversationId, {
        text: agentMessageText(request.text, input.caller),
        requestId: request.requestId,
        source: await source(request.conversationId),
      });
      sent += 1;
      handoff({ action: 'send', caller: input.caller.conversationId, target: request.conversationId, requestId: request.requestId, text: request.text.slice(0, 500) });
      return receipt;
    },
    steer: async request => {
      await check(request.conversationId);
      // The console does the same two steps: the text is queued first, then Enter steers that queue
      // into the turn that is already running.
      const queued = await input.service.chat(request.conversationId, {
        text: agentMessageText(request.text, input.caller),
        requestId: request.requestId,
        source: await source(request.conversationId),
      });
      const steered = await input.service.steer(request.conversationId, { requestId: `${request.requestId}:steer` });
      sent += 1;
      handoff({ action: 'steer', caller: input.caller.conversationId, target: request.conversationId, requestId: request.requestId, text: request.text.slice(0, 500) });
      return { queued, steered };
    },
    pause: async request => {
      await check(request.conversationId);
      const receipt = await input.service.pause(request.conversationId, request.requestId);
      handoff({ action: 'pause', caller: input.caller.conversationId, target: request.conversationId, requestId: request.requestId });
      return receipt;
    },
    resume: async request => {
      await check(request.conversationId);
      const receipt = await input.service.resume(request.conversationId, request.requestId);
      handoff({ action: 'resume', caller: input.caller.conversationId, target: request.conversationId, requestId: request.requestId });
      return receipt;
    },
  };
}
