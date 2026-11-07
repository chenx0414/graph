/// <reference types="vite/client" />

import { useCallback, useEffect, useState } from 'react';
import './preferences.css';

const PREFERENCES_PREFIX = 'graph-pref-';

export interface Preferences {
  markdownRendering: boolean;
}

type PreferenceName = keyof Preferences;

const DEFAULT_PREFERENCES: Preferences = {
  markdownRendering: true,
};

const STORAGE_KEYS: Record<PreferenceName, string> = {
  markdownRendering: `${PREFERENCES_PREFIX}markdown-rendering`,
};

const PREFERENCES_EVENT = 'graph:preferences-changed';

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function preferenceKey(name: PreferenceName): string {
  return STORAGE_KEYS[name];
}

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
  }
}

export function readPreferences(storage: PreferenceStorage | null | undefined): Preferences {
  return {
    markdownRendering: readPreference(storage, 'markdownRendering'),
  };
}


export function markdownEnabled(preferences: Preferences): boolean {
  return preferences.markdownRendering;
}

function browserStorage(): PreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function setPreference(name: PreferenceName, value: boolean): void {
  writePreference(browserStorage(), name, value);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PREFERENCES_EVENT));
}

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
