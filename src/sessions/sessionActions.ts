export const ARCHIVED_STORAGE_KEY = 'pi-panel:archived';

export function loadArchivedIds(): string[] {
  try {
    const raw = localStorage.getItem(ARCHIVED_STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function persistArchivedIds(ids: string[]): void {
  try {
    localStorage.setItem(ARCHIVED_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // storage unavailable — restore still works for this session
  }
}

/** Archives a session file: removes it from the sidebar and collections,
 *  keeps it restorable from settings. Notifies other components. */
export function archiveSession(fileName: string): void {
  const next = [...loadArchivedIds().filter((id) => id !== fileName), fileName];
  persistArchivedIds(next);
  window.dispatchEvent(new CustomEvent('pihub:archived-changed', { detail: next }));
}

/** Restores an archived session file; notifies other components. */

/** Removes a session id from the archived list (used after deletion). */
export function removeArchived(fileName: string): void {
  const next = loadArchivedIds().filter((id) => id !== fileName);
  persistArchivedIds(next);
  window.dispatchEvent(new CustomEvent('pihub:archived-changed', { detail: next }));
}

export function restoreSession(fileName: string): void {
  const next = loadArchivedIds().filter((id) => id !== fileName);
  persistArchivedIds(next);
  window.dispatchEvent(new CustomEvent('pihub:archived-changed', { detail: next }));
}
