import { useCallback, useEffect, useMemo, useState } from 'react';

const CODEX_IMPORTED_KEY = 'pi-panel:codex-imported';
import type { SessionSummary } from '../../shared/types.js';
import type { CodexSessionMeta } from '../../server/adapters/codex-history.js';
import type { AtomcodeSessionDetail } from '../../server/adapters/atomcode-history.js';
import type { ClaudeSessionMeta } from '../../server/adapters/claude-history.js';
import type { ZcodeSessionMeta } from '../../server/adapters/zcode-history.js';
import { loadAdapterColors } from '../adapters/adapterColors.js';
import { api } from '../api/client.js';
import { ExternalSessionsPanel } from '../components/ExternalSessionsPanel.js';
import { DshSessionsPanel } from '../components/DshSessionsPanel.js';
import { AdapterSessionsSection, type AdapterSessionLine } from '../components/AdapterSessionsSection.js';
import { useI18n, type MessageKey } from '../i18n/I18nProvider.js';
import { SessionDetailView } from './SessionDetailView.js';
import { LoadingHint } from '../components/LoadingHint.js';
import { FogLoading } from '../components/FogLoading.js';
import './SessionsPage.css';

function formatDate(iso: string, intlTag: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
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

function SessionRow({
  session,
  onOpen,
  t,
  intlTag,
}: {
  session: SessionSummary;
  onOpen: (id: string) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  intlTag: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="session-row"
      onClick={() => {
        onOpen(session.id);
      }}
    >
      <span className="session-row-cwd mono">
        {session.name !== undefined && session.name.length > 0
          ? session.name
          : shortCwd(session.cwd)}
      </span>
      <span className="session-row-stats mono">
        {String(session.messageCount)} {t('sidebar.msgs')} · {String(session.toolCalls)}{' '}
        {t('sessions.tools')}
      </span>
      <span className="session-row-cost mono">${session.cost.toFixed(3)}</span>
      <span className="session-row-time mono">{formatDate(session.lastActivityAt, intlTag)}</span>
    </button>
  );
}

export function SessionsPage({
  onNewSession,
}: {
  onNewSession?: () => void;
}): React.JSX.Element {
  const { t, intlTag } = useI18n();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // P2-01 B/D: read-only codex records + per-adapter accent color.
  const [codexSessions, setCodexSessions] = useState<CodexSessionMeta[] | null>(null);
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSessionMeta[] | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);
  /** "录入" (import): pin a codex record into the sidebar 会话 area. */
  const [importedCodex, setImportedCodex] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(CODEX_IMPORTED_KEY);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  });
  const toggleImportCodex = useCallback((sessionId: string): void => {
    setImportedCodex((prev) => {
      const next = prev.includes(sessionId)
        ? prev.filter((id) => id !== sessionId)
        : [...prev, sessionId];
      try {
        localStorage.setItem(CODEX_IMPORTED_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable
      }
      window.dispatchEvent(new Event('pihub:codex-imported-changed'));
      return next;
    });
  }, []);
  // ADAPTER2: atomcode + zcode read-only records.
  const [atomcodeSession, setAtomcodeSession] = useState<AtomcodeSessionDetail | null>(null);
  const [zcodeSessions, setZcodeSessions] = useState<ZcodeSessionMeta[] | null>(null);
  const atomcodeColor = useMemo(() => loadAdapterColors()['atomcode'] ?? '#e4572e', []);
  const zcodeColor = useMemo(() => loadAdapterColors()['zcode'] ?? '#7f56d9', []);
  const codexColor = useMemo(() => loadAdapterColors()['codex'] ?? '#10a37f', []);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await api.sessions();
        if (!cancelled) {
          setSessions(response.sessions);
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
  }, [reloadKey]);

  // P2-01 B: codex records load once alongside the pi sessions.
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await api.codexSessions();
        if (!cancelled) {
          setCodexSessions(response.sessions);
        }
      } catch (err) {
        if (!cancelled) {
          setCodexError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // ADAPTER2: atomcode + zcode read-only records load once.
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [atom, zcode] = await Promise.all([api.atomcodeSession(), api.zcodeSessions()]);
        if (!cancelled) {
          setAtomcodeSession(atom.session);
          setZcodeSessions(zcode.sessions);
        }
      } catch {
        // adapter sections stay empty when unavailable
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // claude adapter: transcript records load once.
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await api.claudeSessions();
        if (!cancelled) {
          setClaudeSessions(response.sessions);
        }
      } catch {
        // claude section stays empty when unavailable
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    if (sessions === null) {
      return null;
    }
    const groups = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const dir = session.cwd || '(unknown)';
      const group = groups.get(dir);
      if (group === undefined) {
        groups.set(dir, [session]);
      } else {
        group.push(session);
      }
    }
    return [...groups.entries()];
  }, [sessions]);

  const codexRows: AdapterSessionLine[] | null =
    codexSessions === null
      ? null
      : codexSessions.map((session) => ({
          key: session.sessionId,
          title: session.cwd,
          meta: [
            `${String(session.messageCount)} ${t('codex.messages')}`,
            `${String(session.toolCalls)} ${t('codex.tools')}`,
            session.modelProvider ?? '',
          ]
            .filter(Boolean)
            .join(' · '),
          color: codexColor,
          actions: (
            <button
              type="button"
              className={
                importedCodex.includes(session.sessionId)
                  ? 'btn-primary codex-session-import codex-session-imported'
                  : 'btn-secondary codex-session-import'
              }
              onClick={() => {
                toggleImportCodex(session.sessionId);
              }}
            >
              {importedCodex.includes(session.sessionId)
                ? t('codex.imported')
                : t('codex.import')}
            </button>
          ),
          detail: async () => {
            const detail = await api.codexSessionDetail(session.sessionId);
            return detail.entries
              .filter((entry) => typeof entry.text === 'string' && entry.text.length > 0)
              .map((entry) => ({ role: entry.type, text: entry.text as string }));
          },
        }));

  const atomcodeRows: AdapterSessionLine[] | null =
    atomcodeSession === null
      ? null
      : [
          {
            key: 'atomcode-history',
            title: 'AtomCode history',
            meta: `${String(atomcodeSession.messageCount)} ${t('codex.messages')}`,
            color: atomcodeColor,
          },
        ];

  const zcodeRows: AdapterSessionLine[] | null =
    zcodeSessions === null
      ? null
      : zcodeSessions.map((session) => ({
          key: session.sessionId,
          title: session.sessionId,
          meta: [
            `${String(session.turns)} ${t('adapter.turns')}`,
            `${String(session.totalTokens)} ${t('adapter.tokens')}`,
            session.modelId,
          ].join(' · '),
          color: zcodeColor,
        }));

  const claudeRows: AdapterSessionLine[] | null =
    claudeSessions === null
      ? null
      : claudeSessions.map((session) => ({
          key: session.sessionId,
          title: session.cwd,
          meta: `${String(session.messageCount)} ${t('codex.messages')} · ${String(session.toolCalls)} ${t('codex.tools')}`,
          color: '#d97757',
          detail: async () => {
            const detail = await api.claudeSessionDetail(session.sessionId);
            return detail.turns.map((turn) => ({ role: turn.role, text: turn.text }));
          },
        }));

  if (selectedId !== null) {
    return (
      <SessionDetailView
        id={selectedId}
        onBack={() => {
          setSelectedId(null);
        }}
      />
    );
  }

  return (
    <section className="sessions-page" data-shot="sessions">
      <div className="sessions-head">
        <h1 className="panel-title">{t('sessions.title')}</h1>
        <div className="sessions-head-actions">
          <p className="sessions-head-hint mono">
            {sessions === null ? (
              <LoadingHint>{t('sessions.hint.loading')}</LoadingHint>
            ) : (
              String(sessions.length)
            )}
          </p>
          <button
            type="button"
            className="sessions-refresh"
            onClick={() => {
              setReloadKey(reloadKey + 1);
            }}
          >
            {t('sessions.refresh')}
          </button>
        </div>
      </div>

      {error !== null ? <div className="sessions-error mono">{error}</div> : null}

      <ExternalSessionsPanel />

      <FogLoading loading={grouped === null}>
      {grouped === null ? (
        <p className="sessions-hint">
          <LoadingHint>{t('sessions.hint.loading')}</LoadingHint>
        </p>
      ) : grouped.length === 0 ? (
        <p className="sessions-hint">
          {t('sessions.hint.empty')}
          {onNewSession !== undefined ? (
            <button type="button" className="btn-primary sessions-empty-cta" onClick={onNewSession}>
              {t('sessions.hint.cta')}
            </button>
          ) : null}
        </p>
      ) : (
        <div className="sessions-groups">
          {grouped.map(([dir, list]) => (
            <div key={dir} className="sessions-group">
              <div className="sessions-group-label mono">{dir}</div>
              <div className="sessions-group-list">
                {list.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    onOpen={setSelectedId}
                    t={t}
                    intlTag={intlTag}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      </FogLoading>

      {/* P2-01 B: read-only codex session records (never spawned). */}
      <AdapterSessionsSection
        icon="/icons/agents/codex.svg"
        label="Codex"
        hint={t('codex.sessionsHint')}
        error={codexError}
        rows={codexRows}
        emptyText={t('sessions.hint.empty')}
      />

      {/* ADAPTER2: read-only atomcode records (history.json). */}
      <AdapterSessionsSection
        icon="/icons/agents/atomcode.svg"
        iconDark
        label="AtomCode"
        hint="~/.atomcode/history.json"
        rows={atomcodeRows}
      />

      {/* ADAPTER2: read-only zcode records (rollout model I/O). */}
      <AdapterSessionsSection
        icon="/icons/agents/zcode.svg"
        label="ZCode"
        hint="~/.zcode/cli/rollout"
        rows={zcodeRows}
      />

      {/* Claude transcript records (read-only). */}
      <AdapterSessionsSection
        icon="/icons/agents/claude.svg"
        label="Claude"
        hint="~/.claude/projects"
        rows={claudeRows}
        emptyText={t('sessions.hint.empty')}
      />

      {/* DeepSeek Harness session records (read-only). */}
      <DshSessionsPanel />
    </section>
  );
}
