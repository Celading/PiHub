export const FAVORITES_STORAGE_KEY = 'pi-panel:favorites';

export function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
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

export function persistFavorites(items: string[]): void {
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // storage unavailable
  }
}

/** Adds a prompt to the favorites list (used by the composer). */
export function addFavorite(text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return;
  }
  const next = [...loadFavorites().filter((item) => item !== trimmed), trimmed];
  persistFavorites(next);
}
