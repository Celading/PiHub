export type View = 'chat' | 'sessions' | 'stats' | 'settings';

export type Theme = 'light' | 'dark';

/** Settings modal sections (phase-3: the global sidebar becomes the
 *  settings navigation tree while the settings view is active). */
export type SettingsSectionId =
  | 'general'
  | 'personal'
  | 'models'
  | 'sessions'
  | 'permissions'
  | 'favorites'
  | 'lab';

export const VIEW_LABELS: Record<View, string> = {
  chat: 'Chat',
  sessions: 'Sessions',
  stats: 'Stats',
  settings: 'Settings',
};

export const THEME_STORAGE_KEY = 'pi-panel:theme';
