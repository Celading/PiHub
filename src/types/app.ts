export type View = 'chat' | 'sessions' | 'stats' | 'settings' | 'automation';

export type Theme = 'light' | 'dark' | 'fog';

/** Settings modal sections (phase-3: the global sidebar becomes the
 *  settings navigation tree while the settings view is active). */
export type SettingsSectionId =
  | 'general'
  | 'personal'
  | 'piAgent'
  | 'models'
  | 'sessions'
  | 'permissions'
  | 'favorites'
  | 'systemPrompt'
  | 'lab'
  | 'about';

export const VIEW_LABELS: Record<View, string> = {
  chat: 'Chat',
  sessions: 'Sessions',
  stats: 'Stats',
  settings: 'Settings',
  automation: 'Automation',
};

export const THEME_STORAGE_KEY = 'pi-panel:theme';

/** P1-09: theme registry — fog keeps the light body and adds the fog
 *  loading/condensing motion. The header toggle cycles through these. */
export const THEMES: ReadonlyArray<{ id: Theme; labelKey: string }> = [
  { id: 'light', labelKey: 'theme.light' },
  { id: 'dark', labelKey: 'theme.dark' },
  { id: 'fog', labelKey: 'theme.fog' },
];

export function nextTheme(theme: Theme): Theme {
  const index = THEMES.findIndex((item) => item.id === theme);
  const next = THEMES[(index + 1) % THEMES.length];
  return next?.id ?? 'light';
}

/** Settings nav tree order (P1-17 F uses the index for slide direction). */
export const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSectionId;
  icon: string;
}> = [
  { id: 'general', icon: 'hico-gearshape' },
  { id: 'personal', icon: 'hico-sliders' },
  { id: 'piAgent', icon: 'hico-bolt' },
  { id: 'models', icon: 'hico-cross-store' },
  { id: 'sessions', icon: 'hico-rectangle-stack' },
  { id: 'permissions', icon: 'hico-lock' },
  { id: 'favorites', icon: 'hico-bookmark' },
  { id: 'systemPrompt', icon: 'hico-doc-text' },
  { id: 'lab', icon: 'hico-flask' },
  { id: 'about', icon: 'hico-questionmark-circle' },
];
