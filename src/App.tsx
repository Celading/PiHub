import { useEffect, useState } from 'react';
import type { Theme, View } from './types/app';
import { THEME_STORAGE_KEY } from './types/app';
import { AppShell } from './layout/AppShell';
import { ChatPage } from './pages/ChatPage';
import { SessionsPage } from './pages/SessionsPage';
import { StatsPage } from './pages/StatsPage';
import { SettingsPage } from './pages/SettingsPage';

export function App(): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'dark' ? 'dark' : 'light';
  });
  const [view, setView] = useState<View>('chat');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const renderPage = (): React.JSX.Element => {
    switch (view) {
      case 'chat':
        return <ChatPage />;
      case 'sessions':
        return <SessionsPage />;
      case 'stats':
        return <StatsPage />;
      case 'settings':
        return <SettingsPage />;
    }
  };

  return (
    <AppShell
      view={view}
      theme={theme}
      onViewChange={setView}
      onThemeToggle={() => {
        setTheme(theme === 'light' ? 'dark' : 'light');
      }}
    >
      {renderPage()}
    </AppShell>
  );
}
