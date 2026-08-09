/**
 * P2-01 D: adapter appearance — per-adapter accent colors, persisted in
 * localStorage. The UI uses these to distinguish agent backends (pi vs
 * codex) in session lists and message streams.
 */

const STORAGE_KEY = 'pi-panel:adapter-colors';

export interface AdapterInfo {
  kind: string;
  label: string;
  version: string | null;
  defaultColor: string;
}

const DEFAULTS: Record<string, string> = {
  pi: '#005fb8',
  codex: '#10a37f',
};

export function loadAdapterColors(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return { ...DEFAULTS };
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...DEFAULTS };
    }
    const out: Record<string, string> = { ...DEFAULTS };
    for (const [kind, color] of Object.entries(parsed)) {
      if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
        out[kind] = color;
      }
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAdapterColor(kind: string, color: string): void {
  const next = { ...loadAdapterColors(), [kind]: color };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable — colors fall back to defaults for this session
  }
}
