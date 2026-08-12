import { useCallback, useEffect, useMemo, useState } from 'react';

const CODEX_IMPORTED_KEY = 'pi-panel:codex-imported';
import type { SessionSummary } from '../../shared/types.js';
import type { CodexSessionDetail, CodexSessionMeta } from '../../server/adapters/codex-history.js';
import type { AtomcodeSessionDetail } from '../../server/adapters/atomcode-history.js';
import type { ClaudeSessionMeta } from '../../server/adapters/claude-history.js';
import type { ZcodeSessionMeta } from '../../server/adapters/zcode-history.js';
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
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSessionMeta[] | null>(null);
  const [claudeOpenDetail, setClaudeOpenDetail] = useState<string | null>(null);
  const [claudeDetail, setClaudeDetail] = useState<Array<{ role: string; text: string; timestamp: string }> | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [codexOpenDetail, setCodexOpenDetail] = useState<CodexSessionDetail | null>(null);
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
                <div className="codex-session-actions">
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
                  <button
                    type="button"
                    className="btn-primary codex-session-open"
                    onClick={() => {
                      void openCodexDetail(session.sessionId);
                    }}
                  >
                    {t('codex.open')}
                  </button>
                </div>
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

      {/* ADAPTER2: read-only atomcode records (history.json). */}
      <section className="codex-sessions">
        <div className="codex-sessions-head">
          <h2 className="codex-sessions-title mono">
            {t('adapter.sessions', { label: 'AtomCode' })}
          </h2>
          <p className="codex-sessions-hint mono">~/.atomcode/history.json</p>
        </div>
        {atomcodeSession === null ? (
          <p className="sessions-hint">
            <LoadingHint>{t('sessions.hint.loading')}</LoadingHint>
          </p>
        ) : (
          <div className="codex-sessions-list">
            <div className="codex-session-row" style={{ borderLeftColor: atomcodeColor }}>
              <div className="codex-session-main">
                <span className="codex-session-cwd mono">AtomCode history</span>
                <span className="codex-session-meta mono">
                  {String(atomcodeSession.messageCount)} {t('codex.messages')}
                </span>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ADAPTER2: read-only zcode records (rollout model I/O). */}
      <section className="codex-sessions">
        <div className="codex-sessions-head">
          <h2 className="codex-sessions-title mono">{t('adapter.sessions', { label: 'ZCode' })}</h2>
          <p className="codex-sessions-hint mono">~/.zcode/cli/rollout</p>
        </div>
        {zcodeSessions === null ? (
          <p className="sessions-hint">
            <LoadingHint>{t('sessions.hint.loading')}</LoadingHint>
          </p>
        ) : zcodeSessions.length === 0 ? (
          <p className="sessions-hint">{t('sessions.hint.empty')}</p>
        ) : (
          <div className="codex-sessions-list">
            {zcodeSessions.map((session) => (
              <div key={session.sessionId} className="codex-session-row" style={{ borderLeftColor: zcodeColor }}>
                <div className="codex-session-main">
                  <span className="codex-session-cwd mono" title={session.sessionId}>
                    {session.sessionId}
                  </span>
                  <span className="codex-session-meta mono">
                    {String(session.turns)} {t('adapter.turns')} ·{' '}
                    {String(session.totalTokens)} {t('adapter.tokens')} · {session.modelId}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="codex-sessions">
        <div className="codex-sessions-head">
          <h2 className="codex-sessions-title mono">{t('adapter.sessions', { label: 'Claude' })}</h2>
          <p className="codex-sessions-hint mono">~/.claude/projects</p>
        </div>
        {claudeSessions === null ? (
          <p className="sessions-hint">
            <LoadingHint>{t('sessions.hint.loading')}</LoadingHint>
          </p>
        ) : claudeSessions.length === 0 ? (
          <p className="sessions-hint">{t('sessions.hint.empty')}</p>
        ) : (
          <div className="codex-sessions-list">
            {claudeSessions.map((session) => (
              <div key={session.sessionId} className="codex-session-row" style={{ borderLeftColor: '#d97757' }}>
                <div className="codex-session-main">
                  <span className="codex-session-cwd mono" title={session.sessionId}>
                    {session.cwd}
                  </span>
                  <span className="codex-session-meta mono">
                    {String(session.messageCount)} {t('codex.messages')} ·{' '}
                    {String(session.toolCalls)} {t('codex.tools')}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn-primary codex-session-open"
                  onClick={() => {
                    void (async () => {
                      setClaudeOpenDetail(session.sessionId);
                      try {
                        const detail = await api.claudeSessionDetail(session.sessionId);
                        setClaudeDetail(detail.turns);
                      } catch {
                        setClaudeDetail(null);
                      }
                    })();
                  }}
                >
                  {t('codex.open')}
                </button>
                {claudeOpenDetail === session.sessionId && claudeDetail !== null ? (
                  <div className="codex-session-detail">
                    {claudeDetail.slice(0, 8).map((turn, index) => (
                      <p key={index} className="codex-session-line mono" data-type={turn.role}>
                        {turn.role}: {turn.text.slice(0, 120)}
                      </p>
                    ))}
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
