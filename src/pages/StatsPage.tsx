import { useEffect, useState } from 'react';
import type { SessionStats } from '../../shared/types.js';
import { api } from '../api/client.js';
import { useI18n } from '../i18n/I18nProvider.js';
import './StatsPage.css';

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function formatTokens(total: number): string {
  if (total >= 1_000_000_000) {
    return `${(total / 1_000_000_000).toFixed(2)}B`;
  }
  if (total >= 1_000_000) {
    return `${(total / 1_000_000).toFixed(2)}M`;
  }
  if (total >= 1_000) {
    return `${(total / 1_000).toFixed(1)}k`;
  }
  return String(total);
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }): React.JSX.Element {
  return (
    <div className="kpi-card">
      <div className="kpi-label mono">{label}</div>
      <div className="kpi-value mono">{value}</div>
      {sub !== undefined ? <div className="kpi-sub mono">{sub}</div> : null}
    </div>
  );
}

interface TableRow {
  cells: string[];
}

function DataTable({ headers, rows }: { headers: string[]; rows: TableRow[] }): React.JSX.Element {
  return (
    <div className="datatable-wrap">
      <table className="datatable">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} className="mono">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.cells.map((cell, cellIndex) => (
                <td key={cellIndex} className={cellIndex === 0 ? 'mono' : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatsPage(): React.JSX.Element {
  const { t } = useI18n();
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const result = await api.stats();
        if (!cancelled) {
          setStats(result);
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

  if (error !== null) {
    return (
      <section className="stats-page">
        <h1 className="panel-title">{t('stats.title')}</h1>
        <div className="stats-error mono">{error}</div>
      </section>
    );
  }

  if (stats === null) {
    return (
      <section className="stats-page">
        <h1 className="panel-title">{t('stats.title')}</h1>
        <p className="stats-hint">{t('sessions.hint.loading')}</p>
      </section>
    );
  }

  return (
    <section className="stats-page">
      <div className="stats-head">
        <h1 className="panel-title">{t('stats.title')}</h1>
        <p className="stats-head-hint mono">~/.pi/agent/sessions</p>
      </div>

      <div className="kpi-grid">
        <KpiCard label={t('stats.sessions')} value={String(stats.totalSessions)} />
        <KpiCard
          label={t('stats.messages')}
          value={String(stats.totalUserMessages + stats.totalAssistantMessages)}
          sub={`${String(stats.totalUserMessages)} ${t('stats.user')} · ${String(stats.totalAssistantMessages)} ${t('stats.assistant')}`}
        />
        <KpiCard label={t('stats.toolCalls')} value={String(stats.totalToolCalls)} />
        <KpiCard
          label={t('stats.totalCost')}
          value={formatCost(stats.totalCost)}
          sub={`${formatTokens(stats.totals.total)} ${t('sessions.tokens')}`}
        />
      </div>

      <section className="stats-section">
        <h2 className="stats-section-title mono">{t('stats.byModel')}</h2>
        <DataTable
          headers={['model', 'provider', t('stats.sessions'), t('stats.messages'), t('sessions.tokens'), 'cost']}
          rows={stats.byModel.map((row) => ({
            cells: [
              row.model,
              row.provider,
              String(row.sessions),
              String(row.messages),
              formatTokens(row.tokens.total),
              formatCost(row.cost),
            ],
          }))}
        />
      </section>

      <section className="stats-section">
        <h2 className="stats-section-title mono">{t('stats.byProvider')}</h2>
        <DataTable
          headers={['provider', t('stats.sessions'), t('stats.messages'), t('sessions.tokens'), 'cost']}
          rows={stats.byProvider.map((row) => ({
            cells: [
              row.provider,
              String(row.sessions),
              String(row.messages),
              formatTokens(row.tokens.total),
              formatCost(row.cost),
            ],
          }))}
        />
      </section>

      <section className="stats-section">
        <h2 className="stats-section-title mono">{t('stats.byDirectory')}</h2>
        <DataTable
          headers={['directory', t('stats.sessions'), t('stats.messages'), 'cost']}
          rows={stats.byDirectory.map((row) => ({
            cells: [row.cwd, String(row.sessions), String(row.messages), formatCost(row.cost)],
          }))}
        />
      </section>
    </section>
  );
}
