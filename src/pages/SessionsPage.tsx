import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../../shared/types.js';
import type { CodexSessionDetail, CodexSessionMeta } from '../../server/adapters/codex-history.js';
import { loadAdapterColors } from '../adapters/adapterColors.js';
import { api } from '../api/client.js';
import { useI18n, type MessageKey } from '../i18n/I18nProvider.js';
import { SessionDetailView } from './SessionDetailView.js';
import { LoadingHint } from '../components/LoadingHint.js';
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
  const [codexError, setCodexError] = useState<string | null>(null);
  const [codexOpenDetail, setCodexOpenDetail] = useState<CodexSessionDetail | null>(null);
  const codexColor = useMemo(() => loadAdapterColors()['codex'] ?? '#10a37f', []);

  const openCodexDetail = useCallback(
    async (id: string): Promise<void> => {
      setCodexError(null);
      try {
        const detail = await api.codexSessionDetail(id);
        // Inline expand: show the first messages of the rollout below the row.
        setCodexOpenDetail((prev) => (prev?.sessionId === detail.sessionId ? null : detail));
      } catch (err) {
        setCodexError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

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

      {/* P2-01 B: read-only codex session records (never spawned). */}
      <section className="codex-sessions">
        <div className="codex-sessions-head">
          <h2 className="codex-sessions-title mono">{t('codex.sessions')}</h2>
          <p className="codex-sessions-hint mono">{t('codex.sessionsHint')}</p>
        </div>
        {codexError !== null ? <div className="sessions-error mono">{codexError}</div> : null}
        {codexSessions === null ? (
          <p className="sessions-hint">
            <LoadingHint>{t('sessions.hint.loading')}</LoadingHint>
          </p>
        ) : codexSessions.length === 0 ? (
          <p className="sessions-hint">{t('sessions.hint.empty')}</p>
        ) : (
          <div className="codex-sessions-list">
            {codexSessions.map((session) => (
              <div
                key={session.sessionId}
                className="codex-session-row"
                style={{ borderLeftColor: codexColor }}
              >
                <div className="codex-session-main">
                  <span className="codex-session-cwd mono" title={session.cwd}>
                    {session.cwd}
                  </span>
                  <span className="codex-session-meta mono">
                    {String(session.messageCount)} {t('codex.messages')} ·{' '}
                    {String(session.toolCalls)} {t('codex.tools')}
                    {session.modelProvider !== undefined
                      ? ` · ${session.modelProvider}`
                      : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn-primary codex-session-open"
                  onClick={() => {
                    void openCodexDetail(session.sessionId);
                  }}
                >
                  {t('codex.open')}
                </button>
                {codexOpenDetail !== null && codexOpenDetail.sessionId === session.sessionId ? (
                  <div className="codex-session-detail">
                    {codexOpenDetail.entries
                      .filter((entry) => typeof entry.text === 'string' && entry.text.length > 0)
                      .slice(0, 8)
                      .map((entry, index) => (
                        <p key={index} className="codex-session-line mono" data-type={entry.type}>
                          {entry.text}
                        </p>
                      ))}
                    {codexOpenDetail.entries.length === 0 ? (
                      <p className="sessions-hint">{t('sessions.hint.empty')}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
