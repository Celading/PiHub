import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionDetail } from '../../shared/types.js';
import { api } from '../api/client.js';
import { eventsUrl } from '../api/controlToken.js';
import { useSessionComposer } from '../chat/sessionComposer.js';
import { Composer } from '../components/Composer.js';
import { MessageItem } from '../components/MessageItem.js';
import { LoadingHint } from '../components/LoadingHint.js';
import { SessionTreeView } from '../components/SessionTreeView.js';
import { useI18n, type MessageKey } from '../i18n/I18nProvider.js';
import './SessionDetailView.css';

function formatDate(iso: string, intlTag: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(intlTag, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function formatTokens(total: number): string {
  if (total >= 1_000_000) {
    return `${(total / 1_000_000).toFixed(1)}M`;
  }
  if (total >= 1_000) {
    return `${(total / 1_000).toFixed(1)}k`;
  }
  return String(total);
}

interface SessionDetailViewProps {
  id: string;
  onBack: () => void;
}

export function SessionDetailView({ id, onBack }: SessionDetailViewProps): React.JSX.Element {
  const { t, intlTag } = useI18n();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'mainline' | 'no-tools' | 'user' | 'labeled'>(
    'all',
  );
  /** P1-05: stream view vs session-tree view (branch timeline / one-click fork). */
  const [viewMode, setViewMode] = useState<'stream' | 'tree'>('stream');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsData, setStatsData] = useState<Record<string, unknown> | null>(null);
  const [autoCompact, setAutoCompact] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const result = await api.sessionDetail(id);
      setDetail(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>, doneKey: MessageKey): Promise<void> => {
      setError(null);
      try {
        await action();
        setNotice(t(doneKey));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [t],
  );

  const handleRename = useCallback(async (): Promise<void> => {
    const trimmed = nameDraft.trim();
    if (trimmed.length === 0) {
      setEditingName(false);
      return;
    }
    await runAction(() => api.renameSession(trimmed), 'session.rename');
    setEditingName(false);
    void reload();
  }, [nameDraft, reload, runAction]);

  const handleClone = useCallback(async (): Promise<void> => {
    await runAction(() => api.cloneSession(), 'session.clone.done');
    void reload();
  }, [reload, runAction]);

  const handleFork = useCallback(
    async (entryId: string): Promise<void> => {
      await runAction(() => api.forkSession(entryId), 'session.fork.done');
      void reload();
    },
    [reload, runAction],
  );

  const handleCompact = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const response = await api.compact();
      if (!response.success) {
        setError(response.error ?? 'compact failed');
        return;
      }
      setNotice(t('session.compact.done'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [t]);

  const handleStats = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const data = await api.sessionStats();
      setStatsData(data as Record<string, unknown>);
      setStatsOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleAutoCompact = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const state = await api.rpcState();
      const next = !(state.autoCompactionEnabled ?? false);
      await api.setAutoCompaction(next);
      setAutoCompact(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // compaction lifecycle banner
  useEffect(() => {
    const source = new EventSource(eventsUrl());
    const onPiEvent = (event: MessageEvent<string>): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return;
      }
      const record = parsed as Record<string, unknown>;
      if (record['type'] === 'compaction_start') {
        setNotice(t('session.compacting'));
      } else if (record['type'] === 'compaction_end') {
        setNotice(t('session.compact.done'));
        void reload();
      }
    };
    source.addEventListener('pi', onPiEvent);
    return () => {
      source.close();
    };
  }, [reload, t]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const result = await api.sessionDetail(id);
        if (!cancelled) {
          setDetail(result);
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
  }, [id]);

  const composer = useSessionComposer(
    detail?.fileName ?? '',
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const mainlineIds = useMemo(() => {
    if (detail === null) {
      return new Set<string>();
    }
    const ids = new Set<string>();
    let current: string | null = detail.leafId;
    while (current !== null) {
      ids.add(current);
      const entry = detail.entries.find((item) => item.id === current);
      current = entry?.parentId ?? null;
    }
    return ids;
  }, [detail]);

  // Tree filters (phase-2 close-out): all / mainline / no-tools / user /
  // labeled. "labeled" has no data source yet (JSONL label entries are not
  // parsed) — the option stays visible but disabled.
  const visible = useMemo(() => {
    if (detail === null) {
      return [];
    }
    switch (filter) {
      case 'all':
        return detail.entries;
      case 'mainline':
        return detail.entries.filter((entry) => mainlineIds.has(entry.id));
      case 'no-tools':
        return detail.entries.filter((entry) => {
          const role = entry.message?.role;
          return role !== 'toolResult' && role !== 'bashExecution';
        });
      case 'user':
        return detail.entries.filter((entry) => entry.message?.role === 'user');
      case 'labeled':
        // No label entries parsed yet; falls back to empty.
        return [];
    }
  }, [detail, filter, mainlineIds]);
  if (error !== null) {
    return (
      <section className="sessions-page">
        <button type="button" className="sessions-back" onClick={onBack}>
          {t('sessions.back')}
        </button>
        <div className="sessions-error mono">{error}</div>
      </section>
    );
  }

  if (detail === null) {
    return (
      <section className="sessions-page">
        <button type="button" className="sessions-back" onClick={onBack}>
          {t('sessions.back')}
        </button>
        <p className="sessions-hint">
          <LoadingHint>{t('sessions.loading')}</LoadingHint>
        </p>
      </section>
    );
  }


  return (
    <section className="sessions-page">
      <button type="button" className="sessions-back" onClick={onBack}>
        {t('sessions.back')}
      </button>

      <div className="session-header">
        <div>
          <h2 className="panel-title">
            {detail.name !== undefined && detail.name.length > 0
              ? detail.name
              : detail.cwd}
          </h2>
          <p className="session-meta mono">
            {formatDate(detail.startedAt, intlTag)} · {String(detail.entries.length)}{' '}
            {t('sessions.entries')}
            {detail.entries.length > 0
              ? ` · ${formatTokens(detail.totals.total)} ${t('sessions.tokens')}`
              : ''}
            {detail.totalCost > 0 ? ` · ${formatCost(detail.totalCost)}` : ''}
          </p>
        </div>
        <div className="session-actions">
          {notice !== null ? <span className="session-notice mono">{notice}</span> : null}
          {editingName ? (
            <input
              className="session-name-input mono"
              value={nameDraft}
              autoFocus
              placeholder={t('session.rename.placeholder')}
              aria-label={t('session.rename.placeholder')}
              onChange={(event) => {
                setNameDraft(event.target.value);
              }}
              onBlur={() => {
                void handleRename();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  void handleRename();
                }
                if (event.key === 'Escape') {
                  setEditingName(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="session-action-btn"
              onClick={() => {
                setNameDraft('');
                setEditingName(true);
              }}
            >
              {t('session.rename')}
            </button>
          )}
          <button type="button" className="session-action-btn" onClick={() => { void handleClone(); }}>
            {t('session.clone')}
          </button>
          <button type="button" className="session-action-btn" onClick={() => { void handleStats(); }}>
            {t('session.stats')}
          </button>
          <button type="button" className="session-action-btn" onClick={() => { void handleCompact(); }}>
            {t('session.compact')}
          </button>
          <label className="session-auto-compact mono">
            <input
              type="checkbox"
              checked={autoCompact}
              onChange={() => {
                void handleAutoCompact();
              }}
            />
            {t('session.autoCompact')}
          </label>
          <span className="session-filter-row mono">
            {(
              [
                { value: 'all', label: t('sessions.filter.all') },
                { value: 'mainline', label: t('sessions.filter.mainline') },
                { value: 'no-tools', label: t('sessions.filter.noTools') },
                { value: 'user', label: t('sessions.filter.user') },
                { value: 'labeled', label: t('sessions.filter.labeled') },
              ] as ReadonlyArray<{ value: 'all' | 'mainline' | 'no-tools' | 'user' | 'labeled'; label: string }>
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                className="session-filter-btn"
                data-active={filter === option.value}
                disabled={option.value === 'labeled'}
                title={option.value === 'labeled' ? t('sessions.filter.labeledHint') : undefined}
                onClick={() => {
                  setFilter(option.value);
                }}
              >
                {option.label}
              </button>
            ))}
          </span>
          <button
            type="button"
            className="session-action-btn"
            data-active={viewMode === 'tree'}
            onClick={() => {
              setViewMode(viewMode === 'tree' ? 'stream' : 'tree');
            }}
          >
            {t('session.tree')}
          </button>
        </div>
      </div>

      <div className="session-stream">
        {viewMode === 'tree' ? (
          <SessionTreeView
            detail={detail}
            onFork={(entryId) => {
              void handleFork(entryId);
            }}
          />
        ) : (
          visible.map((entry) =>
            entry.type === 'message' && entry.message !== undefined ? (
              <div key={entry.id} data-offbranch={!mainlineIds.has(entry.id)}>
                {entry.message.role === 'user' && mainlineIds.has(entry.id) ? (
                  <div className="session-message-fork">
                    <button
                      type="button"
                      className="session-fork-btn"
                      onClick={() => {
                        void handleFork(entry.id);
                      }}
                    >
                      <span className="hico hico-square-grid" aria-hidden="true" />
                      {t('session.fork')}
                    </button>
                  </div>
                ) : null}
                <MessageItem message={entry.message} isStreaming={false} />
              </div>
            ) : (
              <div key={entry.id} className="session-event mono">
                {entry.type === 'model_change' && entry.provider !== undefined
                  ? `model → ${entry.provider}/${entry.modelId ?? ''}`
                  : entry.type === 'thinking_level_change'
                    ? `thinking → ${entry.thinkingLevel ?? ''}`
                    : entry.type}
              </div>
            ),
          )
        )}
      </div>

      {composer.error !== null ? (
        <div className="sessions-error mono">{composer.error}</div>
      ) : null}

      {statsOpen ? (
        <SessionStatsModal
          data={statsData}
          onClose={() => {
            setStatsOpen(false);
          }}
          t={t}
        />
      ) : null}

      <div className="session-composer">
        <Composer
          isAgentRunning={composer.isRunning}
          onSendPrompt={(text) => {
            void composer.sendPrompt(text);
          }}
          onSendSteer={(text) => {
            void composer.sendSteer(text);
          }}
          onAbort={() => {
            void composer.abort();
          }}
        />
      </div>
    </section>
  );
}

interface SessionStatsModalProps {
  data: Record<string, unknown> | null;
  onClose: () => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

function SessionStatsModal({ data, onClose, t }: SessionStatsModalProps): React.JSX.Element {
  const tokens = (data?.['tokens'] as Record<string, unknown> | undefined) ?? null;
  const context = (data?.['contextUsage'] as Record<string, unknown> | undefined) ?? null;
  const cost = data?.['cost'];

  const rows: Array<{ label: string; value: string }> = [];
  if (data !== null) {
    for (const key of ['userMessages', 'assistantMessages', 'toolCalls', 'toolResults', 'totalMessages']) {
      const value = data[key];
      if (typeof value === 'number') {
        rows.push({ label: key, value: String(value) });
      }
    }
    if (tokens !== null) {
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
        const value = tokens[key];
        if (typeof value === 'number') {
          rows.push({ label: `tokens.${key}`, value: String(value) });
        }
      }
    }
    if (typeof cost === 'number') {
      rows.push({ label: 'cost', value: `$${cost.toFixed(4)}` });
    }
    if (context !== null) {
      const percent = context['percent'];
      if (typeof percent === 'number') {
        rows.push({
          label: t('session.stats.context'),
          value: t('session.stats.percent', { percent: String(percent) }),
        });
      }
    }
  }

  return (
    <div className="palette-overlay" role="presentation">
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('session.stats.title')}>
        <div className="palette-head">
          <span className="palette-title">{t('session.stats.title')}</span>
        </div>
        <div className="palette-body">
          {rows.length === 0 ? (
            <p className="palette-hint">
              <LoadingHint>{t('settings.loading')}</LoadingHint>
            </p>
          ) : (
            <div className="stats-modal-rows">
              {rows.map((row) => (
                <div key={row.label} className="stats-modal-row">
                  <span className="stats-modal-label mono">{row.label}</span>
                  <span className="stats-modal-value mono">{row.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="palette-foot mono">
          <span />
          <button
            type="button"
            className="palette-close"
            onClick={() => {
              onClose();
            }}
          >
            {t('palette.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
