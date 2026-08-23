import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsSectionId, Theme, View } from './types/app';
import { nextTheme, THEME_STORAGE_KEY } from './types/app';
import { AppShell } from './layout/AppShell';
import { ChatPage } from './pages/ChatPage';
import { SessionsPage } from './pages/SessionsPage';
import { StatsPage } from './pages/StatsPage';
import { SettingsPage } from './pages/SettingsPage';
import { AutomationPage } from './pages/AutomationPage';
import { CommandPalette } from './components/CommandPalette';
import { ExtensionUiHost } from './components/ExtensionUiHost';
import { TabBar } from './components/TabBar';
import { useExtensionUi } from './extui/useExtensionUi.js';
import { api } from './api/client.js';
import { useSessionWatch } from './chat/sessionWatch.js';
import { usePref } from './prefs/preferences.js';
import { useI18n } from './i18n/I18nProvider.js';
import { findDraftTab, newTabId, type ChatTab } from './chat/tabs.js';
import type { SessionDraft } from './chat/sessionDraft.js';
import { NewSessionDialog, NEW_SESSION_REQUEST_EVENT } from './components/NewSessionDialog.js';
import { initPairFromUrl } from './api/pairToken.js';
import type { PanelAgent } from './chat/chatState.js';
import type { SessionSummary } from '../shared/types.js';
import { parseRoute, serializeRoute } from './router.js';
import './App.css';

const SIDEBAR_COLLAPSED_KEY = 'pi-panel:sidebar-collapsed';

function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function sessionLabel(session: SessionSummary): string {
  return session.name ?? session.fileName;
}

export function App(): React.JSX.Element {
  const { t } = useI18n();
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'dark' ? 'dark' : saved === 'fog' ? 'fog' : 'light';
  });
  // P1-09: the header toggle cycles light → dark → fog → light.
  const cycleTheme = useCallback((): void => {
    setTheme((current) => nextTheme(current));
  }, []);
  // Right workbench visibility — shared by the TabBar toggle and AppShell.
  const [rightOpen, setRightOpen] = useState(true);
  /** Claude transcript to render read-only in the chat (sidebar "open"). */
  const [claudeThread, setClaudeThread] = useState<{ sessionId: string; label: string } | null>(null);
  /** dsh session transcript opened from the sidebar (read-only). */
  const [dshThread, setDshThread] = useState<{ sessionId: string; label: string } | null>(null);
  const [view, setView] = useState<View>('chat');
  // Which agent the chat view talks to — pi (RPC), codex/claude (exec
  // adapters) or dsh (harness kernel). Default pi; fall back when the
  // backend does not expose the currently selected agent.
  const [agent, setAgent] = useState<PanelAgent>('pi');
  useEffect(() => {
    let cancelled = false;
    void api
      .adapters()
      .then((response) => {
        if (cancelled) {
          return;
        }
        const hasDsh = response.adapters.some((entry) => entry.kind === 'dsh');
        setAgent((current) => (current === 'dsh' && !hasDsh ? 'pi' : current));
      })
      .catch(() => {
        // offline — keep the current agent
      });
    return () => {
      cancelled = true;
    };
  }, []);
  /** Codex thread to resume when the chat opens in codex mode. */
  const [codexThread, setCodexThread] = useState<string | null>(null);
  // P1-06: the chat workspace is a tab strip; each tab binds one session
  // file (or null for the draft tab that follows the RPC's current session).
  const [tabs, setTabs] = useState<ChatTab[]>(() => [
    { id: newTabId(), sessionFile: null, label: '' },
  ]);
  const firstTab = tabs[0];
  const [activeTabId, setActiveTabId] = useState<string>(() => firstTab?.id ?? '');
  // Per-tab remount epochs: bumping the active tab's epoch reloads its chat
  // (the same remount semantics the app used for session switches before
  // tabs). Draft tabs keep binding null — they always mirror the current RPC
  // session.
  const [tabEpochs, setTabEpochs] = useState<Readonly<Record<string, number>>>({});
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

  // WelcomeView favorite-chip click: jump to settings → favorites.
  useEffect(() => {
    const handler = (): void => {
      setView('settings');
      setSettingsSection('favorites');
    };
    window.addEventListener('pihub:open-prompt-favorites', handler);
    return (): void => {
      window.removeEventListener('pihub:open-prompt-favorites', handler);
    };
  }, []);

  const bumpTab = useCallback((id: string): void => {
    setTabEpochs((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, []);

  /** Activate a tab: switch the RPC session first when the tab is bound to a
   *  different one, then remount its chat so it reloads that session. */
  const openTab = useCallback(
    async (tab: ChatTab): Promise<void> => {
      if (tab.sessionFile !== null) {
        const state = await api.rpcState().catch(() => null);
        if (state !== null && state.sessionFile !== tab.sessionFile) {
          const response = await api.switchSession(tab.sessionFile);
          if (!response.success) {
            return; // keep the current tab active on failure
          }
        }
      }
      setActiveTabId(tab.id);
      setView('chat');
      bumpTab(tab.id);
    },
    [bumpTab],
  );

  /** Sidebar session click: open the session in a tab, or switch to the tab
   *  that already holds it. */
  const openSessionTab = useCallback(
    async (fileName: string, label: string): Promise<void> => {
      const existing = tabs.find((tab) => tab.sessionFile === fileName);
      if (existing !== undefined) {
        await openTab(existing);
        return;
      }
      const tab: ChatTab = { id: newTabId(), sessionFile: fileName, label };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);
      setView('chat');
      bumpTab(tab.id);
    },
    [bumpTab, openTab, tabs],
  );

  /** "New chat" from anywhere: activate the draft tab (created on demand). */
  const newDraftTab = useCallback(async (): Promise<void> => {
    const draft = findDraftTab(tabs);
    if (draft !== undefined) {
      await openTab(draft);
      return;
    }
    const tab: ChatTab = { id: newTabId(), sessionFile: null, label: t('chat.tabs.new') };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    setView('chat');
    bumpTab(tab.id);
  }, [bumpTab, openTab, tabs, t]);

  /** Open a codex record from the sidebar: switch to codex and resume it. */
  const handleOpenCodexSession = useCallback(
    (threadId: string): void => {
      setCodexThread(threadId);
      setClaudeThread(null);
      setDshThread(null);
      setAgent('codex');
      void newDraftTab();
    },
    [newDraftTab],
  );

  /** Open a claude transcript from the sidebar in a labeled read-only tab. */
  const handleOpenClaudeSession = useCallback(
    (sessionId: string, label: string): void => {
      setClaudeThread({ sessionId, label });
      setDshThread(null);
      setAgent('pi');
      const tab: ChatTab = { id: newTabId(), sessionFile: null, label };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);
      setView('chat');
      bumpTab(tab.id);
    },
    [bumpTab],
  );

  /** Open a dsh session from the sidebar: switch to the dsh agent in a
   *  fresh chat tab (the dsh history itself lives in the sessions view). */
  const handleOpenDshSession = useCallback(
    (sessionId: string, label: string): void => {
      setClaudeThread(null);
      setDshThread({ sessionId, label });
      setAgent('dsh');
      const tab: ChatTab = { id: newTabId(), sessionFile: null, label };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);
      setView('chat');
      bumpTab(tab.id);
    },
    [bumpTab],
  );

  // Hash routing: the initial hash is captured before any effect writes, so
  // a refresh restores the view + selected session; state → hash sync only
  // starts AFTER the initial hydration completes (otherwise the default
  // state would clobber the incoming hash).
  const initialHashRef = useRef<string>(window.location.hash);
  const hydratedRef = useRef(false);

  /** Apply a route to the app state (initial load + hashchange). */
  const hydrateFromHash = useCallback(
    async (hash: string): Promise<void> => {
      const route = parseRoute(hash);
      if (route === null) {
        return;
      }
      if (route.view === 'chat') {
        if (route.kind === 'draft') {
          setAgent('pi');
          setClaudeThread(null);
          setDshThread(null);
          await newDraftTab();
        } else if (route.kind === 'pi') {
          setAgent('pi');
          setClaudeThread(null);
          setDshThread(null);
          const list = await api.sessions().catch(() => null);
          const found = list?.sessions.find((session) => session.fileName === route.sessionFile);
          await openSessionTab(
            route.sessionFile,
            found !== undefined ? sessionLabel(found) : route.sessionFile,
          );
        } else if (route.kind === 'codex') {
          handleOpenCodexSession(route.threadId);
        } else if (route.kind === 'claude') {
          handleOpenClaudeSession(route.sessionId, route.label);
        } else if (route.sessionId !== null) {
          // dsh transcript route.
          handleOpenDshSession(route.sessionId, route.label);
        } else {
          // dsh: fresh draft tab in the dsh agent.
          setClaudeThread(null);
          setDshThread(null);
          setAgent('dsh');
          await newDraftTab();
        }
        return;
      }
      setView(route.view);
      if (route.view === 'settings') {
        setSettingsSection(route.section);
      }
    },
    [handleOpenClaudeSession, handleOpenCodexSession, handleOpenDshSession, newDraftTab, openSessionTab],
  );

  // The hydrate handler is a useCallback over stateful helpers (tabs etc.),
  // so its identity changes on every tabs update — a mount effect depending
  // on it would RE-RUN hydration after the first sidebar interaction,
  // resetting the agent/thread state from the initial hash (owner-reported:
  // clicking a dsh session snapped back to #/chat with agent=pi). Keep the
  // mount effect one-shot and read the LATEST handler via a ref.
  const hydrateRef = useRef(hydrateFromHash);
  hydrateRef.current = hydrateFromHash;
  useEffect(() => {
    void hydrateRef.current(initialHashRef.current).finally(() => {
      hydratedRef.current = true;
    });
    const onHashChange = (): void => {
      void hydrateRef.current(window.location.hash);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []); // mount-only by design — hydrateRef keeps the handler fresh

  // Keep the address bar in sync with the app state (replaceState — no
  // history spam, no hashchange loop; manual edits still work via the
  // listener above).
  useEffect(() => {
    if (!hydratedRef.current) {
      return;
    }
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    const target = serializeRoute({
      view,
      agent,
      codexThread,
      claudeThread,
      dshThread,
      sessionFile: activeTab?.sessionFile ?? null,
      settingsSection,
    });
    if (target !== window.location.hash) {
      window.history.replaceState(null, '', target);
    }
  }, [view, agent, codexThread, claudeThread, dshThread, tabs, activeTabId, settingsSection]);

  /** Close a tab; never leave the workspace tabless (fresh draft tab). */
  const closeTab = useCallback(
    (id: string): void => {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index === -1) {
        return;
      }
      const remaining = tabs.filter((tab) => tab.id !== id);
      if (id === activeTabId) {
        // Transcript identity is app-level for historical compatibility, so
        // closing its tab must clear it before the replacement draft renders.
        setClaudeThread(null);
        setDshThread(null);
        setCodexThread(null);
        setAgent('pi');
      }
      if (remaining.length === 0) {
        const fresh: ChatTab = { id: newTabId(), sessionFile: null, label: t('chat.tabs.new') };
        setTabs([fresh]);
        setActiveTabId(fresh.id);
        return;
      }
      setTabs(remaining);
      if (id === activeTabId) {
        const neighbor = remaining[Math.min(index, remaining.length - 1)];
        if (neighbor !== undefined) {
          setActiveTabId(neighbor.id);
        }
      }
    },
    [activeTabId, tabs, t],
  );

  // New session from the sessions empty-state CTA (L008 C-3) — opens the
  // targeting dialog (folder + agent) instead of creating directly.
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const handleNewSession = useCallback((): void => {
    setNewSessionOpen(true);
  }, []);

  // Any new-session request (sidebar button etc.) opens the same dialog.
  // Distributed mode: a remote-open URL may carry ?pair= — adopt it before
  // any API call so the pairing code is presented everywhere.
  useEffect(() => {
    initPairFromUrl();
  }, []);

  useEffect(() => {
    const onRequest = (): void => {
      setNewSessionOpen(true);
    };
    window.addEventListener(NEW_SESSION_REQUEST_EVENT, onRequest);
    return () => {
      window.removeEventListener(NEW_SESSION_REQUEST_EVENT, onRequest);
    };
  }, []);

  const handleNewSessionCreated = useCallback(
    async (meta: SessionDraft): Promise<void> => {
      const response = await api.newSession({ cwd: meta.cwd, agent: meta.agent, serviceTarget: meta.serviceTarget });
      if (!response.success) {
        throw new Error(response.error ?? 'failed to start new session');
      }
      if (meta.agent === 'codex') {
        setAgent('codex');
      } else if (meta.agent === 'dsh') {
        setAgent('dsh');
      } else if (meta.agent === 'claude') {
        setAgent('claude');
      } else {
        setAgent('pi');
      }
      setNewSessionOpen(false);
      await newDraftTab();
    },
    [newDraftTab],
  );

  // The RPC session may have changed under the active tab (fork/steer):
  // reload its chat and keep the tab binding + label fresh.
  const handleChatSessionChanged = useCallback((): void => {
    bumpTab(activeTabId);
    void (async () => {
      try {
        const [state, list] = await Promise.all([api.rpcState(), api.sessions()]);
        const byFile = new Map<string, string>(
          list.sessions.map((session) => [session.fileName, sessionLabel(session)]),
        );
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== activeTabId || tab.sessionFile === null) {
              return tab;
            }
            const current = state.sessionFile ?? tab.sessionFile;
            return { ...tab, sessionFile: current, label: byFile.get(current) ?? tab.label };
          }),
        );
      } catch {
        // offline or idle; keep the previous binding/label
      }
    })();
  }, [activeTabId, bumpTab]);

  // Command (optionally Ctrl) + ArrowUp/Down cycles the session list; the
  // target session opens in a tab like a sidebar click.
  const switchSessionByOffset = useCallback(
    async (offset: number): Promise<void> => {
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
          await openSessionTab(next.fileName, sessionLabel(next));
        }
      } catch {
        // offline or idle; ignore
      }
    },
    [openSessionTab],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  // Global shortcuts: Esc=abort (when no modal is open), Ctrl+Shift+M=
  // command palette, Alt+1..5=view switch.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const viewNumber = Number(event.key);
        if (viewNumber >= 1 && viewNumber <= 5) {
          const views: View[] = ['chat', 'sessions', 'stats', 'settings', 'automation'];
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
      case 'chat': {
        const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
        if (active === undefined) {
          return <ChatPage agent={agent} onSessionChanged={handleChatSessionChanged} />;
        }
        const epoch = tabEpochs[active.id] ?? 0;
        return (
          <div className="chat-view">
            <TabBar
              tabs={tabs}
              activeId={active.id}
              rightOpen={rightOpen}
              onToggleRight={() => {
                setRightOpen((value) => !value);
              }}
              onSelect={(id) => {
                const tab = tabs.find((item) => item.id === id);
                if (tab !== undefined) {
                  void openTab(tab);
                }
              }}
              onClose={closeTab}
              onNew={() => {
                void newDraftTab();
              }}
            />
            {/* key remounts the chat whenever the tab, its epoch or the
                agent changes — each combination gets a clean message list. */}
            <ChatPage
              key={`${active.id}:${String(epoch)}:${agent}:${codexThread ?? ''}:${claudeThread?.sessionId ?? ''}:${dshThread?.sessionId ?? ''}`}
              agent={agent}
              codexThread={codexThread}
              claudeThread={claudeThread}
              dshThread={dshThread}
              pendingApprovals={extensionUi.dialogs.length}
              onSessionChanged={handleChatSessionChanged}
            />
          </div>
        );
      }
      case 'sessions':
        return (
          <SessionsPage
            onNewSession={() => {
              handleNewSession();
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
            onThemeChange={setTheme}
            sidebarCollapsed={sidebarCollapsed}
            onToggleCollapsed={() => {
              setSidebarCollapsed(!sidebarCollapsed);
            }}
            onBack={() => {
              setView('chat');
            }}
          />
        );
      case 'automation':
        return <AutomationPage />;
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
      requestPending={extensionUi.dialogs.length > 0}
      onViewChange={setView}
      onSessionChanged={(fileName, label) => {
        if (fileName === undefined) {
          handleChatSessionChanged();
        } else if (fileName === null) {
          void newDraftTab();
        } else {
          void openSessionTab(fileName, label ?? fileName);
        }
      }}
      onThemeToggle={cycleTheme}
      agent={agent}
      rightOpen={rightOpen}
      onToggleRight={() => {
        setRightOpen((value) => !value);
      }}
      onOpenCodexSession={handleOpenCodexSession}
      onOpenClaudeSession={handleOpenClaudeSession}
      onOpenDshSession={handleOpenDshSession}
    >
      {/* P1-17 F: each view switch replays the 3D entry (perspective
          rotateY) + rise-from-below with fade. */}
      <div key={view} className="shell-page-enter">
        {renderPage()}
      </div>
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
              bumpTab(activeTabId);
              setView('chat');
            } catch {
              // The chat page surfaces backend errors through its own state.
            }
          })();
        }}
      />
      <NewSessionDialog
        open={newSessionOpen}
        onClose={() => {
          setNewSessionOpen(false);
        }}
        onCreated={async (meta) => {
          await handleNewSessionCreated(meta);
        }}
      />
    </AppShell>
  );
}
