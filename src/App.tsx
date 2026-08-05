import { useEffect, useState } from 'react';
import type { Theme, View } from './types/app';
import { THEME_STORAGE_KEY } from './types/app';
import { AppShell } from './layout/AppShell';
import { ChatPage } from './pages/ChatPage';
import { SessionsPage } from './pages/SessionsPage';
import { StatsPage } from './pages/StatsPage';
import { SettingsPage } from './pages/SettingsPage';
import { CommandPalette } from './components/CommandPalette';
import { api } from './api/client.js';

export function App(): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'dark' ? 'dark' : 'light';
  });
  const [view, setView] = useState<View>('chat');
  const [chatSessionKey, setChatSessionKey] = useState(0);
  const [commandOpen, setCommandOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const renderPage = (): React.JSX.Element => {
    switch (view) {
      case 'chat':
        // key forces a remount after new/resume so the chat reloads the
        // switched RPC session's messages.
        return <ChatPage key={chatSessionKey} />;
      case 'sessions':
        return <SessionsPage />;
      case 'stats':
        return <StatsPage />;
      case 'settings':
        return (
          <SettingsPage
            onBack={() => {
              setView('chat');
            }}
          />
        );
    }
  };

  return (
    <AppShell
      view={view}
      theme={theme}
      onViewChange={setView}
      onSessionChanged={() => {
        setChatSessionKey(chatSessionKey + 1);
      }}
      onOpenCommands={() => {
        setCommandOpen(true);
      }}
      onThemeToggle={() => {
        setTheme(theme === 'light' ? 'dark' : 'light');
      }}
    >
      {renderPage()}
      <CommandPalette
        open={commandOpen}
        onClose={() => {
          setCommandOpen(false);
        }}
        onRun={(commandName) => {
          setCommandOpen(false);
          void (async () => {
            try {
              await api.prompt(`/${commandName}`);
              setChatSessionKey(chatSessionKey + 1);
              setView('chat');
            } catch {
              // The chat page surfaces backend errors through its own state.
            }
          })();
        }}
      />
    </AppShell>
  );
}
