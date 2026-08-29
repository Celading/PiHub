import { useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.js';
import { LoadingHint } from './LoadingHint.js';

/**
 * Unified read-only adapter sessions section — the ONE component every
 * adapter's history list renders through (codex / atomcode / zcode /
 * claude / dsh). Structure and interactions are shared by contract:
 *
 *   - section head: agent logo + `{label} sessions (read-only)` + hint
 *   - rows: cwd/title line + meta line + optional actions (查看 expand)
 *   - 查看 expands an inline detail block (up to `detailLimit` lines)
 *
 * ADAPTER CONTRACT: a new adapter MUST render its sessions view through
 * this component (or replicate its exact structure/interactions if the
 * payload differs) — no bespoke section styling.
 */
export interface AdapterSessionLine {
  /** Row identity (session id / thread id). */
  key: string;
  /** Primary line (cwd or model id). */
  title: string;
  /** Secondary meta line. */
  meta: string;
  /** Left border accent (adapter color). */
  color: string;
  /** Optional extra actions besides 查看 (e.g. codex 录入). */
  actions?: React.ReactNode;
  /** Fetch the detail lines on 查看; null/throw shows an honest note. */
  detail?: () => Promise<Array<{ role: string; text: string }>>;
}

interface AdapterSessionsSectionProps {
  /** Agent icon path under /icons/agents/. */
  icon: string;
  /** Dark-background logo (atomcode); adds a subtle bg for visibility. */
  iconDark?: boolean;
  /** Display label (t('adapter.sessions', { label })). */
  label: string;
  /** Mono hint under the title (storage path etc.). */
  hint: string;
  /** Rows; null = loading, [] = empty. */
  rows: AdapterSessionLine[] | null;
  /** Empty-state text (defaults to sessions.hint.empty). */
  emptyText?: string;
  /** Optional load-error line rendered under the head (codex fetch). */
  error?: string | null;
  /** Max detail lines shown per expand (default 8, like codex/claude). */
  detailLimit?: number;
}

export function AdapterSessionsSection({
  icon,
  label,
  hint,
  rows,
  emptyText,
  detailLimit = 8,
  error,
  iconDark = false,
}: AdapterSessionsSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<Array<{ role: string; text: string }> | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const toggleDetail = async (row: AdapterSessionLine): Promise<void> => {
    if (openKey === row.key) {
      setOpenKey(null);
      setDetail(null);
      setDetailError(null);
      return;
    }
    setOpenKey(row.key);
    setDetail(null);
    setDetailError(null);
    if (row.detail === undefined) {
      setDetail([]);
      return;
    }
    try {
      setDetail(await row.detail());
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="codex-sessions">
      <div className="codex-sessions-head">
        <h2 className="codex-sessions-title mono">
          <img
            src={icon}
            alt=""
            className={iconDark ? 'agent-section-logo agent-section-logo-dark' : 'agent-section-logo'}
          />
          {t('adapter.sessions', { label })}
        </h2>
        <p className="codex-sessions-hint mono">{hint}</p>
      </div>
      {error !== null && error !== undefined ? (
        <div className="sessions-error mono">{error}</div>
      ) : null}
      {rows === null ? (
        <p className="sessions-hint">
          <LoadingHint>{t('sessions.hint.loading')}</LoadingHint>
        </p>
      ) : rows.length === 0 ? (
        <p className="sessions-hint">{emptyText ?? t('sessions.hint.empty')}</p>
      ) : (
        <div className="codex-sessions-list">
          {rows.map((row) => (
            <div key={row.key} className="codex-session-row" style={{ borderLeftColor: row.color }}>
              <div className="codex-session-main">
                <span className="codex-session-cwd mono" title={row.title}>
                  {row.title}
                </span>
                <span className="codex-session-meta mono">{row.meta}</span>
              </div>
              <div className="codex-session-actions">
                {row.actions}
                <button
                  type="button"
                  className="btn-primary codex-session-open"
                  onClick={() => {
                    void toggleDetail(row);
                  }}
                >
                  {t('codex.open')}
                </button>
              </div>
              {openKey === row.key ? (
                <div className="codex-session-detail">
                  {detailError !== null ? (
                    <p className="codex-session-line mono">{detailError}</p>
                  ) : detail === null ? (
                    <p className="codex-session-line mono">{t('sessions.hint.loading')}</p>
                  ) : detail.length === 0 ? (
                    <p className="codex-session-line mono">{t('adapter.detailEmpty')}</p>
                  ) : (
                    detail.slice(0, detailLimit).map((line, index) => (
                      <p key={index} className="codex-session-line mono" data-role={line.role}>
                        {line.role}: {line.text.slice(0, 160)}
                      </p>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
