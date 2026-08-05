import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionDetail } from '../../shared/types.js';
import { api } from '../api/client.js';
import { useSessionComposer } from '../chat/sessionComposer.js';
import { Composer } from '../components/Composer.js';
import { MessageItem } from '../components/MessageItem.js';
import { useI18n } from '../i18n/I18nProvider.js';
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
  const [showAll, setShowAll] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const result = await api.sessionDetail(id);
      setDetail(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

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
        <p className="sessions-hint">{t('sessions.loading')}</p>
      </section>
    );
  }

  const visible = showAll ? detail.entries : detail.entries.filter((entry) => mainlineIds.has(entry.id));
  const offBranchCount = detail.entries.length - mainlineIds.size;

  return (
    <section className="sessions-page">
      <button type="button" className="sessions-back" onClick={onBack}>
        {t('sessions.back')}
      </button>

      <div className="session-header">
        <div>
          <h2 className="panel-title">{detail.cwd}</h2>
          <p className="session-meta mono">
            {formatDate(detail.startedAt, intlTag)} · {String(detail.entries.length)}{' '}
            {t('sessions.entries')}
            {detail.entries.length > 0
              ? ` · ${formatTokens(detail.totals.total)} ${t('sessions.tokens')}`
              : ''}
            {detail.totalCost > 0 ? ` · ${formatCost(detail.totalCost)}` : ''}
          </p>
        </div>
        {offBranchCount > 0 ? (
          <button
            type="button"
            className="sessions-toggle"
            onClick={() => {
              setShowAll(!showAll);
            }}
          >
            {showAll
              ? t('sessions.mainline')
              : t('sessions.showAll', { count: String(offBranchCount) })}
          </button>
        ) : null}
      </div>

      <div className="session-stream">
        {visible.map((entry) =>
          entry.type === 'message' && entry.message !== undefined ? (
            <div key={entry.id} data-offbranch={!mainlineIds.has(entry.id)}>
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
        )}
      </div>

      {composer.error !== null ? (
        <div className="sessions-error mono">{composer.error}</div>
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
