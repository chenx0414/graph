/**
 * Local display preferences for the console.
 *
 * Preferences live in the browser (`localStorage`, key prefix `graph-pref-`),
 * never in the server config: they change rendering only and need no daemon
 * round-trip. Every read degrades to the documented default when storage is
 * missing or blocked, so the console keeps working in a locked-down host.
 */

import { useCallback, useEffect, useState } from 'react';
import './preferences.css';

/** All preference keys share this prefix so they are easy to spot in storage. */
export const PREFERENCES_PREFIX = 'graph-pref-';

export interface Preferences {
  /** Render user and agent messages as Markdown. Default on. */
  markdownRendering: boolean;
  /** Show the suggested next prompt in an empty composer. Default off. */
  candidatePrompt: boolean;
}

export type PreferenceName = keyof Preferences;

export const DEFAULT_PREFERENCES: Preferences = {
  markdownRendering: true,
  candidatePrompt: false,
};

const STORAGE_KEYS: Record<PreferenceName, string> = {
  markdownRendering: `${PREFERENCES_PREFIX}markdown-rendering`,
  candidatePrompt: `${PREFERENCES_PREFIX}candidate-prompt`,
};

/** Dispatched on `window` after a preference changes in this tab. */
export const PREFERENCES_EVENT = 'graph:preferences-changed';

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function preferenceKey(name: PreferenceName): string {
  return STORAGE_KEYS[name];
}

/** A stored preference, or its default when absent/invalid/unreadable. */
export function readPreference(storage: PreferenceStorage | null | undefined, name: PreferenceName): boolean {
  try {
    const value = storage?.getItem(preferenceKey(name)) ?? null;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return DEFAULT_PREFERENCES[name];
  } catch {
    return DEFAULT_PREFERENCES[name];
  }
}

export function writePreference(
  storage: PreferenceStorage | null | undefined,
  name: PreferenceName,
  value: boolean,
): void {
  try {
    storage?.setItem(preferenceKey(name), value ? 'true' : 'false');
  } catch {
    // A full or blocked storage must never break the console.
  }
}

export function readPreferences(storage: PreferenceStorage | null | undefined): Preferences {
  return {
    markdownRendering: readPreference(storage, 'markdownRendering'),
    candidatePrompt: readPreference(storage, 'candidatePrompt'),
  };
}

/** `window.localStorage` can throw when the host blocks storage. */
function browserStorage(): PreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Persist one preference and notify other components in this tab. */
export function setPreference(name: PreferenceName, value: boolean): void {
  writePreference(browserStorage(), name, value);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PREFERENCES_EVENT));
}

/**
 * Read and update the local preferences. The component re-reads storage on the
 * local change event and on cross-tab `storage` events, so a toggle in the
 * settings page applies without a reload.
 */
export function usePreferences(): {
  preferences: Preferences;
  update: (name: PreferenceName, value: boolean) => void;
} {
  const [preferences, setPreferences] = useState<Preferences>(() => readPreferences(browserStorage()));
  useEffect(() => {
    const sync = () => setPreferences(readPreferences(browserStorage()));
    window.addEventListener(PREFERENCES_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PREFERENCES_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const update = useCallback((name: PreferenceName, value: boolean) => {
    setPreference(name, value);
    setPreferences(readPreferences(browserStorage()));
  }, []);
  return { preferences, update };
}
