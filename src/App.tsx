import { useCallback, useEffect, useState } from 'react';
import type { SettingsSectionId, Theme, View } from './types/app';
import { THEME_STORAGE_KEY } from './types/app';
import { AppShell } from './layout/AppShell';
import { ChatPage } from './pages/ChatPage';
import { SessionsPage } from './pages/SessionsPage';
import { StatsPage } from './pages/StatsPage';
import { SettingsPage } from './pages/SettingsPage';
import { CommandPalette } from './components/CommandPalette';
import { ExtensionUiHost } from './components/ExtensionUiHost';
import { useExtensionUi } from './extui/useExtensionUi.js';
import { api } from './api/client.js';
import { useSessionWatch } from './chat/sessionWatch.js';
import { usePref } from './prefs/preferences.js';

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
  const sessionWatch = useSessionWatch();
  const cmdKey = usePref('cmdKey');
  const extensionUi = useExtensionUi();

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
    } catch {
      // storage unavailable
    }
  }, [sidebarCollapsed]);

  // New session from the sessions empty-state CTA (L008 C-3).
  const handleNewSession = useCallback(async (): Promise<void> => {
    try {
      const response = await api.newSession();
      if (response.success) {
        setChatSessionKey((prev) => prev + 1);
        setView('chat');
      }
    } catch {
      // offline or idle; ignore
    }
  }, []);

  // Command (optionally Ctrl) + ArrowUp/Down cycles the session list.
  const switchSessionByOffset = useCallback(async (offset: number): Promise<void> => {
    try {
      const [list, state] = await Promise.all([api.sessions(), api.rpcState()]);
      const sessions = list.sessions;
      if (sessions.length === 0) {
        return;
      }
      const current = state.sessionFile;
      const index = sessions.findIndex((session) => session.fileName === current);
      const base = index === -1 ? 0 : index;
      const next = sessions[(base + offset + sessions.length) % sessions.length];
      if (next === undefined) {
        return;
      }
      const response = await api.switchSession(next.fileName);
      if (response.success) {
        setChatSessionKey((prev) => prev + 1);
        setView('chat');
      }
    } catch {
      // offline or idle; ignore
    }
  }, []);

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
      // Ctrl+Shift+L: cycle the model (pi RPC cycle_model); the chat page
      // refreshes its model display via the custom event.
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        void api.cycleModel().then((response) => {
          if (response.success) {
            window.dispatchEvent(new Event('pihub:model-cycled'));
          }
        });
        return;
      }
      if (event.key === 'Escape' && !commandOpen) {
        void api.abort().catch(() => {
          // offline or idle; ignore
        });
        return;
      }
      // Command (optional Ctrl) + ArrowUp/Down: switch session.
      const modDown =
        cmdKey === 'meta'
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey;
      if (modDown && !event.shiftKey && !event.altKey) {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          void switchSessionByOffset(event.key === 'ArrowUp' ? -1 : 1);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [commandOpen, cmdKey, switchSessionByOffset]);

  const renderPage = (): React.JSX.Element => {
    switch (view) {
      case 'chat':
        // key forces a remount after new/resume so the chat reloads the
        // switched RPC session's messages.
        return (
          <ChatPage
            key={chatSessionKey}
            onSessionChanged={() => {
              setChatSessionKey((prev) => prev + 1);
            }}
          />
        );
      case 'sessions':
        return (
          <SessionsPage
            onNewSession={() => {
              void handleNewSession();
            }}
          />
        );
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
      sessionFile={sessionWatch.sessionFile}
      sessionStatus={sessionWatch.status}
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
      <ExtensionUiHost ui={extensionUi} />
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
