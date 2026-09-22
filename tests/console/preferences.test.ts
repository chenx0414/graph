import { describe, expect, test } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_PREFIX,
  preferenceKey,
  readPreference,
  readPreferences,
  writePreference,
  type PreferenceStorage,
} from '../../src/web/preferences.ts';

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    getItem: key => (key in values ? values[key]! : null),
    setItem: (key, value) => { values[key] = value; },
  };
}

function blockedStorage(): PreferenceStorage {
  const fail = () => { throw new Error('storage blocked'); };
  return { getItem: fail, setItem: fail };
}

describe('defaults and keys', () => {
  test('markdown rendering defaults on, candidate prompts default off', () => {
    expect(DEFAULT_PREFERENCES).toEqual({ markdownRendering: true, candidatePrompt: false });
  });

  test('every value is keyed under the graph-pref- prefix', () => {
    expect(preferenceKey('markdownRendering')).toBe(`${PREFERENCES_PREFIX}markdown-rendering`);
    expect(preferenceKey('candidatePrompt')).toBe(`${PREFERENCES_PREFIX}candidate-prompt`);
    expect(preferenceKey('markdownRendering')).not.toBe(preferenceKey('candidatePrompt'));
  });

  test('an empty storage yields the defaults', () => {
    const storage = memoryStorage();
    expect(readPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
    expect(readPreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(readPreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('read and write', () => {
  test('round-trips both preferences independently', () => {
    const storage = memoryStorage();
    writePreference(storage, 'markdownRendering', false);
    expect(readPreference(storage, 'markdownRendering')).toBe(false);
    expect(readPreference(storage, 'candidatePrompt')).toBe(false);
    writePreference(storage, 'candidatePrompt', true);
    expect(readPreferences(storage)).toEqual({ markdownRendering: false, candidatePrompt: true });
    expect(storage.values[preferenceKey('markdownRendering')]).toBe('false');
    expect(storage.values[preferenceKey('candidatePrompt')]).toBe('true');
  });

  test('re-enabling a preference writes the stored value back', () => {
    const storage = memoryStorage();
    writePreference(storage, 'markdownRendering', false);
    writePreference(storage, 'markdownRendering', true);
    expect(storage.values[preferenceKey('markdownRendering')]).toBe('true');
    expect(readPreference(storage, 'markdownRendering')).toBe(true);
  });

  test('an unknown stored string falls back to the default', () => {
    const storage = memoryStorage({
      [preferenceKey('markdownRendering')]: 'yes',
      [preferenceKey('candidatePrompt')]: '1',
    });
    expect(readPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
  });

  test('an explicit stored value wins over the default', () => {
    const storage = memoryStorage({
      [preferenceKey('markdownRendering')]: 'false',
      [preferenceKey('candidatePrompt')]: 'true',
    });
    expect(readPreferences(storage)).toEqual({ markdownRendering: false, candidatePrompt: true });
  });
});

describe('blocked storage', () => {
  test('reads degrade to the defaults and writes never throw', () => {
    const blocked = blockedStorage();
    expect(readPreference(blocked, 'markdownRendering')).toBe(true);
    expect(readPreference(blocked, 'candidatePrompt')).toBe(false);
    expect(readPreferences(blocked)).toEqual(DEFAULT_PREFERENCES);
    expect(() => writePreference(blocked, 'markdownRendering', false)).not.toThrow();
    expect(() => writePreference(null, 'candidatePrompt', true)).not.toThrow();
  });
});
