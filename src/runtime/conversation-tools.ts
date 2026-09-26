import type { Json } from '../core/types.ts';

/**
 * Handing work to another conversation.
 *
 * The authority is explicit and it is the whole rule: any conversation in any project, and full access is
 * what unlocks it. Two guards the user removed — the A→B→A chain stop and the per-operation ceiling —
 * never fired in production, and the first one forbade an ordinary reply, so agents now talk freely and
 * the only remaining refusal is addressing itself. The rules live in one module so the tools, the wiring
 * and their tests cannot drift apart.
 */

export interface ConversationWriteAttempt {
  /** Whether this operation may write to the host at all (full access). */
  hostWrite: boolean;
  /** The conversation this operation belongs to. */
  caller: string;
  /** The conversation it wants to speak into. */
  target: string;
}

/** Why this write is refused, or null when it may go ahead. */
export function conversationWriteRefusal(attempt: ConversationWriteAttempt): string | null {
  if (!attempt.hostWrite) {
    return '写别的会话需要完全访问：这次操作没有主机写权限，请把结果报告给使用者。';
  }
  if (attempt.target === attempt.caller) {
    return '这是你自己的会话：把结果直接回答给使用者，而不是发消息给自己。';
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
  /** The ledger rows as the service returns them. */
  view(conversationId: string, query?: { limit?: number; after?: number }): Promise<{ messages: { role?: string; data?: unknown }[] }>;
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
 * The tools one Agent session gets over other sessions. What this closure keeps is the handoff ledger:
 * every message it writes is recorded on the caller's own transcript, so a handoff is a fact, never a
 * guess.
 */
export function openConversationTools(input: {
  service: ConversationToolService;
  caller: { conversationId: string; taskId: string; nodeId: string };
  hostWrite: boolean;
  /** Recorded on the caller's ledger so a handoff is a fact, never a guess. */
  onHandoff?: (record: Record<string, Json>) => void;
}): ConversationToolChannel {
  const check = (target: string) => {
    const refusal = conversationWriteRefusal({
      hostWrite: input.hostWrite, caller: input.caller.conversationId, target,
    });
    if (refusal) throw new Error(refusal);
  };

  const handoff = (record: Record<string, Json>) => input.onHandoff?.(record);

  // Provenance names the direct sender. The target model and its ledger can always tell that another
  // Agent wrote this, and the `conversation.handed_off` events carry the lineage for whoever needs it.
  const source = (): Json => ({
    kind: 'agent',
    conversationId: input.caller.conversationId,
    nodeId: input.caller.nodeId,
    taskId: input.caller.taskId,
  });

  return {
    list: async query => input.service.list(query),
    read: async (conversationId, query) => input.service.view(conversationId, {
      limit: query.limit,
      // No cursor means the newest window: a read that answered "what did they just say?" with the
      // opening messages was useless. A cursor pages forward from where the last read stopped.
      ...(query.after > 0 ? { after: query.after } : {}),
    }),
    follow: async (conversationId, after, limit) => input.service.events(conversationId, after, limit),
    send: async request => {
      check(request.conversationId);
      const receipt = await input.service.chat(request.conversationId, {
        text: agentMessageText(request.text, input.caller),
        requestId: request.requestId,
        source: source(),
      });
      handoff({ action: 'send', caller: input.caller.conversationId, target: request.conversationId, requestId: request.requestId, text: request.text.slice(0, 500) });
      return receipt;
    },
    steer: async request => {
      check(request.conversationId);
      // The console does the same two steps: the text is queued first, then Enter steers that queue
      // into the turn that is already running.
      const queued = await input.service.chat(request.conversationId, {
        text: agentMessageText(request.text, input.caller),
        requestId: request.requestId,
        source: source(),
      });
      const steered = await input.service.steer(request.conversationId, { requestId: `${request.requestId}:steer` });
      handoff({ action: 'steer', caller: input.caller.conversationId, target: request.conversationId, requestId: request.requestId, text: request.text.slice(0, 500) });
      return { queued, steered };
    },
    pause: async request => {
      check(request.conversationId);
      const receipt = await input.service.pause(request.conversationId, request.requestId);
      handoff({ action: 'pause', caller: input.caller.conversationId, target: request.conversationId, requestId: request.requestId });
      return receipt;
    },
    resume: async request => {
      check(request.conversationId);
      const receipt = await input.service.resume(request.conversationId, request.requestId);
      handoff({ action: 'resume', caller: input.caller.conversationId, target: request.conversationId, requestId: request.requestId });
      return receipt;
    },
  };
}
