import { useEffect, useState } from 'react';

export const LAB_STORAGE_KEY = 'pi-panel:lab';
export const LAB_CHANGED_EVENT = 'pihub:lab-changed';

export type LabFlag = 'streamAnimation' | 'compactTools' | 'settledNotify' | 'simplifiedOutput';

const LAB_DEFAULTS: Record<LabFlag, boolean> = {
  streamAnimation: true,
  compactTools: false,
  settledNotify: true,
  simplifiedOutput: false,
};

export function getLabFlag(flag: LabFlag): boolean {
  try {
    const raw = localStorage.getItem(LAB_STORAGE_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const value = (parsed as Record<string, unknown>)[flag];
        if (typeof value === 'boolean') {
          return value;
        }
      }
    }
  } catch {
    // fall through to default
  }
  return LAB_DEFAULTS[flag];
}

export function setLabFlag(flag: LabFlag, value: boolean): void {
  try {
    const raw = localStorage.getItem(LAB_STORAGE_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }
    const record = parsed as Record<string, unknown>;
    record[flag] = value;
    localStorage.setItem(LAB_STORAGE_KEY, JSON.stringify(record));
    window.dispatchEvent(new Event(LAB_CHANGED_EVENT));
  } catch {
    // storage unavailable
  }
}

/** Reactive lab flag: re-reads when the lab section toggles a switch. */
export function useLabFlag(flag: LabFlag): boolean {
  const [value, setValue] = useState<boolean>(() => getLabFlag(flag));
  useEffect(() => {
    const sync = (): void => {
      setValue(getLabFlag(flag));
    };
    window.addEventListener(LAB_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener(LAB_CHANGED_EVENT, sync);
    };
  }, [flag]);
  return value;
}
