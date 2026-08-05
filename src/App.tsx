import { useEffect, useState } from 'react';
import type { SettingsSectionId, Theme, View } from './types/app';
import { THEME_STORAGE_KEY } from './types/app';
import { AppShell } from './layout/AppShell';
import { ChatPage } from './pages/ChatPage';
import { SessionsPage } from './pages/SessionsPage';
import { StatsPage } from './pages/StatsPage';
import { SettingsPage } from './pages/SettingsPage';
import { CommandPalette } from './components/CommandPalette';
import { api } from './api/client.js';

const SIDEBAR_COLLAPSED_KEY = 'pi-panel:sidebar-collapsed';

function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function App(): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'dark' ? 'dark' : 'light';
  });
  const [view, setView] = useState<View>('chat');
  const [chatSessionKey, setChatSessionKey] = useState(0);
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('general');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    loadSidebarCollapsed(),
  );

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
    } catch {
      // storage unavailable
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  // Global shortcuts: Esc=abort (when no modal is open), Ctrl+Shift+M=
  // command palette, Alt+1..4=view switch.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const viewNumber = Number(event.key);
        if (viewNumber >= 1 && viewNumber <= 4) {
          const views: View[] = ['chat', 'sessions', 'stats', 'settings'];
          const target = views[viewNumber - 1];
          if (target !== undefined) {
            event.preventDefault();
            setView(target);
          }
        }
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (event.key === 'Escape' && !commandOpen) {
        void api.abort().catch(() => {
          // offline or idle; ignore
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [commandOpen]);

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
            section={settingsSection}
            onSectionChange={setSettingsSection}
            theme={theme}
            onThemeToggle={() => {
              setTheme(theme === 'light' ? 'dark' : 'light');
            }}
            sidebarCollapsed={sidebarCollapsed}
            onToggleCollapsed={() => {
              setSidebarCollapsed(!sidebarCollapsed);
            }}
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
      settingsSection={settingsSection}
      onSettingsSectionChange={setSettingsSection}
      sidebarCollapsed={sidebarCollapsed}
      onToggleCollapsed={() => {
        setSidebarCollapsed(!sidebarCollapsed);
      }}
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
