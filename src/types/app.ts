export type View = 'chat' | 'sessions' | 'stats' | 'settings' | 'automation';

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
  automation: 'Automation',
};

export const THEME_STORAGE_KEY = 'pi-panel:theme';

/** Settings nav tree order (P1-17 F uses the index for slide direction). */
export const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSectionId;
  icon: string;
}> = [
  { id: 'general', icon: 'hico-gearshape' },
  { id: 'personal', icon: 'hico-sliders' },
  { id: 'models', icon: 'hico-cross-store' },
  { id: 'sessions', icon: 'hico-rectangle-stack' },
  { id: 'permissions', icon: 'hico-lock' },
  { id: 'favorites', icon: 'hico-bookmark' },
  { id: 'lab', icon: 'hico-flask' },
];
