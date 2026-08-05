import { useEffect, useState } from 'react';

export const PREF_STORAGE_KEY = 'pi-panel:prefs';
export const PREF_CHANGED_EVENT = 'pihub:prefs-changed';

export type SendMode = 'enter' | 'cmd-enter' | 'ctrl-enter';
export type CommandKey = 'meta' | 'ctrl';

interface Prefs {
  sendMode: SendMode;
  cmdKey: CommandKey;
}

const PREFS_DEFAULTS: Prefs = {
  sendMode: 'enter',
  cmdKey: 'meta',
};

export function getPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_STORAGE_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        return {
          sendMode:
            record['sendMode'] === 'cmd-enter' || record['sendMode'] === 'ctrl-enter'
              ? record['sendMode']
              : 'enter',
          cmdKey: record['cmdKey'] === 'ctrl' ? 'ctrl' : 'meta',
        };
      }
    }
  } catch {
    // fall through to defaults
  }
  return PREFS_DEFAULTS;
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  try {
    const raw = localStorage.getItem(PREF_STORAGE_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }
    const record = parsed as Record<string, unknown>;
    record[key] = value;
    localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(record));
    window.dispatchEvent(new Event(PREF_CHANGED_EVENT));
  } catch {
    // storage unavailable
  }
}

/** Reactive preference read; re-syncs when the settings page changes it. */
export function usePref<K extends keyof Prefs>(key: K): Prefs[K] {
  const [value, setValue] = useState<Prefs[K]>(() => getPrefs()[key]);
  useEffect(() => {
    const sync = (): void => {
      setValue(getPrefs()[key]);
    };
    window.addEventListener(PREF_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener(PREF_CHANGED_EVENT, sync);
    };
  }, [key]);
  return value;
}
