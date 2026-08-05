export type View = 'chat' | 'sessions' | 'stats' | 'settings';

export type Theme = 'light' | 'dark';

export const VIEW_LABELS: Record<View, string> = {
  chat: 'Chat',
  sessions: 'Sessions',
  stats: 'Stats',
  settings: 'Settings',
};

export const THEME_STORAGE_KEY = 'pi-panel:theme';
