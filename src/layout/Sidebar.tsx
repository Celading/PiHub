import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '../../shared/types.js';
import { SETTINGS_SECTIONS, type SettingsSectionId, type View } from '../types/app.js';
import type { SessionStatus } from '../chat/sessionWatch.js';
import { api } from '../api/client.js';
import type { CodexSessionMeta } from '../../server/adapters/codex-history.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { IconButton } from '../components/IconButton.js';
import { ContextMenu } from '../components/ContextMenu.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { archiveSession, removeArchived } from '../sessions/sessionActions.js';
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
  sessionFile: string | null;
  sessionStatus: SessionStatus;
  /** P1-17 E: an agent request (e.g. pending dialog) is waiting — the
   *  active session's dot blinks even while it is the current session. */
  requestPending: boolean;
  onViewChange: (view: View) => void;
  /** P1-06: the RPC session changed — report the target so the app can open
   *  or switch a chat tab. null = new/current session (draft tab); a file
   *  name = open that session; undefined = rebind the active tab only. */
  onSessionChanged: (fileName?: string | null, label?: string) => void;
  /** Open a codex record in the codex chat (switch agent + resume thread). */
  onOpenCodexSession: (threadId: string, label: string) => void;
}

type MessageKey = Parameters<ReturnType<typeof useI18n>['t']>[0];

/** Agents whose sessions converge in the sidebar (default: all shown). */
type SidebarAgent = 'pi' | 'codex' | 'atomcode' | 'zcode';

const AGENT_GLYPHS: Record<SidebarAgent, string> = {
  pi: 'π',
  codex: '⌘',
  atomcode: 'A',
  zcode: 'Z',
};

/** One unified sidebar row across every agent's session records. */
interface AgentSessionRow {
  key: string;
  agent: SidebarAgent;
  /** Grouping unit (folder): cwd for pi/codex, empty for record-only agents. */
  cwd: string;
  label: string;
  messageCount: number;
  lastActivityAt: string;
  status: SessionStatus;
  /** Original record (SessionSummary / CodexSessionMeta / ...). */
  target: unknown;
}

const SETTINGS_SECTION_LABELS: Record<SettingsSectionId, MessageKey> = {
  general: 'settings.nav.general',
  personal: 'settings.nav.personal',
  models: 'settings.nav.models',
  sessions: 'settings.nav.sessions',
  permissions: 'settings.nav.permissions',
  favorites: 'settings.nav.favorites',
  lab: 'settings.nav.lab',
  about: 'settings.nav.about',
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

/** Session alias (P1-13 B): traditional style — the last folder name. */
function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? cwd;
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
  row: AgentSessionRow;
  intlTag: string;
  active: boolean;
  status: SessionStatus;
  /** P1-17 E: session has unseen activity (dot shown); read hides it. */
  unread: boolean;
  /** P1-17 E: the agent has a pending request for this session — blink. */
  blink: boolean;
  onOpen: (row: AgentSessionRow) => void;
  onContextMenu: (event: React.MouseEvent, row: AgentSessionRow) => void;
  /** Codex record imported ("录入") into the 会话 area — show a pin. */
  imported: boolean;
  t: ReturnType<typeof useI18n>['t'];
}

function SessionRow({
  row,
  intlTag,
  active,
  status,
  unread,
  blink,
  onOpen,
  onContextMenu,
  imported,
  t,
}: SessionRowProps): React.JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null);

  const statusLabel =
    status === 'running'
      ? t('session.status.running')
      : status === 'aborted'
        ? t('session.status.aborted')
        : status === 'pending'
          ? t('session.status.pending')
          : t('session.status.done');

  // P1-17 E: dot shows for unseen sessions; the active session hides it
  // unless it is busy or has a pending agent request (blink). The dot sits
  // on the RIGHT of the row (agent badge on the left), space-between.
  const showDot =
    row.agent === 'pi' && (active ? status !== 'done' || blink : unread || status === 'running');

  return (
    <div
      className="sidebar-session-row"
      data-active={active}
      draggable={row.agent === 'pi'}
      onDragStart={(event) => {
        setDragId(row.key);
        event.dataTransfer.setData('text/plain', row.key);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => {
        setDragId(null);
      }}
      data-dragging={dragId === row.key}
    >
      <button
        type="button"
        className="sidebar-session-item"
        onClick={() => {
          onOpen(row);
        }}
        onContextMenu={(event) => {
          onContextMenu(event, row);
        }}
        title={row.cwd.length > 0 ? row.cwd : row.label}
      >
        <span className="sidebar-session-head">
          <span className="agent-badge" data-agent={row.agent} aria-hidden="true">
            {AGENT_GLYPHS[row.agent]}
          </span>
          <span className="sidebar-session-cwd mono">{row.label}</span>
          {imported ? (
            <span className="agent-pin" title={t('sidebar.imported')}>
              ✓
            </span>
          ) : null}
        </span>
        <span className="sidebar-session-meta mono">
          <span>
            {String(row.messageCount)} {t('sidebar.msgs')} ·{' '}
            {formatTime(row.lastActivityAt, intlTag)}
          </span>
          {showDot ? (
            <span
              className="session-status-dot"
              data-status={status}
              data-blink={blink}
              title={blink ? t('session.status.request') : statusLabel}
              aria-label={blink ? t('session.status.request') : statusLabel}
            />
          ) : null}
        </span>
      </button>
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
  sessionFile,
  sessionStatus,
  requestPending,
  onViewChange,
  onSessionChanged,
  onOpenCodexSession,
}: SidebarProps): React.JSX.Element {
  const { t, intlTag } = useI18n();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** All-agent rows (pi + codex + atomcode + zcode) converged in one list. */
  const [agentRows, setAgentRows] = useState<AgentSessionRow[]>(() => []);
  /** Sidebar filter: 'all' shows every agent's records (default). */
  const [agentFilter, setAgentFilter] = useState<'all' | SidebarAgent>('all');
  /** Codex records "录入" (imported) from the history page — pinned on top. */
  const [importedCodex, setImportedCodex] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('pi-panel:codex-imported');
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    const sync = (): void => {
      try {
        const raw = localStorage.getItem('pi-panel:codex-imported');
        const parsed: unknown = raw === null ? [] : JSON.parse(raw);
        setImportedCodex(
          Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [],
        );
      } catch {
        // storage unavailable
      }
    };
    window.addEventListener('pihub:codex-imported-changed', sync);
    return () => {
      window.removeEventListener('pihub:codex-imported-changed', sync);
    };
  }, []);
  const [query, setQuery] = useState('');
  const [userId, setUserId] = useState<string>(() => {
    return localStorage.getItem(USER_ID_STORAGE_KEY) ?? 'guest';
  });
  const [editingUser, setEditingUser] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    session: SessionSummary;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
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
  /** P1-deletefix: bumped after a deletion so the session list reloads. */
  const [deleteTick, setDeleteTick] = useState(0);
  const [editingCollection, setEditingCollection] = useState<string | null>(null);
  const [collectionDraft, setCollectionDraft] = useState('');
  // P1-17 D: optimistic highlight while switch_session is in flight.
  const [pendingActive, setPendingActive] = useState<string | null>(null);

  // P1-17 E: per-session read watermark (localStorage), so the status dot
  // shows unseen sessions and hides read ones.
  const markRead = useCallback((fileName: string): void => {
    try {
      localStorage.setItem(`pi-panel:read-at:${fileName}`, new Date().toISOString());
    } catch {
      // storage unavailable — unread tracking degrades to always-visible
    }
  }, []);
  const isUnread = useCallback((session: SessionSummary): boolean => {
    try {
      const raw = localStorage.getItem(`pi-panel:read-at:${session.fileName}`);
      const read = raw === null ? 0 : Date.parse(raw);
      const lastActivity = Date.parse(session.lastActivityAt);
      return Number.isFinite(read) && Number.isFinite(lastActivity) && lastActivity > read;
    } catch {
      return false;
    }
  }, []);

  // Switching to a session marks it read; the optimistic highlight clears
  // once the authoritative sessionFile catches up.
  useEffect(() => {
    if (sessionFile !== null) {
      markRead(sessionFile);
      setPendingActive((prev) => (prev !== null && prev === sessionFile ? null : prev));
    }
  }, [sessionFile, markRead]);

  useEffect(() => {
    localStorage.setItem(COLLECTIONS_STORAGE_KEY, JSON.stringify(collections));
  }, [collections]);

  useEffect(() => {
    localStorage.setItem(ARCHIVED_STORAGE_KEY, JSON.stringify(archived));
  }, [archived]);

  // Backfill convergence: the fast codex list returns placeholders for
  // older records; refresh once after the async backfill settles so the
  // sidebar converges to full data.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDeleteTick((prev) => prev + 1);
    }, 2500);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        // Multi-agent convergence: pi sessions + codex rollout records +
        // atomcode history + zcode model-I/O records, unified into rows.
        const [pi, codex, atomcode, zcode] = await Promise.all([
          api.sessions().catch(() => null),
          api.codexSessions().catch(() => null),
          api.atomcodeSession().catch(() => null),
          api.zcodeSessions().catch(() => null),
        ]);
        if (cancelled) {
          return;
        }
        const rows: AgentSessionRow[] = [];
        for (const session of (pi?.sessions ?? []).slice(0, MAX_SESSIONS)) {
          rows.push({
            key: `pi:${session.id}`,
            agent: 'pi',
            cwd: session.cwd,
            label:
              session.name !== undefined && session.name.length > 0
                ? session.name
                : shortCwd(session.cwd),
            messageCount: session.messageCount,
            lastActivityAt: session.lastActivityAt,
            status: statusOf(session),
            target: session,
          });
        }
        for (const meta of codex?.sessions ?? []) {
          rows.push({
            key: `codex:${meta.sessionId}`,
            agent: 'codex',
            cwd: meta.cwd,
            label: shortCwd(meta.cwd),
            messageCount: meta.messageCount,
            lastActivityAt: meta.lastActivityAt,
            status: 'done',
            target: meta,
          });
        }
        if (atomcode?.session !== null && atomcode?.session !== undefined) {
          rows.push({
            key: `atomcode:${atomcode.session.id}`,
            agent: 'atomcode',
            cwd: '',
            label:
              atomcode.session.lastText.length > 0
                ? atomcode.session.lastText.slice(0, 24)
                : 'AtomCode',
            messageCount: atomcode.session.messageCount,
            lastActivityAt: atomcode.session.startedAt,
            status: 'done',
            target: atomcode.session,
          });
        }
        for (const meta of zcode?.sessions ?? []) {
          rows.push({
            key: `zcode:${meta.sessionId}`,
            agent: 'zcode',
            cwd: '',
            label: meta.modelId.length > 0 ? meta.modelId : 'ZCode',
            messageCount: meta.turns,
            lastActivityAt: meta.completedAt,
            status: 'done',
            target: meta,
          });
        }
        rows.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
        setAgentRows(rows);
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
    // P1-17 E: refresh on status transitions so lastActivityAt stays fresh
    // enough for the unread watermark.
    // P1-deletefix: also reload after a deletion, since removing a session
    // file does not emit any pi SSE status change.
  }, [sessionStatus, deleteTick]); // eslint-disable-line react-hooks/exhaustive-deps -- statusOf is a stable in-component helper


  // P1-13 B: new sessions auto-join a collection named after their cwd
  // folder (created on demand). Existing sessions are left untouched — only
  // sessions that appear after the initial load are grouped.
  const knownSessionsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(sessions.map((session) => session.fileName));
    const known = knownSessionsRef.current;
    if (known === null) {
      knownSessionsRef.current = ids;
      return;
    }
    setCollections((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const session of sessions) {
        if (known.has(session.fileName)) {
          continue;
        }
        const folder = session.cwd.split('/').filter((part) => part.length > 0).pop();
        if (folder === undefined || folder.length === 0) {
          continue;
        }
        const list = next[folder] ?? [];
        // Store the session id (the key used by byId / dropIntoCollection /
        // archived markers); P1-13 stored file names, which never matched the
        // id-keyed lookup and made collections render as empty.
        if (!list.includes(session.id)) {
          next[folder] = [...list, session.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    knownSessionsRef.current = ids;
  }, [sessions]);

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

  // P1-13 stored file names in collections; fall back to a file-name lookup
  // so legacy collection entries keep resolving after the id-key fix.
  const byFileName = useMemo(() => {
    const map = new Map<string, SessionSummary>();
    for (const session of filtered) {
      map.set(session.fileName, session);
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
        // Legacy collections may hold both a file name and the id for the
        // same session (P1-13 era) — dedupe by session id.
        sessions: [
          ...new Map(
            ids
              .map((id) => byId.get(id) ?? byFileName.get(id))
              .filter((session): session is SessionSummary => session !== undefined)
              .map((session) => [session.id, session] as const),
          ).values(),
        ],
      }));
  }, [collections, byId, byFileName]);

  const handleNewSession = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const response = await api.newSession();
      if (!response.success) {
        setError(response.error ?? 'failed to start new session');
        return;
      }
      onSessionChanged(null);
      onViewChange('chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onSessionChanged, onViewChange]);

  const handleResume = useCallback(
    async (session: SessionSummary): Promise<void> => {
      setError(null);
      // P1-17 D: highlight immediately — the RPC round-trip must not gate
      // the visual feedback.
      setPendingActive(session.fileName);
      markRead(session.fileName);
      try {
        const response = await api.switchSession(session.fileName);
        if (!response.success) {
          setError(response.error ?? t('sessions.openSessionError'));
          return;
        }
        onSessionChanged(
          session.fileName,
          session.name !== undefined && session.name.length > 0
            ? session.name
            : shortCwd(session.cwd),
        );
        onViewChange('chat');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [markRead, onSessionChanged, onViewChange, t],
  );

  /** Multi-agent row click: pi resumes the session, codex switches agent +
   *  resumes the thread, record-only agents open the history page. */
  const handleOpenRow = useCallback(
    (row: AgentSessionRow): void => {
      if (row.agent === 'pi') {
        void handleResume(row.target as SessionSummary);
        return;
      }
      if (row.agent === 'codex') {
        onOpenCodexSession((row.target as CodexSessionMeta).sessionId, row.label);
        return;
      }
      // atomcode / zcode are read-only records.
      onViewChange('sessions');
    },
    [handleResume, onOpenCodexSession, onViewChange],
  );

  const handleArchive = useCallback((sessionId: string): void => {
    setArchived((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
    setCollections((prev) => {
      const updated: Record<string, string[]> = {};
      for (const [name, ids] of Object.entries(prev)) {
        updated[name] = ids.filter((id) => id !== sessionId);
      }
      return updated;
    });
    archiveSession(sessionId);
  }, []);

  // L008: guarded session deletion behind the in-app ConfirmDialog
  // (replaces window.confirm, which blocked automated flows).
  const deleteSessionTarget = useCallback(
    (session: SessionSummary): void => {
      void (async () => {
        try {
          // P1-deletefix: the server only accepts a bare .jsonl name
          // (path-traversal guard) — the sidebar previously sent the full
          // path and always got 400, so deletion appeared to do nothing.
          const bareName = session.fileName.split('/').pop() ?? session.fileName;
          const response = await api.deleteSession(bareName);
          if (!response.success) {
            setError(response.error ?? 'delete failed');
            return;
          }
          // Archived markers are keyed by session id, not file name.
          removeArchived(session.id);
          // Drop the session from its collections so no stale id remains.
          setCollections((prev) => {
            let changed = false;
            const next: Record<string, string[]> = {};
            for (const [name, ids] of Object.entries(prev)) {
              const kept = ids.filter((id) => id !== session.id);
              if (kept.length !== ids.length) {
                changed = true;
              }
              next[name] = kept;
            }
            return changed ? next : prev;
          });
          setDeleteTick((prev) => prev + 1);
          onSessionChanged(null);
          onViewChange('chat');
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [onSessionChanged, onViewChange],
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

  const openContextMenu = useCallback(
    (event: React.MouseEvent, session: SessionSummary): void => {
      event.preventDefault();
      setContextMenu({ x: event.clientX, y: event.clientY, session });
    },
    [],
  );

  // Right-click "new branch": switch to the target session first (pi's
  // clone RPC forks the current RPC session), then clone it.
  const cloneTargetSession = useCallback(
    async (session: SessionSummary): Promise<void> => {
      setError(null);
      try {
        const switched = await api.switchSession(session.fileName);
        if (!switched.success) {
          setError(switched.error ?? t('sessions.openSessionError'));
          return;
        }
        const response = await api.cloneSession();
        if (!response.success) {
          setError(response.error ?? 'clone failed');
          return;
        }
        // undefined: the RPC session changed under the current tab (clone
        // produces a new session) — let the app rebind and reload it.
        onSessionChanged(undefined);
        onViewChange('chat');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [onSessionChanged, onViewChange, t],
  );

  const sessionRowProps = {
    intlTag,
    onOpen: (session: SessionSummary) => {
      void handleResume(session);
    },
    onContextMenu: openContextMenu,
    t,
  };

  const statusOf = (session: SessionSummary): SessionStatus => {
    if (session.fileName !== sessionFile) {
      return 'done';
    }
    return sessionStatus;
  };

  const isActive = (fileName: string): boolean => fileName === (pendingActive ?? sessionFile);

  // Folder grouping supersedes the legacy collection UI; keep the data
  // helpers referenced so their semantics survive future re-enablement.
  void setSessions;
  void editingCollection;
  void collectionDraft;
  void ungrouped;
  void collectionEntries;
  void addCollection;
  void renameCollection;
  void deleteCollection;
  void dropIntoCollection;
  void sessionRowProps;

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
          className="sidebar-back-wide btn-primary mono"
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
          <span className="hico hico-plus-square-fill" aria-hidden="true" />
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
          data-active={view === 'automation'}
          onClick={() => {
            onViewChange('automation');
          }}
        >
          <span className="hico hico-mind-map" aria-hidden="true" />
          <span>{t('sidebar.features')}</span>
        </button>
        {error !== null ? (
          <div className="sidebar-error mono" role="alert">
            {error}
          </div>
        ) : null}
      </div>

      <hr className="swiss-rule" />

      <div className="sidebar-sessions scroll-area">
        <div className="sidebar-section-row">
          <span className="sidebar-section-label swiss-section-label">
            {t('sidebar.sessions')}
          </span>
          {/* Multi-agent filter: all records by default. */}
          <div className="sidebar-agent-filter" role="group" aria-label={t('sidebar.agentFilter')}>
            {(
              [
                { value: 'all', glyph: '全' },
                { value: 'pi', glyph: AGENT_GLYPHS.pi },
                { value: 'codex', glyph: AGENT_GLYPHS.codex },
                { value: 'atomcode', glyph: AGENT_GLYPHS.atomcode },
                { value: 'zcode', glyph: AGENT_GLYPHS.zcode },
              ] as ReadonlyArray<{ value: 'all' | SidebarAgent; glyph: string }>
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                className="sidebar-agent-filter-btn mono"
                data-agent={option.value}
                data-active={agentFilter === option.value}
                onClick={() => {
                  setAgentFilter(option.value);
                }}
              >
                {option.glyph}
              </button>
            ))}
          </div>
        </div>
        {(() => {
          const needle = query.trim().toLowerCase();
          const rows = agentRows.filter((row) => {
            if (agentFilter !== 'all' && row.agent !== agentFilter) {
              return false;
            }
            if (row.agent === 'pi' && archived.includes((row.target as SessionSummary).id)) {
              return false;
            }
            if (needle.length === 0) {
              return true;
            }
            return (
              row.cwd.toLowerCase().includes(needle) || row.label.toLowerCase().includes(needle)
            );
          });
          // Folder grouping: cwd folder for pi/codex, "other" for
          // record-only agents without a cwd.
          const groups = new Map<string, AgentSessionRow[]>();
          const others: AgentSessionRow[] = [];
          for (const row of rows) {
            if (row.cwd.length === 0) {
              others.push(row);
              continue;
            }
            const folder = shortCwd(row.cwd);
            const list = groups.get(folder) ?? [];
            list.push(row);
            groups.set(folder, list);
          }
          const groupEntries = [...groups.entries()].sort((a, b) => {
            const la = a[1][0]?.lastActivityAt ?? '';
            const lb = b[1][0]?.lastActivityAt ?? '';
            return la < lb ? 1 : -1;
          });
          return (
            <>
              {groupEntries.map(([folder, folderRows]) => (
                <div key={folder} className="sidebar-collection">
                  <div className="sidebar-collection-head">
                    <span className="sidebar-collection-name mono" title={folder}>
                      {folder}
                    </span>
                  </div>
                  <ul className="sidebar-session-list">
                    {folderRows.map((row) => (
                      <li key={row.key}>
                        <SessionRow
                          row={row}
                          intlTag={intlTag}
                          active={
                            row.agent === 'pi' &&
                            isActive((row.target as SessionSummary).fileName)
                          }
                          status={row.status}
                          unread={
                            row.agent === 'pi' ? isUnread(row.target as SessionSummary) : false
                          }
                          blink={
                            row.agent === 'pi' &&
                            isActive((row.target as SessionSummary).fileName) &&
                            requestPending
                          }
                          onOpen={(clicked) => {
                            handleOpenRow(clicked);
                          }}
                          onContextMenu={(event, clicked) => {
                            if (clicked.agent === 'pi') {
                              openContextMenu(event, clicked.target as SessionSummary);
                            }
                          }}
                          imported={
                            row.agent === 'codex' &&
                            importedCodex.includes((row.target as CodexSessionMeta).sessionId)
                          }
                          t={t}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {others.length > 0 ? (
                <div className="sidebar-collection">
                  <div className="sidebar-collection-head">
                    <span className="sidebar-collection-name mono">
                      {t('sidebar.otherRecords')}
                    </span>
                  </div>
                  <ul className="sidebar-session-list">
                    {others.map((row) => (
                      <li key={row.key}>
                        <SessionRow
                          row={row}
                          intlTag={intlTag}
                          active={false}
                          status={row.status}
                          unread={false}
                          blink={false}
                          onOpen={(clicked) => {
                            handleOpenRow(clicked);
                          }}
                          onContextMenu={() => {
                            // record-only agents have no session actions
                          }}
                          imported={
                            row.agent === 'codex' &&
                            importedCodex.includes((row.target as CodexSessionMeta).sessionId)
                          }
                          t={t}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {rows.length === 0 ? (
                <p className="sidebar-empty mono">
                  {needle.length > 0 ? t('sidebar.empty.search') : t('sidebar.empty')}
                </p>
              ) : null}
            </>
          );
        })()}
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
            icon="hico-arrow-counterclockwise-clock"
            label={t('sidebar.history')}
            placement="bottom"
            dataActive={view === 'sessions'}
            onClick={() => {
              onViewChange('sessions');
            }}
          />
          <IconButton
            icon="hico-yuansign-coupon-fill"
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
      {contextMenu !== null ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => {
            setContextMenu(null);
          }}
          items={[
            {
              label: t('sessions.open'),
              icon: 'hico-arrow-left',
              onSelect: () => {
                void handleResume(contextMenu.session);
              },
            },
            {
              label: t('sidebar.newBranch'),
              icon: 'hico-square-grid',
              onSelect: () => {
                void cloneTargetSession(contextMenu.session);
              },
            },
            {
              label: t('sidebar.archive'),
              icon: 'hico-rectangle-stack',
              onSelect: () => {
                handleArchive(contextMenu.session.id);
              },
            },
            {
              label: t('sessions.delete'),
              icon: 'hico-trash',
              danger: true,
              onSelect: () => {
                setPendingDelete(contextMenu.session);
              },
            },
          ]}
        />
      ) : null}
      {pendingDelete !== null ? (
        <ConfirmDialog
          title={t('sessions.delete')}
          message={t('sessions.deleteConfirm', {
            name: pendingDelete.name ?? pendingDelete.fileName,
          })}
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            deleteSessionTarget(target);
          }}
          onCancel={() => {
            setPendingDelete(null);
          }}
        />
      ) : null}
    </nav>
  );
}
