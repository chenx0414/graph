/**
 * Pure composer rules shared by the chat UI and its unit tests.
 *
 * The React components keep only DOM wiring (refs, effects, event handlers) so
 * every rule here can be verified without a browser, a port or a renderer.
 */

export const COMPOSER_DRAFT_PREFIX = 'graph.conversation.composer.';

export interface ComposerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function composerDraftKey(conversationId: string) {
  return `${COMPOSER_DRAFT_PREFIX}${conversationId}`;
}

/** Return the stored draft, degrading to empty when storage is missing/blocked. */
export function readComposerDraft(storage: ComposerStorage | null | undefined, conversationId: string): string {
  try {
    const value = storage?.getItem(composerDraftKey(conversationId));
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** Persist the draft; an empty value clears the slot. Never throws. */
export function writeComposerDraft(storage: ComposerStorage | null | undefined, conversationId: string, value: string): void {
  try {
    if (!storage) return;
    if (value) storage.setItem(composerDraftKey(conversationId), value);
    else storage.removeItem(composerDraftKey(conversationId));
  } catch {
    // A full, blocked or absent storage must never break composing.
  }
}

/** Jump to the newest message exactly once per entry; never re-yank a reader. */
export function shouldScrollToLatest(input: { tab: string; hasMessages: boolean; alreadyJumped: boolean }): boolean {
  return input.tab === 'chat' && input.hasMessages && !input.alreadyJumped;
}

export type ComposerPrimaryMode = 'send' | 'pause' | 'resume' | 'pending';
export type ComposerPrimaryAction =
  | 'send'
  | 'pause'
  | 'resume'
  | 'send-and-resume'
  | 'steer'
  | 'suggestion'
  | 'none';

export interface ComposerPrimaryInput {
  /** The master is producing output. */
  busy: boolean;
  /** The conversation is paused. */
  paused: boolean;
  /** A pause/resume request is in flight. */
  pending: boolean;
  /** The composer has text or attachments. */
  hasInput: boolean;
  /** Queued (undelivered) messages for this conversation. */
  queueLength: number;
  /** A suggested prompt is available while idle. */
  hasSuggestion: boolean;
}

export function composerPrimaryState(input: ComposerPrimaryInput): { mode: ComposerPrimaryMode; action: ComposerPrimaryAction } {
  if (input.pending) return { mode: 'pending', action: 'none' };
  if (input.paused) {
    if (input.hasInput || input.queueLength > 0) return { mode: 'send', action: 'send-and-resume' };
    return { mode: 'resume', action: 'resume' };
  }
  if (input.busy) {
    return { mode: 'pause', action: 'pause' };
  }
  if (input.hasInput) return { mode: 'send', action: 'send' };
  if (input.queueLength > 0) return { mode: 'send', action: 'steer' };
  if (input.hasSuggestion) return { mode: 'send', action: 'suggestion' };
  return { mode: 'send', action: 'none' };
}

export function composerPrimaryDisabled(input: {
  sending: boolean; steering: boolean; pending: boolean; paused: boolean; busy: boolean; hasInput: boolean; hasSuggestion: boolean;
}): boolean {
  if (input.sending || input.steering || input.pending) return true;
  if (input.paused || input.busy) return false;
  return !input.hasInput && !input.hasSuggestion;
}

/** Cancelled messages never appear in the transcript. */
export function visibleTranscriptMessages<T extends { role: string; state: string }>(messages: T[]): T[] {
  return messages.filter(message => !(message.role === 'user' && message.state === 'cancelled'));
}

/** Drop one message from the queue, preserving the order of the rest. */
export function cancelQueuedMessage<T extends { id: string }>(queue: T[], messageId: string): T[] {
  return queue.filter(message => message.id !== messageId);
}
