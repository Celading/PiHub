import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../../shared/types.js';
import type { SettingsSectionId, View } from '../types/app.js';
import { api } from '../api/client.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { IconButton } from '../components/IconButton.js';
import './Sidebar.css';

const USER_ID_STORAGE_KEY = 'pi-panel:userId';
const COLLECTIONS_STORAGE_KEY = 'pi-panel:collections';
const ARCHIVED_STORAGE_KEY = 'pi-panel:archived';
const MAX_SESSIONS = 24;

interface SidebarProps {
  view: View;
  mode: 'primary' | 'settings';
  settingsSection: SettingsSectionId;
  onSettingsSectionChange: (section: SettingsSectionId) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onViewChange: (view: View) => void;
  onSessionChanged: () => void;
  onOpenCommands: () => void;
}

/** Settings modal tree: shown in the global sidebar while the settings
 *  view is active (phase-3 modal switch). */
const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSectionId;
  icon: string;
}> = [
  { id: 'general', icon: 'hico-gearshape' },
  { id: 'personal', icon: 'hico-sliders' },
  { id: 'models', icon: 'hico-square-grid' },
  { id: 'sessions', icon: 'hico-rectangle-stack' },
  { id: 'permissions', icon: 'hico-lock' },
  { id: 'favorites', icon: 'hico-bookmark' },
  { id: 'lab', icon: 'hico-flask' },
];

type MessageKey = Parameters<ReturnType<typeof useI18n>['t']>[0];

const SETTINGS_SECTION_LABELS: Record<SettingsSectionId, MessageKey> = {
  general: 'settings.nav.general',
  personal: 'settings.nav.personal',
  models: 'settings.nav.models',
  sessions: 'settings.nav.sessions',
  permissions: 'settings.nav.permissions',
  favorites: 'settings.nav.favorites',
  lab: 'settings.nav.lab',
};

function settingsSectionLabelKey(id: SettingsSectionId): MessageKey {
  return SETTINGS_SECTION_LABELS[id];
}

function formatTime(iso: string, intlTag: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat(intlTag, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter((part) => part.length > 0);
  if (parts.length <= 2) {
    return cwd;
  }
  return `${parts[0] ?? ''}/…/${parts[parts.length - 1] ?? ''}`;
}

function loadJson(key: string, fallback: string): string {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}

interface SessionRowProps {
  session: SessionSummary;
  intlTag: string;
  onOpen: (session: SessionSummary) => void;
  onClone: (session: SessionSummary) => void;
  onArchive: (session: SessionSummary) => void;
  t: (key: Parameters<ReturnType<typeof useI18n>['t']>[0], params?: Record<string, string | number>) => string;
}

function SessionRow({ session, intlTag, onOpen, onClone, onArchive, t }: SessionRowProps): React.JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null);

  return (
    <div
      className="sidebar-session-row"
      draggable
      onDragStart={(event) => {
        setDragId(session.id);
        event.dataTransfer.setData('text/plain', session.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => {
        setDragId(null);
      }}
      data-dragging={dragId === session.id}
    >
      <button
        type="button"
        className="sidebar-session-item"
        onClick={() => {
          onOpen(session);
        }}
        title={session.cwd}
      >
        <span className="sidebar-session-cwd mono">
          {session.name !== undefined && session.name.length > 0
            ? session.name
            : shortCwd(session.cwd)}
        </span>
        <span className="sidebar-session-meta mono">
          {String(session.messageCount)} {t('sidebar.msgs')} · {formatTime(session.lastActivityAt, intlTag)}
        </span>
      </button>
      <div className="sidebar-session-icons">
        <IconButton
          icon="hico-square-grid"
          label={t('sidebar.newBranch')}
          placement="bottom"
          onClick={() => {
            onClone(session);
          }}
        />
        <IconButton
          icon="hico-rectangle-stack"
          label={t('sidebar.archive')}
          placement="bottom"
          onClick={() => {
            onArchive(session);
          }}
        />
      </div>
    </div>
  );
}

export function Sidebar({
  view,
  mode,
  settingsSection,
  onSettingsSectionChange,
  collapsed,
  onToggleCollapsed,
  onViewChange,
  onSessionChanged,
  onOpenCommands,
}: SidebarProps): React.JSX.Element {
  const { t, intlTag } = useI18n();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [query, setQuery] = useState('');
  const [userId, setUserId] = useState<string>(() => {
    return localStorage.getItem(USER_ID_STORAGE_KEY) ?? 'guest';
  });
  const [editingUser, setEditingUser] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collections, setCollections] = useState<Record<string, string[]>>(() => {
    try {
      return JSON.parse(loadJson(COLLECTIONS_STORAGE_KEY, '{}')) as Record<string, string[]>;
    } catch {
      return {};
    }
  });
  const [archived, setArchived] = useState<string[]>(() => {
    try {
      const raw = loadJson(ARCHIVED_STORAGE_KEY, '[]');
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  });
  const [editingCollection, setEditingCollection] = useState<string | null>(null);
  const [collectionDraft, setCollectionDraft] = useState('');

  useEffect(() => {
    localStorage.setItem(COLLECTIONS_STORAGE_KEY, JSON.stringify(collections));
  }, [collections]);

  useEffect(() => {
    localStorage.setItem(ARCHIVED_STORAGE_KEY, JSON.stringify(archived));
  }, [archived]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await api.sessions();
        if (!cancelled) {
          setSessions(response.sessions.slice(0, MAX_SESSIONS));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return sessions;
    }
    return sessions.filter((session) => {
      return (
        session.cwd.toLowerCase().includes(needle) ||
        session.models.some((model) => model.toLowerCase().includes(needle))
      );
    });
  }, [sessions, query]);

  const byId = useMemo(() => {
    const map = new Map<string, SessionSummary>();
    for (const session of filtered) {
      map.set(session.id, session);
    }
    return map;
  }, [filtered]);

  const visible = useMemo(() => {
    return filtered.filter((session) => !archived.includes(session.id));
  }, [filtered, archived]);

  const inAnyCollection = useMemo(() => {
    const ids = new Set<string>();
    for (const list of Object.values(collections)) {
      for (const id of list) {
        ids.add(id);
      }
    }
    return ids;
  }, [collections]);

  const ungrouped = visible.filter((session) => !inAnyCollection.has(session.id));

  const collectionEntries = useMemo(() => {
    return Object.entries(collections)
      .map(([name, ids]) => ({
        name,
        sessions: ids
          .map((id) => byId.get(id))
          .filter((session): session is SessionSummary => session !== undefined),
      }));
  }, [collections, byId]);

  const handleNewSession = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const response = await api.newSession();
      if (!response.success) {
        setError(response.error ?? 'failed to start new session');
        return;
      }
      onSessionChanged();
      onViewChange('chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onSessionChanged, onViewChange]);

  const handleResume = useCallback(
    async (session: SessionSummary): Promise<void> => {
      setError(null);
      try {
        const response = await api.switchSession(session.fileName);
        if (!response.success) {
          setError(response.error ?? t('sessions.openSessionError'));
          return;
        }
        onSessionChanged();
        onViewChange('chat');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [onSessionChanged, onViewChange, t],
  );

  const handleClone = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const response = await api.cloneSession();
      if (!response.success) {
        setError(response.error ?? 'clone failed');
        return;
      }
      onSessionChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onSessionChanged]);

  const handleArchive = useCallback(
    (sessionId: string): void => {
      const next = archived.includes(sessionId) ? archived : [...archived, sessionId];
      setArchived(next);
      setCollections((prev) => {
        const updated: Record<string, string[]> = {};
        for (const [name, ids] of Object.entries(prev)) {
          updated[name] = ids.filter((id) => id !== sessionId);
        }
        return updated;
      });
      window.dispatchEvent(new CustomEvent('pihub:archived-changed', { detail: next }));
    },
    [archived],
  );

  // Re-read the archived list when the settings page restores a session
  // (the settings page stays open while this sidebar stays mounted).
  useEffect(() => {
    const syncArchived = (event: Event): void => {
      const detail = (event as CustomEvent<string[]>).detail;
      if (Array.isArray(detail)) {
        setArchived(detail);
      }
    };
    window.addEventListener('pihub:archived-changed', syncArchived);
    return () => {
      window.removeEventListener('pihub:archived-changed', syncArchived);
    };
  }, []);

  const addCollection = useCallback((): void => {
    setCollections((prev) => {
      const name = `collection-${String(Object.keys(prev).length + 1)}`;
      return { ...prev, [name]: [] };
    });
    setEditingCollection(`collection-${String(Object.keys(collections).length + 1)}`);
    setCollectionDraft('');
  }, [collections]);

  const renameCollection = useCallback((oldName: string, newName: string): void => {
    const trimmed = newName.trim();
    if (trimmed.length === 0) {
      setEditingCollection(null);
      return;
    }
    setCollections((prev) => {
      const next: Record<string, string[]> = {};
      for (const [name, ids] of Object.entries(prev)) {
        const target = name === oldName ? trimmed : name;
        next[target] = ids;
      }
      return next;
    });
    setEditingCollection(null);
  }, []);

  const deleteCollection = useCallback((name: string): void => {
    setCollections((prev) => {
      const next: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (key !== name) {
          next[key] = value;
        }
      }
      return next;
    });
  }, []);

  const dropIntoCollection = useCallback((collectionName: string, sessionId: string): void => {
    setCollections((prev) => {
      const current = prev[collectionName] ?? [];
      if (current.includes(sessionId)) {
        return prev;
      }
      return { ...prev, [collectionName]: [...current, sessionId] };
    });
  }, []);

  const saveUserId = (value: string): void => {
    const trimmed = value.trim();
    const next = trimmed.length === 0 ? 'guest' : trimmed;
    setUserId(next);
    localStorage.setItem(USER_ID_STORAGE_KEY, next);
    setEditingUser(false);
  };

  const sessionRowProps = {
    intlTag,
    onOpen: (session: SessionSummary) => {
      void handleResume(session);
    },
    onClone: () => {
      void handleClone();
    },
    onArchive: (session: SessionSummary) => {
      handleArchive(session.id);
    },
    t,
  };

  if (collapsed) {
    return (
      <nav className="sidebar sidebar-collapsed" aria-label="Sidebar collapsed">
        <button
          type="button"
          className="sidebar-collapse-expand"
          onClick={onToggleCollapsed}
          title={t('sidebar.expand')}
          aria-label={t('sidebar.expand')}
        >
          <span className="hico hico-chevron-right" aria-hidden="true" />
        </button>
        <span className="sidebar-collapse-mark" aria-hidden="true">
          π
        </span>
      </nav>
    );
  }

  if (mode === 'settings') {
    return (
      <nav className="sidebar" aria-label="Settings">
        <div className="sidebar-settings-head">
          <span className="sidebar-settings-title mono">{t('settings.title')}</span>
        </div>
        <hr className="swiss-rule" />
        <div className="sidebar-settings-tree scroll-area">
          {SETTINGS_SECTIONS.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              className="sidebar-settings-item"
              data-active={settingsSection === entry.id}
              onClick={() => {
                onSettingsSectionChange(entry.id);
              }}
            >
              <span className="sidebar-settings-number mono">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className={`hico ${entry.icon}`} aria-hidden="true" />
              <span>{t(settingsSectionLabelKey(entry.id))}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="sidebar-back-wide mono"
          onClick={() => {
            onViewChange('chat');
          }}
        >
          <span className="hico hico-arrow-left" aria-hidden="true" />
          <span>{t('settings.back')}</span>
        </button>
      </nav>
    );
  }

  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="sidebar-top">
        <button type="button" className="sidebar-new" onClick={() => { void handleNewSession(); }}>
          <span className="hico hico-plus" aria-hidden="true" />
          <span>{t('sidebar.new')}</span>
        </button>
        <div className="sidebar-search-wrap">
          <span className="hico hico-magnifyingglass sidebar-search-icon" aria-hidden="true" />
          <input
            className="sidebar-search"
            type="search"
            placeholder={t('sidebar.search')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            aria-label={t('sidebar.search')}
          />
        </div>
        <button
          type="button"
          className="sidebar-feature"
          title={t('sidebar.features')}
          onClick={onOpenCommands}
        >
          <span className="hico hico-bolt" aria-hidden="true" />
          <span className="hico hico-wand-stars" aria-hidden="true" />
          <span className="hico hico-rectangle-stack" aria-hidden="true" />
          <span>{t('sidebar.features')}</span>
        </button>
        {error !== null ? <div className="sidebar-error mono">{error}</div> : null}
      </div>

      <hr className="swiss-rule" />

      <div className="sidebar-sessions scroll-area">
        <div className="sidebar-section-row">
          <span className="sidebar-section-label swiss-section-label">{t('sidebar.sessions')}</span>
          <IconButton
            icon="hico-plus"
            label={t('sidebar.addCollection')}
            placement="bottom"
            onClick={addCollection}
          />
        </div>

        {collectionEntries.length > 0 ? (
          <div className="sidebar-collections">
            {collectionEntries.map((entry) => (
              <div
                key={entry.name}
                className="sidebar-collection"
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const id = event.dataTransfer.getData('text/plain');
                  if (id.length > 0) {
                    dropIntoCollection(entry.name, id);
                  }
                }}
              >
                <div className="sidebar-collection-head">
                  {editingCollection === entry.name ? (
                    <input
                      className="sidebar-collection-input mono"
                      value={collectionDraft}
                      autoFocus
                      placeholder={t('sidebar.collectionName')}
                      aria-label={t('sidebar.collectionName')}
                      onChange={(event) => {
                        setCollectionDraft(event.target.value);
                      }}
                      onBlur={() => {
                        renameCollection(entry.name, collectionDraft);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                          renameCollection(entry.name, collectionDraft);
                        }
                        if (event.key === 'Escape') {
                          setEditingCollection(null);
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="sidebar-collection-name mono"
                      onClick={() => {
                        setEditingCollection(entry.name);
                        setCollectionDraft(entry.name);
                      }}
                      title={t('sidebar.renameCollection')}
                    >
                      {entry.name}
                    </button>
                  )}
                  <IconButton
                    icon="hico-trash"
                    label={t('sidebar.deleteCollection')}
                    placement="bottom"
                    onClick={() => {
                      deleteCollection(entry.name);
                    }}
                  />
                </div>
                {entry.sessions.length === 0 ? (
                  <p className="sidebar-collection-empty mono">{t('sidebar.empty.search')}</p>
                ) : (
                  <ul className="sidebar-session-list">
                    {entry.sessions.map((session) => (
                      <li key={session.id}>
                        <SessionRow session={session} {...sessionRowProps} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        ) : null}

        <div className="sidebar-section-row">
          <span className="sidebar-section-label swiss-section-label">{t('sidebar.ungrouped')}</span>
        </div>
        {ungrouped.length === 0 ? (
          <p className="sidebar-empty mono">
            {query.length > 0 ? t('sidebar.empty.search') : t('sidebar.empty')}
          </p>
        ) : (
          <ul className="sidebar-session-list">
            {ungrouped.map((session) => (
              <li key={session.id}>
                <SessionRow session={session} {...sessionRowProps} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-footer-actions">
          <IconButton
            icon="hico-questionmark-circle"
            label={t('sidebar.help')}
            placement="bottom"
            disabled
          />
          <IconButton
            icon="hico-clock"
            label={t('sidebar.history')}
            placement="bottom"
            dataActive={view === 'sessions'}
            onClick={() => {
              onViewChange('sessions');
            }}
          />
          <IconButton
            icon="hico-square-grid"
            label={t('sidebar.stats')}
            placement="bottom"
            dataActive={view === 'stats'}
            onClick={() => {
              onViewChange('stats');
            }}
          />
        </div>
        <div className="sidebar-user">
          {editingUser ? (
            <input
              className="sidebar-user-input mono"
              defaultValue={userId}
              autoFocus
              aria-label={t('sidebar.user.id')}
              onBlur={(event) => {
                saveUserId(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  saveUserId((event.target as HTMLInputElement).value);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="sidebar-user-id"
              onClick={() => {
                setEditingUser(true);
              }}
              title={t('sidebar.user.id')}
            >
              <span className="sidebar-user-avatar" aria-hidden="true">
                {userId.slice(0, 1).toUpperCase()}
              </span>
              <span className="mono">{userId}</span>
            </button>
          )}
          <IconButton
            icon="hico-gearshape"
            label={t('sidebar.settings')}
            placement="bottom"
            dataActive={view === 'settings'}
            onClick={() => {
              onViewChange('settings');
            }}
          />
        </div>
      </div>
    </nav>
  );
}
