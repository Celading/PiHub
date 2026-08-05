import { useEffect, useState } from 'react';
import type { SessionStats } from '../../shared/types.js';
import { api } from '../api/client.js';
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
        <h1 className="panel-title">Stats</h1>
        <div className="stats-error mono">{error}</div>
      </section>
    );
  }

  if (stats === null) {
    return (
      <section className="stats-page">
        <h1 className="panel-title">Stats</h1>
        <p className="stats-hint">loading…</p>
      </section>
    );
  }

  return (
    <section className="stats-page">
      <div className="stats-head">
        <h1 className="panel-title">Stats</h1>
        <p className="stats-head-hint mono">~/.pi/agent/sessions</p>
      </div>

      <div className="kpi-grid">
        <KpiCard label="sessions" value={String(stats.totalSessions)} />
        <KpiCard label="messages" value={String(stats.totalUserMessages + stats.totalAssistantMessages)} sub={`${String(stats.totalUserMessages)} user · ${String(stats.totalAssistantMessages)} assistant`} />
        <KpiCard label="tool calls" value={String(stats.totalToolCalls)} />
        <KpiCard label="total cost" value={formatCost(stats.totalCost)} sub={`${formatTokens(stats.totals.total)} tokens`} />
      </div>

      <section className="stats-section">
        <h2 className="stats-section-title mono">by model</h2>
        <DataTable
          headers={['model', 'provider', 'sessions', 'messages', 'tokens', 'cost']}
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
        <h2 className="stats-section-title mono">by provider</h2>
        <DataTable
          headers={['provider', 'sessions', 'messages', 'tokens', 'cost']}
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
        <h2 className="stats-section-title mono">by directory</h2>
        <DataTable
          headers={['directory', 'sessions', 'messages', 'cost']}
          rows={stats.byDirectory.map((row) => ({
            cells: [row.cwd, String(row.sessions), String(row.messages), formatCost(row.cost)],
          }))}
        />
      </section>
    </section>
  );
}
