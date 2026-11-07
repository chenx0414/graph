import { describe, expect, test } from 'vitest';
import {
  composerPrimaryDisabled,
  composerPrimaryState,
  readComposerDraft,
  shouldScrollToLatest,
  writeComposerDraft,
  type ComposerStorage,
} from '../../src/web/composer-state.ts';

function blockedStorage(): ComposerStorage {
  const fail = () => { throw new Error('storage blocked'); };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

describe('② composer draft persistence', () => {

  test('degrades safely when storage is missing, unreadable or refuses draft removal', () => {
    expect(readComposerDraft(null, 'a')).toBe('');
    expect(() => writeComposerDraft(null, 'a', 'x')).not.toThrow();
    expect(readComposerDraft(undefined, 'a')).toBe('');
    const blocked = blockedStorage();
    expect(readComposerDraft(blocked, 'a')).toBe('');
    expect(() => writeComposerDraft(blocked, 'a', '')).not.toThrow();
  });
});

describe('③ scroll-to-latest decision', () => {

  test('never jumps outside the chat tab or when there is nothing to show', () => {
    expect(shouldScrollToLatest({ tab: 'graph', hasMessages: true, alreadyJumped: false })).toBe(false);
    expect(shouldScrollToLatest({ tab: 'artifacts', hasMessages: true, alreadyJumped: false })).toBe(false);
    expect(shouldScrollToLatest({ tab: 'chat', hasMessages: false, alreadyJumped: false })).toBe(false);
  });
});

describe('④ primary button state machine', () => {
  const idle = { busy: false, paused: false, pending: false, hasInput: false, queueLength: 0 };

  test('idle sends, steers the queue, or does nothing', () => {
    expect(composerPrimaryState({ ...idle, hasInput: true })).toEqual({ mode: 'send', action: 'send' });
    expect(composerPrimaryState({ ...idle, queueLength: 1 })).toEqual({ mode: 'send', action: 'steer' });
    expect(composerPrimaryState(idle)).toEqual({ mode: 'send', action: 'none' });
  });

  test('stays disabled unless there is something to do', () => {
    const flags = { sending: false, steering: false, pending: false, paused: false, busy: false, hasInput: false };
    expect(composerPrimaryDisabled(flags)).toBe(true);
    expect(composerPrimaryDisabled({ ...flags, hasInput: true })).toBe(false);
    expect(composerPrimaryDisabled({ ...flags, busy: true })).toBe(false);
    expect(composerPrimaryDisabled({ ...flags, paused: true })).toBe(false);
    expect(composerPrimaryDisabled({ ...flags, sending: true, hasInput: true })).toBe(true);
    expect(composerPrimaryDisabled({ ...flags, steering: true, hasInput: true })).toBe(true);
    expect(composerPrimaryDisabled({ ...flags, pending: true, paused: true })).toBe(true);
  });
});
