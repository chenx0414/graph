import { describe, expect, test } from 'vitest';
import { readPreference, readPreferences, writePreference, type PreferenceStorage } from '../../src/web/preferences.ts';

function blockedStorage(): PreferenceStorage {
  const fail = () => { throw new Error('storage blocked'); };
  return { getItem: fail, setItem: fail };
}

describe('blocked storage', () => {
  test('reads degrade to the defaults and writes never throw', () => {
    const blocked = blockedStorage();
    expect(readPreference(blocked, 'markdownRendering')).toBe(true);
    expect(readPreferences(blocked)).toEqual({ markdownRendering: true });
    expect(() => writePreference(blocked, 'markdownRendering', false)).not.toThrow();
    expect(() => writePreference(null, 'markdownRendering', true)).not.toThrow();
  });
});
