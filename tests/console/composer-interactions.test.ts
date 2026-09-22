import { describe, expect, test } from 'vitest';
import {
  COMPOSER_LINE_HEIGHT,
  COMPOSER_MAX_HEIGHT,
  cancelQueuedMessage,
  clampComposerHeight,
  composerDraftKey,
  composerPrimaryDisabled,
  composerPrimaryState,
  composerTextareaHeight,
  queuedUserMessages,
  readComposerDraft,
  shouldScrollToLatest,
  visibleTranscriptMessages,
  writeComposerDraft,
  type ComposerStorage,
} from '../../src/web/composer-state.ts';

function memoryStorage(initial: Record<string, string> = {}): ComposerStorage & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    getItem: key => (key in values ? values[key]! : null),
    setItem: (key, value) => { values[key] = value; },
    removeItem: key => { delete values[key]; },
  };
}

function blockedStorage(): ComposerStorage {
  const fail = () => { throw new Error('storage blocked'); };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

describe('① adaptive composer height', () => {
  test('grows one line at a time with the content', () => {
    expect(composerTextareaHeight(1)).toEqual({ height: COMPOSER_LINE_HEIGHT, scrollable: false });
    expect(composerTextareaHeight(3)).toEqual({ height: COMPOSER_LINE_HEIGHT * 3, scrollable: false });
  });

  test('an empty composer keeps exactly one line', () => {
    expect(composerTextareaHeight(0)).toEqual({ height: COMPOSER_LINE_HEIGHT, scrollable: false });
  });

  test('caps at the maximum and only then becomes scrollable', () => {
    const atMaxLines = COMPOSER_MAX_HEIGHT / COMPOSER_LINE_HEIGHT;
    expect(composerTextareaHeight(atMaxLines)).toEqual({ height: COMPOSER_MAX_HEIGHT, scrollable: false });
    expect(composerTextareaHeight(atMaxLines + 1)).toEqual({ height: COMPOSER_MAX_HEIGHT, scrollable: true });
  });

  test('clamps a measured pixel height into range', () => {
    expect(clampComposerHeight(0)).toEqual({ height: 0, scrollable: false });
    expect(clampComposerHeight(100)).toEqual({ height: 100, scrollable: false });
    expect(clampComposerHeight(COMPOSER_MAX_HEIGHT)).toEqual({ height: COMPOSER_MAX_HEIGHT, scrollable: false });
    expect(clampComposerHeight(240)).toEqual({ height: COMPOSER_MAX_HEIGHT, scrollable: true });
    expect(clampComposerHeight(Number.NaN)).toEqual({ height: 0, scrollable: false });
  });

  test('honours a custom maximum', () => {
    expect(composerTextareaHeight(10, { maxHeight: 40 })).toEqual({ height: 40, scrollable: true });
    expect(composerTextareaHeight(1, { maxHeight: 40, lineHeight: 30 })).toEqual({ height: 30, scrollable: false });
  });
});

describe('② composer draft persistence', () => {
  test('keys the draft by conversation id', () => {
    expect(composerDraftKey('conversation-a')).toBe('graph.conversation.composer.conversation-a');
    expect(composerDraftKey('b')).not.toBe(composerDraftKey('a'));
  });

  test('writes, reads and clears a per-conversation draft', () => {
    const storage = memoryStorage();
    writeComposerDraft(storage, 'a', '还没发出去的内容');
    expect(readComposerDraft(storage, 'a')).toBe('还没发出去的内容');
    expect(readComposerDraft(storage, 'b')).toBe('');
    writeComposerDraft(storage, 'a', '');
    expect(readComposerDraft(storage, 'a')).toBe('');
    expect(composerDraftKey('a') in storage.values).toBe(false);
  });

  test('degrades safely when storage is missing or blocked', () => {
    expect(readComposerDraft(null, 'a')).toBe('');
    expect(() => writeComposerDraft(null, 'a', 'x')).not.toThrow();
    expect(readComposerDraft(undefined, 'a')).toBe('');
    const blocked = blockedStorage();
    expect(readComposerDraft(blocked, 'a')).toBe('');
    expect(() => writeComposerDraft(blocked, 'a', 'x')).not.toThrow();
    expect(() => writeComposerDraft(blocked, 'a', '')).not.toThrow();
  });
});

describe('③ scroll-to-latest decision', () => {
  test('jumps once when entering a chat with messages', () => {
    expect(shouldScrollToLatest({ tab: 'chat', hasMessages: true, alreadyJumped: false })).toBe(true);
  });

  test('never jumps a second time, so a reader who scrolled up is not yanked', () => {
    expect(shouldScrollToLatest({ tab: 'chat', hasMessages: true, alreadyJumped: true })).toBe(false);
  });

  test('never jumps outside the chat tab or when there is nothing to show', () => {
    expect(shouldScrollToLatest({ tab: 'graph', hasMessages: true, alreadyJumped: false })).toBe(false);
    expect(shouldScrollToLatest({ tab: 'artifacts', hasMessages: true, alreadyJumped: false })).toBe(false);
    expect(shouldScrollToLatest({ tab: 'chat', hasMessages: false, alreadyJumped: false })).toBe(false);
  });
});

describe('④ primary button state machine', () => {
  const idle = { busy: false, paused: false, pending: false, hasInput: false, queueLength: 0, hasSuggestion: false };

  test('outputting offers pause no matter what is typed or queued', () => {
    expect(composerPrimaryState({ ...idle, busy: true })).toEqual({ mode: 'pause', action: 'pause' });
    expect(composerPrimaryState({ ...idle, busy: true, hasInput: true })).toEqual({ mode: 'pause', action: 'pause' });
    expect(composerPrimaryState({ ...idle, busy: true, queueLength: 3 })).toEqual({ mode: 'pause', action: 'pause' });
    expect(composerPrimaryState({ ...idle, busy: true, hasInput: true, queueLength: 3 })).toEqual({ mode: 'pause', action: 'pause' });
  });

  test('paused with an empty composer and empty queue resumes', () => {
    expect(composerPrimaryState({ ...idle, paused: true })).toEqual({ mode: 'resume', action: 'resume' });
  });

  test('paused with input sends the message and auto-continues', () => {
    expect(composerPrimaryState({ ...idle, paused: true, hasInput: true })).toEqual({ mode: 'send', action: 'send-and-resume' });
  });

  test('paused with a nonempty queue sends the queue and auto-continues', () => {
    expect(composerPrimaryState({ ...idle, paused: true, queueLength: 2 })).toEqual({ mode: 'send', action: 'send-and-resume' });
  });

  test('a pause/resume in flight shows a pending control', () => {
    expect(composerPrimaryState({ ...idle, pending: true })).toEqual({ mode: 'pending', action: 'none' });
  });

  test('idle sends, steers the queue, or takes the suggestion', () => {
    expect(composerPrimaryState({ ...idle, hasInput: true })).toEqual({ mode: 'send', action: 'send' });
    expect(composerPrimaryState({ ...idle, queueLength: 1 })).toEqual({ mode: 'send', action: 'steer' });
    expect(composerPrimaryState({ ...idle, hasSuggestion: true })).toEqual({ mode: 'send', action: 'suggestion' });
    expect(composerPrimaryState(idle)).toEqual({ mode: 'send', action: 'none' });
  });

  test('stays disabled unless there is something to do', () => {
    const flags = { sending: false, steering: false, pending: false, paused: false, busy: false, hasInput: false, hasSuggestion: false };
    expect(composerPrimaryDisabled(flags)).toBe(true);
    expect(composerPrimaryDisabled({ ...flags, hasInput: true })).toBe(false);
    expect(composerPrimaryDisabled({ ...flags, hasSuggestion: true })).toBe(false);
    expect(composerPrimaryDisabled({ ...flags, busy: true })).toBe(false);
    expect(composerPrimaryDisabled({ ...flags, paused: true })).toBe(false);
    expect(composerPrimaryDisabled({ ...flags, sending: true, hasInput: true })).toBe(true);
    expect(composerPrimaryDisabled({ ...flags, steering: true, hasInput: true })).toBe(true);
    expect(composerPrimaryDisabled({ ...flags, pending: true, paused: true })).toBe(true);
  });
});

describe('⑤ queued message list after cancel', () => {
  const messages = [
    { id: 'a', role: 'user', state: 'queued' },
    { id: 'b', role: 'user', state: 'queued' },
    { id: 'c', role: 'assistant', state: 'done' },
    { id: 'd', role: 'user', state: 'cancelled' },
  ];

  test('only user messages still queued stay in the queue, in order', () => {
    expect(queuedUserMessages(messages).map(message => message.id)).toEqual(['a', 'b']);
  });

  test('cancelling drops that row and leaves the rest untouched', () => {
    expect(cancelQueuedMessage(queuedUserMessages(messages), 'a').map(message => message.id)).toEqual(['b']);
    expect(cancelQueuedMessage(queuedUserMessages(messages), 'b').map(message => message.id)).toEqual(['a']);
    expect(cancelQueuedMessage(queuedUserMessages(messages), 'missing').map(message => message.id)).toEqual(['a', 'b']);
    expect(cancelQueuedMessage([{ id: 'only' }], 'only')).toEqual([]);
  });

  test('an empty queue stays empty and never throws', () => {
    expect(queuedUserMessages([])).toEqual([]);
    expect(cancelQueuedMessage<{ id: string }>([], 'a')).toEqual([]);
  });

  test('cancelled messages never leak into the transcript', () => {
    expect(visibleTranscriptMessages(messages).map(message => message.id)).toEqual(['a', 'b', 'c']);
  });
});
